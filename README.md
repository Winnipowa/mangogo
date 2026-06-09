# ChatLibre V1

Chat anonyme, sans inscription, 7 salons.

## Fichiers

```
server.js           ← tout le backend (Express + Socket.io + SQLite)
public/index.html   ← tout le frontend (HTML pur)
public/admin.html   ← dashboard admin
package.json        ← 3 dépendances seulement
```

## Lancer en local (test)

```bash
npm install
node server.js
# → http://localhost:3000
# → http://localhost:3000/admin
```

## Déployer sur Railway (15 minutes)

1. Crée un compte sur railway.app
2. "New Project" → "Deploy from GitHub repo"
3. Push ces fichiers sur un repo GitHub
4. Railway détecte Node.js automatiquement
5. Ajouter les variables d'environnement :
   - `IP_SALT` = une chaîne aléatoire longue (ex: generée sur random.org)
   - `ADMIN_SECRET` = ton mot de passe admin
6. Deploy → ton URL publique apparaît

## Variables d'environnement

| Variable       | Description                    | Défaut          |
|----------------|--------------------------------|-----------------|
| `PORT`         | Port du serveur                | 3000            |
| `IP_SALT`      | Sel pour hasher les IPs        | chatlibresalt   |
| `ADMIN_SECRET` | Mot de passe du /admin         | changeme123     |

⚠️ Change ADMIN_SECRET avant de déployer

## Admin

Aller sur `/admin` → entrer le mot de passe → voir les signalements → Bannir ou Ignorer

Le ban bloque le fingerprint + IP hashée. L'utilisateur est déconnecté instantanément.
