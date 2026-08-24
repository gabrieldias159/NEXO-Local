# NEXO Watchdog - roda a cada 5 min via Agendador de Tarefas (run-once).
# Checa SAUDE REAL (latencia, nao so porta) e cura sozinho:
#   - Next dev (9002) morto  -> religa via nexo-dev-bg.ps1
#   - Emuladores mortos/degradados -> exporta (best-effort), mata, religa via
#     nexo-emu-bg.ps1 (que importa .nexo-emu-data - dados preservados)
#   - Snapshot periodico da base (a cada 6h) p/ crash duro perder pouco
# Log: logs\nexo-watchdog.log. Lock evita execucoes sobrepostas.
# ASCII puro (PS 5.1 le UTF-8 sem BOM como ANSI).

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent $PSScriptRoot
$LOG = Join-Path $ROOT "logs\nexo-watchdog.log"
$LOCK = Join-Path $ROOT "logs\nexo-watchdog.lock"
$SNAP = Join-Path $ROOT ".nexo-emu-data"
$SNAPSTAMP = Join-Path $ROOT "logs\nexo-last-export.txt"
# Caminho completo do firebase CLI (o PATH da tarefa agendada pode nao te-lo)
$FIREBASE = $null
$cmd = Get-Command "firebase.cmd" -ErrorAction SilentlyContinue
if ($cmd) { $FIREBASE = $cmd.Source }
elseif (Test-Path "$env:APPDATA\npm\firebase.cmd") { $FIREBASE = "$env:APPDATA\npm\firebase.cmd" }

function Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LOG -Value "[$ts] $msg" -Encoding ASCII
}

New-Item -ItemType Directory -Force (Join-Path $ROOT "logs") | Out-Null
# Trunca log grande (mantem as ultimas 400 linhas)
if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 1MB)) {
  $tail = Get-Content $LOG -Tail 400
  Set-Content -Path $LOG -Value $tail -Encoding ASCII
}

# Lock: se outra execucao esta viva ha menos de 10 min, sai.
if (Test-Path $LOCK) {
  $age = (Get-Date) - (Get-Item $LOCK).LastWriteTime
  if ($age.TotalMinutes -lt 10) { exit 0 }
}
Set-Content -Path $LOCK -Value "$PID" -Encoding ASCII

try {

function ProbeHttp($url, $timeoutSec) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $req = [System.Net.WebRequest]::Create($url)
    $req.Timeout = $timeoutSec * 1000
    $resp = $req.GetResponse()
    $resp.Close()
    return @{ ok = $true; ms = $sw.ElapsedMilliseconds; code = 200 }
  } catch [System.Net.WebException] {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    # Resposta HTTP de erro (403/404/501) = processo VIVO e respondendo
    if ($code -gt 0) { return @{ ok = $true; ms = $sw.ElapsedMilliseconds; code = $code } }
    return @{ ok = $false; ms = $sw.ElapsedMilliseconds; code = 0 }
  } catch {
    return @{ ok = $false; ms = $sw.ElapsedMilliseconds; code = 0 }
  }
}

function KillPort($port) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    foreach ($c in $conns) {
      try { Stop-Process -Id $c.OwningProcess -Force -Confirm:$false -ErrorAction Stop } catch {}
    }
  } catch {}
}

# ?????? 1. Next dev (9002) ?????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????
$next = ProbeHttp "http://127.0.0.1:9002/" 15
if (-not $next.ok) {
  Log "Next 9002 SEM RESPOSTA - religando via nexo-dev-bg.ps1"
  KillPort 9002
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$PSScriptRoot\nexo-dev-bg.ps1"
} elseif ($next.ms -gt 12000) {
  Log "Next 9002 LENTO ($($next.ms)ms) - observando (sem acao)"
}

# ?????? 2. Emuladores: saude REAL do Firestore ?????????????????????????????????????????????????????????????????????????????????????????????????????????
# REST de doc (sem auth) responde 403 pelas rules QUANDO SAUDAVEL - o que
# importa e a LATENCIA. Sem resposta ou > 8s = degradado -> reciclar.
$fs = ProbeHttp "http://127.0.0.1:8080/v1/projects/studio-8612233125-caa0a/databases/(default)/documents/nexo_sync_state/_coleta_diaria" 20
$auth = ProbeHttp "http://127.0.0.1:9099/" 10
$doente = (-not $fs.ok) -or ($fs.ms -gt 8000) -or (-not $auth.ok)

if ($doente) {
  Log "Emuladores DOENTES (firestore ok=$($fs.ok) $($fs.ms)ms; auth ok=$($auth.ok)) - reciclando"
  # Export best-effort (2 min no maximo) - se o emulador ainda anda, salva o estado
  if ($fs.ok -and $FIREBASE) {
    try {
      $p = Start-Process -FilePath $FIREBASE -ArgumentList "emulators:export",$SNAP,"--force" -WorkingDirectory $ROOT -WindowStyle Hidden -PassThru
      if (-not $p.WaitForExit(120000)) { $p.Kill(); Log "export pre-reciclagem estourou 120s - seguindo com snapshot antigo" }
      elseif ($p.ExitCode -eq 0) { Log "export pre-reciclagem ok"; Set-Content $SNAPSTAMP (Get-Date -Format o) -Encoding ASCII }
      else { Log "export pre-reciclagem FALHOU (exit $($p.ExitCode)) - snapshot antigo mantido" }
    } catch { Log "export pre-reciclagem falhou: $($_.Exception.Message)" }
  }
  foreach ($porta in 8080, 9099, 5001, 9199, 4000, 4400) { KillPort $porta }
  Start-Sleep -Seconds 5
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$PSScriptRoot\nexo-emu-bg.ps1"
  Log "emuladores religados (import de .nexo-emu-data se existir)"
} else {
  # ?????? 3. Snapshot periodico (a cada 6h) quando saudavel ??????????????????????????????????????????????????????????????????
  $fazer = $true
  if (Test-Path $SNAPSTAMP) {
    try {
      $ultimo = [DateTime]::Parse((Get-Content $SNAPSTAMP -TotalCount 1))
      if (((Get-Date) - $ultimo).TotalHours -lt 6) { $fazer = $false }
    } catch {}
  }
  if ($fazer -and $FIREBASE) {
    try {
      $p = Start-Process -FilePath $FIREBASE -ArgumentList "emulators:export",$SNAP,"--force" -WorkingDirectory $ROOT -WindowStyle Hidden -PassThru
      if ($p.WaitForExit(600000) -and $p.ExitCode -eq 0) {
        Set-Content $SNAPSTAMP (Get-Date -Format o) -Encoding ASCII
        Log "snapshot periodico ok"
      } else {
        try { $p.Kill() } catch {}
        # BACKOFF: carimba a data MESMO na falha.
        #
        # Sem isto o carimbo nunca era gravado, entao a condicao "faz 6h?"
        # dava verdadeiro a cada ciclo e o export de centenas de MB era
        # disparado A CADA 5 MINUTOS, indefinidamente. Em 29h isso rendeu 353
        # tentativas, todas falhas. Pior: exportar concorre com o emulador em
        # uso e o degrada - foi o que levou o Firestore a 8060ms e disparou a
        # reciclagem por "DOENTES". O watchdog causava parte do problema que
        # existe para resolver.
        Set-Content $SNAPSTAMP (Get-Date -Format o) -Encoding ASCII
        Log "snapshot periodico falhou - nova tentativa so daqui a 6h (backoff)"
      }
    } catch { Log "snapshot periodico erro: $($_.Exception.Message)" }
  }
}

} finally {
  Remove-Item $LOCK -Force -ErrorAction SilentlyContinue
}
