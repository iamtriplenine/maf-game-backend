> **IA : lis d'abord `INSTRUCTIONS-IA.md`** (methode de livraison : zip + bloc PowerShell).

# maf-game-backend

Serveur Node/Express heberge sur Render, avec base PostgreSQL Render.

- `npm run dev`    : lance le serveur en local (lit le fichier .env)
- `npm start`      : commande utilisee par Render
- `npm run backup` : exporte la base en JSON dans le dossier backups/

Chaque `git push` sur la branche `main` redeploie automatiquement sur Render.