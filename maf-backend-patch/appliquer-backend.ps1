# MAF backend : comptes pseudo + code (routes /api/register, /api/login, /api/me)
# Lance ce script depuis le dossier maf-backend (celui qui contient server.js).
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path (Join-Path $root 'server.js')) -or -not (Test-Path (Join-Path $root 'db.js'))) {
  Write-Host "ERREUR : lance ce script depuis le dossier maf-backend (celui qui contient server.js et db.js)." -ForegroundColor Red
  exit 1
}
$utf8 = New-Object Text.UTF8Encoding($false)

# Remplacements exacts dans un fichier (gere les fins de ligne Windows)
function Patch-File($path, $pairs) {
  $raw = [IO.File]::ReadAllText($path)
  $crlf = $raw.Contains("`r`n")
  $txt = $raw -replace "`r`n", "`n"
  foreach ($p in $pairs) {
    if ($txt.Contains($p[1])) { Write-Host "  = deja fait : $($p[2])" -ForegroundColor DarkGray; continue }
    if (-not $txt.Contains($p[0])) { throw "Texte introuvable dans $(Split-Path $path -Leaf) : $($p[2])" }
    $txt = $txt.Replace($p[0], $p[1])
    Write-Host "  + $($p[2])" -ForegroundColor Green
  }
  if ($crlf) { $txt = $txt -replace "`n", "`r`n" }
  [IO.File]::WriteAllText($path, $txt, $utf8)
}

# 1) auth.js (nouveau fichier)
Copy-Item (Join-Path $PSScriptRoot 'files/auth.js') (Join-Path $root 'auth.js') -Force
Write-Host "  + auth.js cree" -ForegroundColor Green

# 2) server.js (3 petites modifications, sauvegarde .avant-comptes.bak)
$server = Join-Path $root 'server.js'
if (-not (Test-Path "$server.avant-comptes.bak")) { Copy-Item $server "$server.avant-comptes.bak" }
Patch-File $server @(
  ,@('import { pool } from "./db.js";',
     "import { pool } from `"./db.js`";`nimport { authRouter } from `"./auth.js`";",
     'import authRouter')
  ,@('app.use(cors({ origin: origins }));',
     'app.use(cors({ origin: (origin, done) => done(null, !origin || origins.includes(origin) || /\.app\.github\.dev$/.test(origin)) }));',
     'CORS (site + Codespaces)')
  ,@('// Ici viendront les routes : /api/register, /api/login, ...',
     'app.use("/api", authRouter); // /api/register, /api/login, /api/me',
     'routes /api')
)

Write-Host ""
Write-Host "Backend pret. Pousse sur GitHub pour redeployer :" -ForegroundColor Cyan
Write-Host '  git add . ; git commit -m "comptes pseudo + code" ; git push'
