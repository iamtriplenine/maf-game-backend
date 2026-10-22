# INSTRUCTIONS POUR L'IA (a lire en premier, a respecter a chaque reponse)

Ce fichier est dans le projet pour que l'utilisateur n'ait plus a expliquer sa
methode de travail. Une copie identique existe dans `maf-game/` et `maf-backend/`.
Si tu modifies ce fichier, livre-le dans les DEUX projets.

## 1. Le projet

- `maf-game` : application front (React 19 + Vite + three.js / react-three-fiber).
- `maf-backend` : serveur Node/Express heberge sur Render, base PostgreSQL Render.
  Chaque `git push` sur `main` redeploie le backend automatiquement.
- L'utilisateur travaille sous Windows, avec PowerShell. Il n'est pas oblige de
  savoir coder : il doit pouvoir tout faire en un clic.
- Chemins par defaut (a adapter si l'utilisateur en donne d'autres) :
  - Front : `C:\Users\hp\Documents\999\maf-game`
  - Back  : `C:\Users\hp\Documents\999\maf-game-backend-1`
- Langue : reponds toujours en francais, de facon courte et claire.

## 2. Regle d'or : comment livrer les modifications

Tu ne renvoies JAMAIS les fichiers du projet en entier dans le chat, et tu ne
demandes JAMAIS a l'utilisateur de copier-coller du code a la main dans un fichier.

Pour chaque modification tu livres exactement DEUX choses :

1. **Un fichier ZIP** (lien de telechargement) qui contient uniquement les
   fichiers modifies ou nouveaux (pas tout le projet) + les scripts d'installation.
2. **Un bloc PowerShell** a coller tel quel, qui fait tout en un clic :
   extraire le zip, appliquer les changements, puis publier.

Pas de longue explication avant : le zip, le bloc, puis 2-3 lignes sur ce qui change.
Ne demande pas de confirmation, avance directement pour ne pas faire perdre de temps.

## 3. Structure du zip

Le zip a UN dossier racine portant le meme nom que le zip (sans `.zip`) :

```
maf-<nom>-update.zip
 \- maf-<nom>-update\
     |- Appliquer.ps1          (copie les fichiers, installe si besoin)
     |- Publier.ps1            (build de controle + git commit/push)
     |- message.txt            (message de commit, une ligne)
     \- fichiers\
         |- frontend\          (meme arborescence que maf-game, fichiers modifies seulement)
         |- backend\           (meme arborescence que maf-backend, seulement si concerne)
         \- a-supprimer.txt    (optionnel : une ligne par fichier a supprimer,
                                ex. `frontend/src/vieux.jsx`)
```

- `<nom>` : court, en minuscules, avec des tirets (ex. `circle`, `profil-menu`).
- Un fichier modifie est fourni COMPLET dans le zip (il remplace l'ancien),
  mais n'est pas recopie dans le chat.
- Les scripts `Appliquer.ps1` et `Publier.ps1` generiques sont dans
  `maf-game/_ia/`. Reprends-les tels quels dans chaque zip. Si tu ne les as pas,
  reecris-les en suivant la section 5.
- Ne cree pas de fichiers `.bak` dans le projet : `Appliquer.ps1` fait deja les
  sauvegardes (dossier `.maf-sauvegardes`, ignore par git).

## 4. Modele du bloc PowerShell (remplace `<nom>`)

````powershell
$zip = Join-Path $env:USERPROFILE "Downloads\maf-<nom>-update.zip"
$dossier = Join-Path $env:TEMP "maf-<nom>-update"
$front = "C:\Users\hp\Documents\999\maf-game"
$back  = "C:\Users\hp\Documents\999\maf-game-backend-1"

if (Test-Path $dossier) { Remove-Item $dossier -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $dossier -Force

powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$dossier\maf-<nom>-update\Appliquer.ps1" `
  -Frontend $front -Backend $back

if ($LASTEXITCODE -ne 0) {
  throw "Installation interrompue. Publication annulee."
}

powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$dossier\maf-<nom>-update\Publier.ps1" `
  -Frontend $front -Backend $back

if ($LASTEXITCODE -ne 0) {
  throw "Publication interrompue : consulte le message affiche."
}
````

Avant le bloc, dis simplement : « Enregistre le zip dans Telechargements, puis
colle ce bloc dans PowerShell. » (Si le zip ne touche qu'un des deux projets,
le bloc reste le meme : les scripts ignorent ce qui n'est pas dans le zip.)

## 5. Comportement attendu des scripts

**Appliquer.ps1** (parametres `-Frontend`, `-Backend` optionnel)
- Verifie que les dossiers existent et contiennent `package.json`. Sinon : message
  rouge clair + `exit 1`.
- Copie chaque fichier de `fichiers\frontend` vers le front et de `fichiers\backend`
  vers le back, en creant les dossiers manquants.
- Avant d'ecraser un fichier different, le sauvegarde dans
  `<projet>\.maf-sauvegardes\<date-heure>\` et ajoute ce dossier au `.gitignore`.
- Traite `a-supprimer.txt` en deplacant les fichiers vers la sauvegarde.
- Lance `npm install` si `package.json` a change.
- Affiche ce qui a ete fait (`+` nouveau, `~` modifie, `=` identique, `-` supprime).
- En cas d'erreur : `exit 1` (le bloc PowerShell s'arrete alors, rien n'est publie).

**Publier.ps1** (memes parametres)
- Pour le front modifie : `npm run build` de controle. Si ca echoue, on ne publie pas.
- Pour chaque projet qui est un depot git et qui a des changements :
  `git add -A`, `git commit -m "<message.txt>"`, `git push`.
- Si un projet n'est pas un depot git, ou n'a rien a publier : le dire et continuer.
- `exit 1` a la moindre erreur git/build.

Compatibilite : l'utilisateur a Windows PowerShell 5.1. Pas de syntaxe PowerShell 7
(`&&`, `??`, etc.). Fichiers `.ps1` en UTF-8 avec BOM, textes sans accents.

## 6. Avant de livrer, verifie

- Les chemins dans le zip correspondent exactement a l'arborescence du projet.
- Le code modifie compile (`npm run build` cote front) et ne casse pas l'existant.
- Tu n'as inclus que ce qui change (pas `node_modules`, `dist`, `.env`, sauvegardes).
- Ne mets jamais de secrets (mots de passe, cles) dans le zip ni dans le chat.
- Si une modification demande une variable d'environnement ou une action sur
  Render, dis-le clairement apres le bloc, en une ligne.
