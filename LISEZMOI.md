# Murmure — serveur multijoueur

Serveur Node.js (WebSocket) : lobbies publics/privés, chef de lobby, exclusions,
reconnexion, relais temps réel de la partie. Aucune base de données : les lobbies
vivent en mémoire et disparaissent quand plus personne n'y est.

## Mise en ligne (une seule fois)
1. Mettre ce dossier sur GitHub (nouveau dépôt, ou dossier dans ton dépôt existant).
2. Sur render.com : New + → Blueprint → choisir le dépôt. Le fichier render.yaml
   crée tout seul le service « murmure-multi » (Francfort, gratuit).
3. Vérifier : https://murmure-multi.onrender.com/health doit répondre {"ok":true,...}

Le jeu se connecte tout seul à wss://murmure-multi.onrender.com.
Si Render donne un autre nom, ajoute ?mp=wss://TON-NOM.onrender.com à l'adresse
du jeu (ou dis-le-moi, je change l'adresse dans le jeu).

## Tests
npm install && npm test   → 31 vérifications avec de vrais clients WebSocket.
