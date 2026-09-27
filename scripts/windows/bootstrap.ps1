# AI Brain - Windows bootstrap.
# Makes sure Node.js (and Git) exist, installing them with winget if needed,
# then hands over to scripts/setup.mjs which detects the hardware, installs and
# starts Ollama, downloads the models, builds and launches the app.
# (ASCII only: Windows PowerShell 5.1 misreads UTF-8 files without BOM.)

param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root
$Host.UI.RawUI.WindowTitle = 'AI Brain'

function Say($text, $color = 'Gray') { Write-Host "    $text" -ForegroundColor $color }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Get-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try { return [version]((& node -v).TrimStart('v')) } catch { return $null }
}

function Install-WithWinget($id, $label) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Say "winget non disponibile: installa $label a mano e rilancia." Yellow
    return $false
  }
  Say "Installo $label (winget)... puo' comparire una richiesta di permessi di Windows." Cyan
  & winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  Refresh-Path
  return ($LASTEXITCODE -eq 0)
}

Write-Host ''
Write-Host '    AI BRAIN  -  avvio automatico' -ForegroundColor Magenta
Write-Host ''

# Node.js 20.10+ (22 LTS recommended)
$min = [version]'20.10.0'
$v = Get-NodeVersion
if (-not $v -or $v -lt $min) {
  if ($v) { Say "Node.js $v e' troppo vecchio (serve $min+)." Yellow } else { Say 'Node.js non trovato.' Yellow }
  [void](Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS')
  $v = Get-NodeVersion
  if (-not $v) {
    # winget sometimes installs without updating PATH for this session
    $candidate = Join-Path $env:ProgramFiles 'nodejs'
    if (Test-Path (Join-Path $candidate 'node.exe')) { $env:Path = "$candidate;$env:Path"; $v = Get-NodeVersion }
  }
  if (-not $v -or $v -lt $min) {
    Say 'Impossibile installare Node.js automaticamente.' Red
    Say 'Scaricalo da https://nodejs.org (versione LTS), poi rilancia AI-Brain.bat' Red
    exit 1
  }
}
Say "Node.js $v" Green

# Git (optional but recommended: the agent uses it)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (-not (Install-WithWinget 'Git.Git' 'Git')) { Say 'Git non installato: le funzioni Git dell''agente saranno disattivate.' Yellow }
}

& node (Join-Path $Root 'scripts\setup.mjs') @Rest
exit $LASTEXITCODE
