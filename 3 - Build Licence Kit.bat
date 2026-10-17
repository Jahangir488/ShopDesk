@echo off
setlocal
title Shop Desk - Build Licence Kit
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on this PC.
  echo Install Node.js 22.13 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist "vendor\license-private-key.pem" (
  echo.
  echo No signing key was found in vendor\license-private-key.pem
  echo.
  echo This PC is not the supplier PC, or the key was never created here.
  echo On your own PC run:  npm run license:keygen
  echo Then run this file again.
  echo.
  echo NEVER create a new key on a customer PC: it would not match
  echo the Shop Desk they already have installed.
  pause
  exit /b 1
)
node tools\make-licence-kit.mjs %*
if errorlevel 1 (
  echo.
  echo The kit could not be built. Read the message above.
  pause
  exit /b 1
)
echo.
echo Copy the folder above to your encrypted USB stick:
echo   releases\ShopDesk-Licence-Kit
echo.
start "" "%~dp0releases\ShopDesk-Licence-Kit"
echo.
pause
