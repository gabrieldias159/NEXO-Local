@echo off
title NEXO - Firebase Emulators
cd /d "%~dp0.."

:: Garante JDK 11+ para o Firestore Emulator (Java)
if "%JAVA_HOME%"=="" (
  if exist "%USERPROFILE%\.jdks\jdk-21.0.11+10" (
    set "JAVA_HOME=%USERPROFILE%\.jdks\jdk-21.0.11+10"
    set "PATH=%JAVA_HOME%\bin;%PATH%"
  )
)

echo [NEXO] Iniciando Firebase Emulators (auth:9099 firestore:8080 functions:5001 storage:9199 pubsub:8085 ui:4000)
echo [NEXO] Custo ZERO - tudo local, nada vai para producao
echo.
set DIARIO_BACKFILL_SECRET=nexo-local-emulator-secret-dev
set NEXO_USE_EMULATOR=1
set FUNCTIONS_EMULATOR=1
set PUBSUB_EMULATOR_HOST=127.0.0.1:8085
set GCLOUD_PROJECT=studio-8612233125-caa0a
:: Persistencia: importa snapshot salvo e re-exporta ao sair (sem isso, cada
:: restart zera todo o Firestore local). Pub/Sub e obrigatorio para as
:: functions onSchedule (processadores NEXO) serem registradas no emulador.
if exist ".nexo-emu-data" (
  firebase emulators:start --only auth,firestore,functions,storage,pubsub --import .nexo-emu-data --export-on-exit .nexo-emu-data
) else (
  firebase emulators:start --only auth,firestore,functions,storage,pubsub --export-on-exit .nexo-emu-data
)
