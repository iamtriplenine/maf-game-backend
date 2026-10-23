# INSTRUCTIONS POUR LES IA - MAF GAME (A LIRE AVANT TOUTE MODIFICATION)

Ce document definit la methode de travail exigee par le proprietaire de MAF GAME.
Il doit rester IDENTIQUE dans les deux depots, a la racine, sous le nom
`INSTRUCTIONS-IA.md`. Le fichier `AGENTS.md` pointe egalement vers ces regles.
Si une IA change ces instructions, elle met a jour les deux copies.

## 1. Depots GitHub et environnement

Depots de reference (verifier que les liens sont accessibles et actuels) :

- Frontend (React 19, Vite) : https://github.com/iamtriplenine/maf-game
- Backend (Node.js / Express, PostgreSQL) : https://github.com/iamtriplenine/maf-game-backend

Le backend est deployee sur Render. Ne jamais supposer qu'un push ou un
redeploiement a reussi sans le verifier. Ces URL servent a LIRE la version
courante ; un depot public ne donne pas automatiquement le droit d'y ecrire.

Utilisateur : Windows / Windows PowerShell 5.1 ; repondre en francais, simplement.
Dossiers habituels (a adapter si l'utilisateur donne d'autres chemins) :

- Frontend : `C:\Users\hp\Documents\999\maf-game`
- Backend  : `C:\Users\hp\Documents\999\maf-game-backend-1`

## 2. Regle obligatoire : consulter la version actuelle

AVANT de creer un correctif :

1. Consulter le depot GitHub fourni par l'utilisateur et la branche concernee ;
   lire les fichiers reellement impliques dans la demande et verifier leur
   version/commit. Consulter les DEUX depots si le front et le back interagissent.
2. Ne pas se baser uniquement sur un ancien ZIP, une conversation precedente ou
   une copie locale. Comparer les fichiers si des versions differentes existent.
3. Si l'acces GitHub est indisponible, le dire explicitement : ne pas pretendre
   avoir verifie les derniers commits. Demander une source a jour si necessaire,
   ou livrer un correctif avec verifications qui REFUSE les fichiers incompatibles.
4. Identifier les autres fonctions partageant les fichiers touches. Ne modifier
   QUE ce qui a ete demande. Preserver tout travail en cours d'une autre IA.
5. Ne pas modifier le comportement des jeux, salons, solde, transactions,
   notifications, administration ou securite si la demande ne les concerne pas.

## 3. Livrable obligatoire : ZIP + commande PowerShell

Pour chaque modification de code, livrer dans la meme reponse :

1. Un lien de telechargement vers un **vrai fichier ZIP cree et verifie**, avec
   seulement le correctif necessaire et les scripts d'installation.
2. Un **unique bloc PowerShell complet et pret a coller** depuis Windows, qui
   extrait le ZIP depuis `Telechargements`, applique, verifie et publie. Ne pas
   exiger que l'utilisateur ouvre l'editeur de code, copie plusieurs fichiers ou
   invente des chemins. Le code doit arreter la publication en cas d'erreur.
3. Une courte explication de ce qui change, de ce qui reste inchange et des
   verifications effectivement effectuees. Ne jamais inventer des tests reussis.

Ne jamais se contenter de dire « voici du code » ou donner un nom de ZIP qui
n'existe pas. Si la creation du ZIP est impossible, le dire clairement et
fournir une alternative honnete. Ne jamais promettre un deploiement non realise.

## 4. Format standard du ZIP

```text
maf-<nom>-update.zip
  maf-<nom>-update/
    Appliquer.ps1
    Publier.ps1
    message.txt
    fichiers/
      frontend/  (fichiers cibles uniquement)
      backend/   (fichiers cibles uniquement, si necessaire)
```

- Adapter `nom` a la modification ; respecter l'arborescence du depot.
- Ne jamais inclure `node_modules`, `dist`, `.env`, tokens, bases de donnees,
  dossiers de sauvegarde ou secrets. Ne pas divulguer de code secret d'admin.
- Pour un fichier partage deja change par une autre IA, privilegier un patch
  cible avec controle du contexte ; NE PAS l'ecraser avec un ancien fichier.
- `Appliquer.ps1` cree une sauvegarde hors du code versionne avant remplacement
  et refuse tout contexte incompatible. Ne jamais effacer silencieusement.
- Le ZIP peut contenir des scripts additionnels si utiles, mais doit rester
  autonome : ne pas supposer qu'un dossier `_ia` existe dans le projet.

## 5. Bloc PowerShell a donner a l'utilisateur

Remplacer `<nom>` par le nom reel du ZIP fourni. Verifier que les scripts et
l'arborescence du ZIP utilisent exactement les memes noms.

```powershell
$zip = Join-Path $env:USERPROFILE 'Downloads\maf-<nom>-update.zip'
$dossier = Join-Path $env:TEMP 'maf-<nom>-update'
$front = 'C:\Users\hp\Documents\999\maf-game'
$back = 'C:\Users\hp\Documents\999\maf-game-backend-1'

if (-not (Test-Path -LiteralPath $zip)) { throw "ZIP introuvable : $zip" }
if (Test-Path -LiteralPath $dossier) { Remove-Item -LiteralPath $dossier -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $dossier -Force
$racine = Join-Path $dossier 'maf-<nom>-update'

powershell -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $racine 'Appliquer.ps1') -Frontend $front -Backend $back
if ($LASTEXITCODE -ne 0) { throw 'Installation interrompue. Rien ne sera publie.' }

powershell -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $racine 'Publier.ps1') -Frontend $front -Backend $back
if ($LASTEXITCODE -ne 0) { throw 'Publication interrompue. Voir les erreurs.' }
```

Avant le bloc, dire : « Enregistre le ZIP dans Telechargements, puis colle
ce bloc entier dans PowerShell. » Ne pas lancer des commandes differentes des
fichiers inclus dans le ZIP. Windows PowerShell 5.1 : pas de `&&` ou `??` ;
scripts `.ps1` compatibles et de preference en UTF-8 avec BOM.

## 6. Protection obligatoire dans les scripts

**Appliquer.ps1** :

- Verifier les dossiers, fichiers et versions attendues avant toute ecriture.
- Verifier les changements existants pour les fichiers cibles ; en cas de
  conflit, s'arreter au lieu d'ecraser le travail de l'utilisateur/d'une IA.
- Si possible, verifier que la branche locale correspond a la version GitHub
  avant installation (`git fetch`, controle du commit), sans `reset --hard`.
- Sauvegarder les fichiers touches et permettre un retour en arriere.
- Modifier uniquement les fichiers necessaires, sans effets sur les autres
  jeux, le backend ou l'interface non concernee.
- Echouer clairement (`exit 1`) a la moindre erreur ; ne jamais publier apres
  une installation incomplete.

**Publier.ps1** :

- Executer les tests concernes et `npm run build` pour le frontend quand il est
  touche ; ne pas annoncer un test reussi s'il n'a pas ete execute.
- Verifier les changements distants AVANT le push, et refuser une branche qui
  a diverge ou pris du retard au lieu de forcer le push.
- **INTERDICTION de `git add -A` ou `git add .`** : ajouter/committer seulement
  les fichiers explicitement modifies par ce correctif.
- Ne jamais publier d'autres modifications en cours, de fichiers secrets ou de
  commits preexistants sans accord de l'utilisateur.
- Ne jamais utiliser `git push --force` ni supprimer une branche distante.
- En cas d'echec : expliquer ou l'operation s'est arretee, sans pretendre que
  la mise en ligne est terminee.

## 7. Avant de repondre

- Le ZIP existe et s'ouvre ; le lien correspond au fichier reellement genere.
- Tous les chemins du script correspondent aux noms dans le ZIP.
- Le correctif s'applique a la version inspectee ; il refuse une version
  incompatible, sans ecraser des fichiers etrangers.
- Les tests et builds cites ont reellement ete executes, ou sont indiques comme
  restant a effectuer sur le PC de l'utilisateur.
- Les changements sont limites a la demande ; les acces prives et secrets ne
  sont jamais exposes dans l'interface publique ni dans le ZIP.
