param(
  [switch]$NoSeed,
  [switch]$NoDev,
  [switch]$ProdLocal
)

$ROOT = Split-Path -Parent $PSScriptRoot
$LOG = Join-Path $ROOT "logs\nexo-local.log"

# Garante JDK 11+ para o Firestore Emulator (requerido pelo firebase-tools)
$jdkCandidates = @(
  "$env:USERPROFILE\.jdks\jdk-21.0.11+10",
  "$env:USERPROFILE\.jdks\jdk-17.0.20+8",
  "$env:ProgramFiles\Eclipse Adoptium\jdk-21.*",
  "$env:ProgramFiles\Java\jdk-*"
)
if (-not $env:JAVA_HOME) {
  foreach ($candidate in $jdkCandidates) {
    $resolved = Resolve-Path $candidate -ErrorAction SilentlyContinue
    if ($resolved) {
      $env:JAVA_HOME = $resolved[-1].Path
      $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
      break
    }
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "logs") | Out-Null

function Log {
  param([string]$Msg)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$timestamp $Msg" | Out-File -Append -LiteralPath $LOG
  Write-Host "[NEXO] $Msg"
}

function Fail-AndExit {
  param([string]$Msg)
  Log "ERRO: $Msg"
  exit 1
}

function Run-Logged {
  param(
    [string]$WorkingDir,
    [string]$Command
  )
  Push-Location $WorkingDir
  try {
    Invoke-Expression $Command 2>&1 | ForEach-Object { $_ }
    if ($LASTEXITCODE -ne 0) {
      Fail-AndExit "Falha ao executar: $Command"
    }
  } finally {
    Pop-Location
  }
}

Log "=== NEXO LOCAL STARTUP ==="
Log "Diretorio: $ROOT"
Log ("Modo: " + ($(if ($ProdLocal) { "prod-local" } else { "dev-local" })))

$portas = @{ 9099 = 'Auth'; 8080 = 'Firestore'; 5001 = 'Functions'; 9199 = 'Storage'; 4000 = 'Emulator UI'; 9002 = 'Next.js' }
foreach ($port in $portas.Keys) {
  $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  if ($conn) {
    Log "AVISO: Porta $port ($($portas[$port])) ja em uso por PID $($conn.OwningProcess)"
  }
}

Log "Compilando Cloud Functions..."
Run-Logged -WorkingDir (Join-Path $ROOT "functions") -Command "npm run build"
Log "Functions compiladas com sucesso"

$env:DIARIO_BACKFILL_SECRET = "nexo-local-emulator-secret-dev"
$env:NEXO_USE_EMULATOR = "1"
$env:NEXT_PUBLIC_USE_EMULATOR = "1"
$env:FUNCTIONS_EMULATOR = "1"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
$env:FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199"
$env:STORAGE_EMULATOR_HOST = "127.0.0.1:9199"
$env:PUBSUB_EMULATOR_HOST = "127.0.0.1:8085"
$env:GCLOUD_PROJECT = "studio-8612233125-caa0a"

Log "Iniciando Firebase Emulators em background..."
$emuLog = Join-Path (Split-Path $LOG) "nexo-emulator.log"
$emuScript = @"
`$env:DIARIO_BACKFILL_SECRET = "nexo-local-emulator-secret-dev"
`$env:NEXO_USE_EMULATOR = "1"
`$env:NEXT_PUBLIC_USE_EMULATOR = "1"
`$env:FUNCTIONS_EMULATOR = "1"
`$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
`$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
`$env:FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199"
`$env:PUBSUB_EMULATOR_HOST = "127.0.0.1:8085"
`$env:GCLOUD_PROJECT = "studio-8612233125-caa0a"
`$env:JAVA_HOME = "$($env:JAVA_HOME)"
`$env:PATH = "`$env:JAVA_HOME\bin;`$env:PATH"
Set-Location '$ROOT'
`$flags = @()
if (Test-Path '.nexo-emu-data') { `$flags += @('--import', '.nexo-emu-data') }
`$flags += @('--export-on-exit', '.nexo-emu-data')
firebase emulators:start --only auth,firestore,functions,storage,pubsub @flags *>> '$emuLog'
"@
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$emuScript

Log "Aguardando emuladores iniciarem (45s)..."
Start-Sleep -Seconds 45

$emuReady = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $req = Invoke-WebRequest -Uri "http://127.0.0.1:5001/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    $emuReady = $true
    break
  } catch { }
  Start-Sleep -Seconds 3
}

if (-not $emuReady) {
  Log "AVISO: Emulador de functions pode nao ter iniciado completamente. Log: $emuLog"
}

Log "Garantindo usuario dev (auth + perfil + claims)..."
try {
  Run-Logged -WorkingDir $ROOT -Command "node scripts/nexo-seed-dev.mjs"
  Log "Usuario dev garantido"
} catch {
  Log "ERRO ao garantir usuario dev: $($_.Exception.Message)"
}

Log "Iniciando NEXO Local Scheduler (replica do Cloud Scheduler) em background..."
$cronLog = Join-Path (Split-Path $LOG) "nexo-cron.log"
$cronScript = @"
`$env:PUBSUB_EMULATOR_HOST = "127.0.0.1:8085"
`$env:GCLOUD_PROJECT = "studio-8612233125-caa0a"
Set-Location '$ROOT'
node scripts/nexo-cron.mjs *>> '$cronLog'
"@
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$cronScript
Log "NEXO Local Scheduler iniciado (log: $cronLog)"

if (-not $NoSeed) {
  Log "Aguardando functions carregarem (10s)..."
  Start-Sleep -Seconds 10
  Log "Disparando seed dos dados (backfill 2025,2026)..."
  try {
    $seedUrl = "http://127.0.0.1:5001/studio-8612233125-caa0a/us-central1/onNexoBackfillHttp?anos=2025,2026&modulos=all"
    $seedRes = Invoke-WebRequest -Uri $seedUrl -Method Get -Headers @{ "x-backfill-secret" = "nexo-local-emulator-secret-dev" } -UseBasicParsing -TimeoutSec 7200
    $seedData = $seedRes.Content | ConvertFrom-Json
    if ($seedData.ok) {
      Log "Seed concluido: $($seedData.ingestoes) ingestoes, $($seedData.comErro) com erro"
    } else {
      Log "Seed falhou: $($seedData.error)"
    }
  } catch {
    Log "Seed error: $($_.Exception.Message)"
  }
} else {
  Log "Seed pulado (flag -NoSeed ativa)"
}

if ($ProdLocal) {
  Log "Compilando Next.js para modo prod-local..."
  Run-Logged -WorkingDir $ROOT -Command "npm run build"
  Log "Build do Next.js concluido"
}

if (-not $NoDev) {
  if ($ProdLocal) {
    Log "Iniciando Next.js em modo prod-local em background..."
  } else {
    Log "Iniciando Next.js dev server em background..."
  }

  $devLog = Join-Path (Split-Path $LOG) "nexo-dev.log"
  $devCmd = if ($ProdLocal) { "npx next start -p 9002" } else { "npm run dev" }
  $devScript = @"
`$env:DIARIO_BACKFILL_SECRET = "nexo-local-emulator-secret-dev"
`$env:NEXO_USE_EMULATOR = "1"
`$env:NEXT_PUBLIC_USE_EMULATOR = "1"
`$env:FUNCTIONS_EMULATOR = "1"
`$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
`$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
`$env:FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199"
Set-Location '$ROOT'
$devCmd *>> '$devLog'
"@
  Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-Command",$devScript

  Start-Sleep -Seconds 15
  Log "App deve estar rodando em http://localhost:9002 (log: $devLog)"
}

Log "=== NEXO LOCAL STARTUP CONCLUIDO ==="
Log "  Emulators UI: http://localhost:4000"
Log "  App Local:    http://localhost:9002"
Log "  Logs:         $LOG"
Log ""
Log "Para encerrar:"
if ($ProdLocal) {
  Log "  1. Encerre o processo next start"
} else {
  Log "  1. Feche o terminal do dev server (Ctrl+C)"
}
Log "  2. Feche o terminal dos emuladores (Ctrl+C)"
Log "  Ou rode: Get-Job | Stop-Job"
