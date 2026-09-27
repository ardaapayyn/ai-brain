@echo off
rem  AI Brain - avvio con un doppio click.
rem  Rileva l'hardware, installa quello che manca (Node.js, Git, Ollama),
rem  scarica i modelli adatti al tuo PC, compila e apre il cervello nel browser.
rem  Opzioni: --reconfigure  --no-pull  --no-gpu-check  --port 7777
setlocal
cd /d "%~dp0"
title AI Brain
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\bootstrap.ps1" %*
if errorlevel 1 (
  echo.
  echo   Avvio non riuscito: leggi il messaggio qui sopra.
  echo   Per una diagnosi completa:  npm run doctor
  echo.
  pause
)
endlocal
