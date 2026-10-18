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

if not exist "vendor\license-private-key.pem" goto create_supplier_key
if exist "vendor\license-key-sync-pending.txt" goto wait_for_app_update
goto build_kit

:create_supplier_key
echo.
echo This creates your supplier signing key on THIS PC.
echo Never do this on a customer PC.
echo If you have already issued a paid key, do not continue; find the old key backup.
echo.
choice /c YN /n /m "Is this your supplier PC, and have no paid keys been issued? (Y/N) "
if errorlevel 2 (
  echo Cancelled. No key was created.
  pause
  exit /b 1
)
node tools\license-keygen.mjs
if errorlevel 1 (
  echo.
  echo Key creation failed. No licence kit was built.
  pause
  exit /b 1
)
>"vendor\license-key-sync-pending.txt" echo A matching public-key app update is required before issuing any keys.
echo.
echo Your public key is in:
echo   lib\license-public.mjs
echo.
echo Send ONLY that public file to Shop Desk support so the matching app update can be prepared.
echo NEVER send vendor\license-private-key.pem.
start "" notepad.exe "%~dp0lib\license-public.mjs"
echo.
echo Stop here. Do not make customer keys until the matching app update is installed.
pause
exit /b 0

:wait_for_app_update
echo.
echo A new signing key was created. The customer app must trust its matching public key first.
echo Install the matching Shop Desk update on the customer PC before building the USB kit.
echo.
choice /c YN /n /m "Is the matching app update installed on the customer PC? (Y/N) "
if errorlevel 2 (
  echo Cancelled. No licence kit was built.
  pause
  exit /b 1
)
del /q "vendor\license-key-sync-pending.txt"

:build_kit
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
