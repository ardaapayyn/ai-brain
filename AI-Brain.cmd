@echo off
rem Avvio rapido su Windows: installa (la prima volta), compila e apre il cervello.
cd /d "%~dp0"
if not exist node_modules (
  echo Installazione dipendenze...
  call npm install || goto :error
)
if not exist web\dist\index.html (
  echo Compilazione...
  call npm run build || goto :error
)
start "" http://127.0.0.1:7777
call npm start
goto :eof
:error
echo.
echo Qualcosa e' andato storto. Esegui "npm run doctor" per una diagnosi.
pause
