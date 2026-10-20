// Tests du serveur : plusieurs clients réels en WebSocket
process.env.PORT = 8191; process.env.GRACE_MS = 1500; process.env.CHIEF_GRACE_MS = 600;
require('./server.js');
const WebSocket = require('ws'), crypto = require('crypto');
const URL = 'ws://127.0.0.1:8191';
let ok = 0, ko = 0; const res = [];
function check(name, cond) { (cond ? ok++ : ko++); res.push((cond ? '✔ ' : '✘ ') + name); }
const wait = ms => new Promise(r => setTimeout(r, ms));
function client(name, ip, tok) {
  return new Promise(r => {
    const c = { tok: tok || crypto.randomBytes(16).toString('hex'), msgs: [], name };
    c.ws = new WebSocket(URL, { origin: 'https://f5fungames.com', headers: { 'x-forwarded-for': ip || '10.0.0.' + Math.floor(Math.random() * 250) } });
    c.ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'welcome') { c.id = m.id; r(c); } if (m.t === 'room' || m.t === 'joined') c.room = m.room; if (m.t === 'lobbies') c.list = m.list; });
    c.ws.on('open', () => c.send({ t: 'hello', tok: c.tok, name }));
    c.send = o => c.ws.send(JSON.stringify(o));
    c.last = t => [...c.msgs].reverse().find(m => m.t === t);
    c.clear = () => { c.msgs = []; };
  });
}
(async () => {
  // origine refusée
  const bad = new WebSocket(URL, { origin: 'https://evil.example' });
  const refused = await new Promise(r => { bad.on('error', () => r(true)); bad.on('open', () => r(false)); });
  check('origine inconnue refusée', refused);

  const A = await client('Alice'), B = await client('Bob'), C = await client('Chloé'), D = await client('Dan');
  B.send({ t: 'sub' }); await wait(100);
  A.send({ t: 'create', name: 'Maison A', pub: true, max: 3 }); await wait(300);
  check('lobby créé, créateur = chef', A.room && A.room.chief === A.id && A.room.players.length === 1);
  check('liste mise à jour en temps réel chez les abonnés', B.list && B.list.some(l => l.name === 'Maison A' && l.n === 1 && l.max === 3));
  const Aid = A.room.id;
  C.send({ t: 'create', name: 'Secret', pub: false, max: 4 }); await wait(300);
  const code = C.room.code, Cid = C.room.id;
  check('deuxième lobby (privé) créé', C.room && !C.room.pub && /^[A-Z2-9]{6}$/.test(code));

  B.send({ t: 'join', id: Aid }); await wait(250);
  check('rejoindre un lobby public', B.room && B.room.id === Aid && A.room.players.length === 2);
  D.send({ t: 'join', id: Cid }); await wait(200);
  check('lobby privé refusé par identifiant', D.last('err') && D.last('err').e === 'private');
  D.clear(); D.send({ t: 'join', code: 'ZZZZZZ' }); await wait(200);
  check('mauvais code refusé', D.last('err') && D.last('err').e === 'badcode');
  D.clear(); D.send({ t: 'join', code: code.toLowerCase() }); await wait(250);
  check('lobby privé rejoint avec le code', D.room && D.room.id === Cid);

  // lobby complet (max 3)
  const E = await client('Eve'), F = await client('Fred');
  E.send({ t: 'join', id: Aid }); await wait(200);
  F.send({ t: 'join', id: Aid }); await wait(200);
  check('lobby complet refusé', F.last('err') && F.last('err').e === 'full');

  // permissions du chef
  B.clear(); B.send({ t: 'kick', id: E.id }); await wait(200);
  check('un non-chef ne peut pas exclure', B.last('err') && B.last('err').e === 'notchief' && A.room.players.some(p => p.id === E.id));
  B.send({ t: 'start', setup: { night: 1 } }); B.send({ t: 'close' }); B.send({ t: 'setpub', pub: false }); await wait(200);
  check('un non-chef ne peut ni démarrer, ni fermer, ni passer en privé', A.room.status === 'waiting' && A.room.pub && lobbiesHas(Aid));

  // démarrage + synchronisation
  A.clear(); B.clear(); E.clear();
  A.send({ t: 'start', setup: { night: 2, keys: [[1, 2, 3]] } }); await wait(250);
  check('le chef démarre : tous reçoivent la mise en place', B.last('start') && E.last('start') && B.last('start').setup.night === 2 && B.last('start').host === A.id);
  B.send({ t: 'st', s: { x: 5, z: 6 } }); await wait(150);
  check('position d\'un joueur relayée aux autres', A.last('st') && A.last('st').id === B.id && A.last('st').s.x === 5 && E.last('st'));
  A.send({ t: 'w', s: { c: [1, 2, 3] } }); await wait(150);
  check('état du monde du chef relayé', B.last('w') && E.last('w'));
  B.clear(); B.send({ t: 'w', s: { c: [9, 9, 9] } }); await wait(150);
  check('un non-chef ne peut pas imposer l\'état du monde', B.last('err') && B.last('err').e === 'notchief' && !(A.last('w') && A.last('w').s.c[0] === 9));
  B.send({ t: 'act', a: { k: 'key', i: 0 } }); await wait(150);
  check('action d\'un joueur transmise au chef seulement', A.last('act') && A.last('act').from === B.id && !E.msgs.some(m => m.t === 'act'));

  // exclusion
  E.clear(); A.send({ t: 'kick', id: E.id }); await wait(250);
  check('exclusion par le chef', E.last('kicked') && !A.room.players.some(p => p.id === E.id));
  A.clear(); E.send({ t: 'st', s: { x: 99 } }); E.send({ t: 'act', a: { k: 'key' } }); await wait(200);
  check('un exclu ne peut plus agir', !A.msgs.some(m => (m.t === 'st' || m.t === 'act') && (m.id === E.id || m.from === E.id)));
  E.clear(); E.send({ t: 'join', id: Aid }); await wait(200);
  check('un exclu ne peut pas revenir', E.last('err') && E.last('err').e === 'kicked');
  const E2 = await client('Eve2', null, E.tok); E2.send({ t: 'join', id: Aid }); await wait(200);
  check('même avec une nouvelle connexion (même session)', E2.last('err') && E2.last('err').e === 'kicked');
  check('l\'ancienne connexion est remplacée', E.msgs.some(m => m.t === 'replaced'));

  // rejoindre en cours de partie → le chef doit resynchroniser
  A.clear(); F.send({ t: 'join', id: Aid }); await wait(250);
  check('arrivée en cours de partie : le chef est prévenu', A.last('needsync') && A.last('needsync').id === F.id);
  A.send({ t: 'sync', to: F.id, data: { hello: 1 } }); await wait(150);
  check('le chef envoie l\'état au nouveau', F.last('sync') && F.last('sync').data.hello === 1);

  // déconnexion du chef → transfert
  A.ws.close(); await wait(1200);
  check('le chef part : le rôle passe à un autre joueur', B.room && B.room.chief !== A.id && B.room.players.some(p => p.id === B.room.chief));
  // reconnexion dans le délai
  const nb = B.room.chief === B.id ? F : B; const ntok = nb.tok; nb.ws.close(); await wait(300);
  const nb2 = await client(nb.name, null, ntok); await wait(200);
  check('reconnexion : retour dans le même lobby', nb2.msgs.find(m => m.t === 'welcome').room && nb2.msgs.find(m => m.t === 'welcome').room.id === Aid);

  // fermeture par le chef
  const chief = [B, F, nb2].find(x => x.room && x.room.chief === x.id && x.ws.readyState === 1) || [B, F, nb2].find(x => x.id === B.room.chief);
  const others = [B, F, nb2].filter(x => x !== chief && x.ws.readyState === 1);
  chief.send({ t: 'close' }); await wait(300);
  check('fermeture du lobby par le chef', others.every(o => o.last('closed')) && !lobbiesHas(Aid));

  // lobby abandonné nettoyé
  C.ws.close(); D.ws.close(); await wait(2200);
  check('lobby abandonné supprimé après le délai', !lobbiesHas(Cid));
  await wait(400);
  check('liste des abonnés sans lobby fantôme', B.list && !B.list.some(l => l.id === Cid || l.id === Aid));

  // données mal formées + inondation
  const G = await client('Gus');
  G.ws.send('{pas du json'); G.ws.send(JSON.stringify({ t: 'join' })); G.ws.send(JSON.stringify({ t: 'create', name: '<script>x</script>'.repeat(5), max: 99 }));
  await wait(250);
  check('données mal formées ignorées, noms nettoyés, capacité bornée', G.room && !/[<>]/.test(G.room.name) && G.room.max === 4);
  let closed = false; G.ws.on('close', () => closed = true);
  for (let i = 0; i < 2000; i++) G.ws.send(JSON.stringify({ t: 'ping', c: i }));
  await wait(600);
  const pongs = G.msgs.filter(m => m.t === 'pong').length;
  check('limite de fréquence appliquée (' + pongs + ' réponses sur 2000)', pongs < 400);
  // brute force de code
  const H = await client('Hacker');
  for (let i = 0; i < 12; i++) H.send({ t: 'join', code: 'AAAA' + String(i).padStart(2, 'A') });
  await wait(300);
  check('essais de codes limités', H.msgs.some(m => m.t === 'err' && m.e === 'slow'));

  console.log(res.join('\n')); console.log(`\n${ok} réussis, ${ko} échoués`); process.exit(ko ? 1 : 0);
})();
function lobbiesHas(id) { return require('./server.js').lobbies.has(id); }
