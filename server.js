'use strict';
// Murmure — serveur multijoueur temps réel (Node.js + ws)
// Lobbies publics/privés, chef de lobby, exclusions, reconnexion, relais du jeu.
// Toutes les permissions sont vérifiées ici, jamais côté navigateur.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://f5fungames.com,https://www.f5fungames.com,http://f5fungames.com,http://www.f5fungames.com,null,http://localhost,http://127.0.0.1')
  .split(',').map(s => s.trim()).filter(Boolean);
const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
const GRACE_MS = +process.env.GRACE_MS || 20000;        // reconnexion possible pendant ce délai
const CHIEF_GRACE_MS = +process.env.CHIEF_GRACE_MS || 6000; // le chef garde son rôle pendant ce délai
const IDLE_MS = 3 * 3600 * 1000;                          // lobby inactif fermé
const MAX_MSG = 16384;
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rid = n => { let s = ''; for (let i = 0; i < n; i++) s += B32[crypto.randomInt(32)]; return s; };

const lobbies = new Map(); // id -> lobby
const players = new Map(); // tok -> player
const byId = new Map();    // id -> player
let pidSeq = 1;

function cleanName(v, max, def) {
  const s = String(v == null ? '' : v).replace(/[^\p{L}\p{N} _\-'.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || def;
}
function send(p, o) { if (p && p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(o)); } catch (e) {} } }
function members(L) { return L.members.map(id => byId.get(id)).filter(Boolean); }
function toMembers(L, o, exceptId) { for (const p of members(L)) if (p.id !== exceptId) send(p, o); }

function listView(L) {
  const c = byId.get(L.chief);
  return { id: L.id, name: L.name, chief: c ? c.name : '?', n: L.members.length, max: L.max, status: L.status, pub: L.pub };
}
function roomView(L) {
  return {
    id: L.id, name: L.name, chief: L.chief, max: L.max, pub: L.pub, status: L.status, code: L.code, night: L.night,
    players: members(L).map(p => ({ id: p.id, name: p.name, on: !!p.connected }))
  };
}
function pushRoom(L) { const v = roomView(L); for (const p of members(L)) send(p, { t: 'room', room: v }); }

// ---- liste des lobbies (abonnés) ----
let listTimer = null;
function listChanged() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const list = [...lobbies.values()].filter(L => L.status !== 'closed').map(listView);
    for (const p of players.values()) if (p.sub) send(p, { t: 'lobbies', list });
  }, 150);
}
function sendList(p) { send(p, { t: 'lobbies', list: [...lobbies.values()].map(listView) }); }

// ---- lobbies ----
function createLobby(p, m) {
  if (p.lobby) leaveLobby(p, 'left');
  const L = {
    id: rid(12), name: cleanName(m.name, 24, 'Partie de ' + p.name), chief: p.id, members: [p.id],
    max: Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, m.max | 0 || MAX_PLAYERS)), pub: m.pub !== false,
    code: rid(6), status: 'waiting', banned: new Set(), bannedIp: new Set(), created: Date.now(), active: Date.now(), night: 1
  };
  lobbies.set(L.id, L); p.lobby = L.id;
  send(p, { t: 'joined', room: roomView(L) }); listChanged();
}
function findByCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 6) return null;
  for (const L of lobbies.values()) if (L.code === c) return L;
  return null;
}
function joinLobby(p, m) {
  let L = null;
  if (m.code != null) {
    const now = Date.now(); p.codeFails = p.codeFails.filter(t => now - t < 60000);
    if (p.codeFails.length >= 8) return send(p, { t: 'err', e: 'slow' });
    L = findByCode(m.code);
    if (!L) { p.codeFails.push(now); return send(p, { t: 'err', e: 'badcode' }); }
  } else {
    L = lobbies.get(String(m.id || ''));
    if (!L) return send(p, { t: 'err', e: 'notfound' });
    if (!L.pub) return send(p, { t: 'err', e: 'private' }); // un lobby privé ne se rejoint qu'avec son code
  }
  if (L.members.includes(p.id)) return send(p, { t: 'joined', room: roomView(L) });
  if (L.banned.has(p.tok) || (p.ip && L.bannedIp.has(p.ip) && process.env.IP_BAN !== '0')) return send(p, { t: 'err', e: 'kicked' });
  if (L.members.length >= L.max) return send(p, { t: 'err', e: 'full' });
  if (p.lobby) leaveLobby(p, 'left');
  L.members.push(p.id); p.lobby = L.id; L.active = Date.now();
  send(p, { t: 'joined', room: roomView(L) });
  pushRoom(L); listChanged();
  if (L.status === 'playing') send(byId.get(L.chief), { t: 'needsync', id: p.id });
}
function transferChief(L) {
  const next = members(L).find(q => q.id !== L.chief && q.connected) || members(L).find(q => q.id !== L.chief);
  if (!next) return false;
  L.chief = next.id; toMembers(L, { t: 'info', e: 'newchief', id: next.id }); return true;
}
function leaveLobby(p, reason) {
  const L = lobbies.get(p.lobby); p.lobby = null;
  if (!L) return;
  L.members = L.members.filter(id => id !== p.id);
  if (!L.members.length) { lobbies.delete(L.id); listChanged(); return; }
  if (L.chief === p.id) transferChief(L);
  toMembers(L, { t: 'info', e: reason === 'kicked' ? 'kickedother' : 'left', id: p.id, name: p.name });
  pushRoom(L); listChanged();
}
function closeLobby(L) {
  for (const p of members(L)) { p.lobby = null; send(p, { t: 'closed' }); }
  lobbies.delete(L.id); listChanged();
}

// ---- messages ----
const CHIEF_ONLY = new Set(['kick', 'close', 'setpub', 'newcode', 'start', 'end', 'w', 'ev', 'sync', 'rename']);
function handle(p, m) {
  const L = p.lobby ? lobbies.get(p.lobby) : null;
  if (L) L.active = Date.now();
  if (CHIEF_ONLY.has(m.t) && (!L || L.chief !== p.id)) return send(p, { t: 'err', e: 'notchief' });
  switch (m.t) {
    case 'ping': return send(p, { t: 'pong', c: m.c });
    case 'name': p.name = cleanName(m.name, 16, p.name); if (L) { pushRoom(L); listChanged(); } return;
    case 'sub': p.sub = true; return sendList(p);
    case 'unsub': p.sub = false; return;
    case 'create': return createLobby(p, m);
    case 'join': return joinLobby(p, m);
    case 'leave': return leaveLobby(p, 'left');
    case 'kick': {
      const q = byId.get(String(m.id || ''));
      if (!q || q.id === p.id || !L.members.includes(q.id)) return send(p, { t: 'err', e: 'notfound' });
      L.banned.add(q.tok); if (q.ip) L.bannedIp.add(q.ip); leaveLobby(q, 'kicked'); send(q, { t: 'kicked' }); return;
    }
    case 'close': return closeLobby(L);
    case 'setpub': L.pub = !!m.pub; pushRoom(L); listChanged(); return;
    case 'newcode': L.code = rid(6); pushRoom(L); return;
    case 'rename': L.name = cleanName(m.name, 24, L.name); pushRoom(L); listChanged(); return;
    case 'start': {
      const s = m.setup; if (!s || typeof s !== 'object') return send(p, { t: 'err', e: 'bad' });
      L.status = 'playing'; L.night = Math.max(1, Math.min(99, s.night | 0 || 1));
      for (const q of members(L)) send(q, { t: 'start', setup: s, host: L.chief });
      pushRoom(L); listChanged(); return;
    }
    case 'end': L.status = 'finished'; L.night = Math.max(1, Math.min(99, m.night | 0 || L.night)); pushRoom(L); listChanged(); return;
    case 'st': // état d'un joueur → les autres membres
      if (!L || L.status !== 'playing' || !m.s || typeof m.s !== 'object') return;
      return toMembers(L, { t: 'st', id: p.id, s: m.s }, p.id);
    case 'w': if (L.status === 'playing' && m.s && typeof m.s === 'object') toMembers(L, { t: 'w', s: m.s }, p.id); return;
    case 'ev': {
      if (!m.e || typeof m.e !== 'object') return;
      if (m.to) { const q = byId.get(String(m.to)); if (q && L.members.includes(q.id)) send(q, { t: 'ev', e: m.e }); }
      else toMembers(L, { t: 'ev', e: m.e }, p.id);
      return;
    }
    case 'act': // action d'un membre → le chef décide
      if (!L || L.status !== 'playing' || L.chief === p.id || !m.a || typeof m.a !== 'object') return;
      return send(byId.get(L.chief), { t: 'act', from: p.id, a: m.a });
    case 'sync': { const q = byId.get(String(m.to || '')); if (q && L.members.includes(q.id) && m.data) send(q, { t: 'sync', data: m.data, host: L.chief }); return; }
    default: return;
  }
}

// ---- connexions ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, lobbies: lobbies.size, players: [...players.values()].filter(p => p.connected).length }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Murmure multijoueur');
});
const wss = new WebSocketServer({
  server, maxPayload: MAX_MSG,
  verifyClient: info => {
    const o = info.origin || info.req.headers.origin || 'null';
    return ORIGINS.some(a => o === a || (a.startsWith('http://localhost') && o.startsWith('http://localhost')) || (a.startsWith('http://127.0.0.1') && o.startsWith('http://127.0.0.1')));
  }
});

function onDisconnect(p, ws) {
  if (p.ws !== ws) return; // déjà remplacé par une nouvelle connexion
  p.ws = null; p.connected = false;
  const L = p.lobby ? lobbies.get(p.lobby) : null;
  if (L) { pushRoom(L); listChanged(); }
  clearTimeout(p.chiefTimer); clearTimeout(p.dcTimer);
  if (L && L.chief === p.id) p.chiefTimer = setTimeout(() => { const L2 = lobbies.get(p.lobby); if (!p.connected && L2 && L2.chief === p.id && transferChief(L2)) pushRoom(L2); }, CHIEF_GRACE_MS);
  p.dcTimer = setTimeout(() => {
    if (p.connected) return;
    if (p.lobby) leaveLobby(p, 'left');
    players.delete(p.tok); byId.delete(p.id);
  }, GRACE_MS);
}

wss.on('connection', (ws, req) => {
  let p = null; ws.isAlive = true;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1] : String(req.socket.remoteAddress || '');
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > MAX_MSG) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { if (p) p.bad++; return; }
    if (!m || typeof m.t !== 'string') return;
    if (!p) {
      if (m.t !== 'hello' || !/^[a-f0-9]{32}$/.test(String(m.tok || ''))) return ws.close(1008, 'hello');
      p = players.get(m.tok);
      if (p) {
        if (p.ws && p.ws !== ws) { send(p, { t: 'replaced' }); try { p.ws.close(4001, 'replaced'); } catch (e) {} }
        clearTimeout(p.dcTimer); clearTimeout(p.chiefTimer);
      } else {
        p = { tok: m.tok, id: 'p' + (pidSeq++).toString(36) + rid(4), name: 'Joueur', lobby: null, sub: false, bucket: 120, last: Date.now(), bad: 0, codeFails: [] };
        players.set(p.tok, p); byId.set(p.id, p);
      }
      p.ws = ws; p.ip = ip; p.connected = true; p.name = cleanName(m.name, 16, p.name);
      const L = p.lobby ? lobbies.get(p.lobby) : null;
      send(p, { t: 'welcome', id: p.id, name: p.name, room: L ? roomView(L) : null });
      if (L) { pushRoom(L); listChanged(); if (L.status === 'playing' && L.chief !== p.id) send(byId.get(L.chief), { t: 'needsync', id: p.id }); }
      return;
    }
    if (p.ws !== ws) return; // ancienne connexion remplacée : ignorée
    // limite de fréquence (seau à jetons)
    const now = Date.now(); p.bucket = Math.min(120, p.bucket + (now - p.last) * 0.06); p.last = now;
    if (p.bucket < 1) { if (++p.bad > 400) ws.close(1008, 'flood'); return; }
    p.bucket -= 1;
    try { handle(p, m); } catch (e) { p.bad++; }
  });
  ws.on('close', () => { if (p) onDisconnect(p, ws); });
  ws.on('error', () => {});
});

// battement de cœur + nettoyage
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();
  for (const L of [...lobbies.values()]) {
    if (!L.members.length || now - L.active > IDLE_MS) closeLobby(L);
  }
}, 15000);

server.listen(PORT, () => console.log('Murmure multijoueur sur le port ' + PORT));
module.exports = { server, lobbies, players };
