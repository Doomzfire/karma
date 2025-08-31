
Doomz Karma Service — Cloud Ready

Objectif: rendre la page karma visible en temps réel pour tout le monde même si ton PC est éteint.

Deux modes:
- LOCAL: fichiers JSON (karma.json/pending.json/tokens.json)
- CLOUD: PostgreSQL (via DATABASE_URL) pour persister.

Déploiement (Render):
1) Mets ces fichiers sur GitHub.
2) Render -> New -> Blueprint -> choisis ce repo.
3) Renseigne les env vars: CLIENT_ID, CLIENT_SECRET, BROADCASTER_LOGIN=doomzfire, DATABASE_URL (optionnel), PUBLIC_URL (URL Render).
4) Une fois déployé, mets PUBLIC_URL/auth/callback dans tes Redirect URLs sur dev.twitch.tv.
5) Ouvre PUBLIC_URL/auth/login et Authorize.
6) Ta page web se connecte à PUBLIC_URL (Socket.IO + REST).

