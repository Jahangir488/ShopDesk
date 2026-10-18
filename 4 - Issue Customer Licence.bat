@echo off
setlocal
title ShopDesk - Issue Customer Licence
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.13 or newer and try again.
  pause
  exit /b 1
)
cd /d "%~dp0"
node --no-warnings tools\supplier-licence.mjs
if errorlevel 1 echo.
pause
