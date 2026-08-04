@echo off
title NEXO - Next.js Prod-Local
cd /d "%~dp0.."
echo [NEXO] Iniciando Next.js em modo prod-local na porta 9002
echo [NEXO] Requer build previo concluido
echo.
set NEXO_USE_EMULATOR=1
set NEXT_PUBLIC_USE_EMULATOR=1
set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
set FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
set FUNCTIONS_EMULATOR=1
npx next start -p 9002
