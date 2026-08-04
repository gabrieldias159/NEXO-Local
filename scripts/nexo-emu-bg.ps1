$env:DIARIO_BACKFILL_SECRET = "nexo-local-emulator-secret-dev"
$env:NEXO_USE_EMULATOR = "1"
$env:FUNCTIONS_EMULATOR = "1"
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\jdk-21.0.11+10"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
Set-Location "$PSScriptRoot\.."
# Persistencia: importa o snapshot salvo e re-exporta ao sair (Ctrl+C limpo).
# Sem isso, cada restart zera TODO o Firestore local (1M+ docs re-semeados).
$flags = @()
if (Test-Path ".nexo-emu-data") { $flags += @("--import", ".nexo-emu-data") }
$flags += @("--export-on-exit", ".nexo-emu-data")
firebase emulators:start --only auth,firestore,functions,storage @flags *>> "$PSScriptRoot\..\logs\nexo-emulator.log"
