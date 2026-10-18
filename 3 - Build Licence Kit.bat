@echo off
setlocal
title Shop Desk - Supplier Signing Key Setup
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
goto supplier_ready

:create_supplier_key
echo.
echo This creates your supplier signing key on THIS PC.
echo Never do this on a customer PC.
echo If you have already issued paid keys, do not continue; find your existing private-key backup.
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
  echo Key creation failed. No key was created for customer issuance.
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
echo Stop here. Do not issue customer licences until the matching app update is installed.
pause
exit /b 0

:wait_for_app_update
echo.
echo A new signing key was created. The customer app must trust its matching public key first.
echo Confirm the matching Shop Desk app update is installed before issuing keys.
echo.
choice /c YN /n /m "Is the matching app update installed on the customer PC? (Y/N) "
if errorlevel 2 (
  echo Cancelled. No licence will be issued.
  pause
  exit /b 1
)
del /q "vendor\license-key-sync-pending.txt"

:supplier_ready
echo.
echo Supplier signing key setup is ready.
echo The portable USB licence kit is retired; it could copy your private signing key to a customer PC.
echo.
echo To issue a customer's commercial licence, run:
echo   4 - Issue Customer Licence.bat
echo or:
echo   npm run license:supplier
echo.
echo Run the issuer here on your supplier PC. Send the customer only the signed licence key.
echo NEVER send vendor\license-private-key.pem.
echo.
pause
exit /b 0
