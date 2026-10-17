@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the separate SQLite database.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
node server.mjs
pause
