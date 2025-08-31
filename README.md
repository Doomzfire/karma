# Doomz Karma Service (prod)

Service Node.js pour afficher le **karma** des viewers en temps réel à partir des **récompenses de points de chaîne Twitch**.

## Fonctionnement
- Écoute **EventSub WebSocket** pour `channel_points_custom_reward_redemption` (ADD/UPDATE).
- Ajoute les réclamations en **attente**; applique le karma **uniquement quand tu valides (FULFILLED)** et **annule** si tu rembourses (CANCELED).
- Diffuse les mises à jour via **Socket.IO** (ta page `karma.html` reçoit `karma:update` en temps réel).

## Déploiement (Render)
1. Repo GitHub avec : `index.js`, `package.json`, `storage.js`, `render.yaml` (optionnel), `public/` (optionnel).
2. Variables d’environnement (Settings → Environment) :
   - `CLIENT_ID` : Client ID de ton app Twitch
   - `CLIENT_SECRET` : Client Secret de ton app Twitch
   - `BROADCASTER_LOGIN` : `doomzfire`
   - `PUBLIC_URL` : URL Render (ex: `https://doomz-karma-service.onrender.com`) **après** premier déploiement
   - *(optionnel)* `DATABASE_URL` : Postgres pour persistance serveur (sinon stockage JSON local)
   - *(optionnel)* `ALLOWED_ORIGINS` : ex `https://doomzfire.netlify.app` (CORS strict)
3. Dans **dev.twitch.tv → Applications → OAuth Redirect URLs** :
   - Ajoute **exactement** `https://<ton-service>.onrender.com/auth/callback`
4. Ouvre `https://<ton-service>.onrender.com/auth/login` et clique **Authorize**.

## Endpoints
- `GET /health` → `ok`
- `GET /api/karma` → `{ "Viewer": 3, "Autre": -1 }`
- `GET /api/karma/pending` → réclamations en attente (diagnostic)
- Socket.IO → événement `karma:update` `{ user, value, delta, at, source }`

## Personnalisation des récompenses
Par défaut : `Heal/Eat/Hydrate = +1`, `Bleed/Thirst/Hunger = -1` (émoticônes supportées).  
Tu peux surcharger via `REWARD_MAP_JSON`, ex :
```json
{"hydrate💧":2,"bleed🩸":-2}
```

## Persistance
- **Sans** `DATABASE_URL` : fichiers JSON (peut être éphémère en PaaS).
- **Avec** `DATABASE_URL` : Postgres (recommandé pour garder les points à long terme).

## Sécurité
- Les *secrets* restent dans les variables d’environnement (ne pas commit).
- **OAuth state** activé pour éviter les redirections CSRF.
- CORS configurable avec `ALLOWED_ORIGINS` (sinon `*`).

## Dev local
```
npm install
CLIENT_ID=xxx CLIENT_SECRET=yyy BROADCASTER_LOGIN=doomzfire PUBLIC_URL=http://localhost:3000 npm start
# puis http://localhost:3000/auth/login
```
