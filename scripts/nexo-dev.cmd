@echo off
title NEXO - Next.js Dev Server
cd /d "%~dp0.."
echo [NEXO] Iniciando Next.js dev server em localhost:9002
echo [NEXO] Cliente aponta para EMULADORES (.env.local ativo)
echo.
npm run dev
