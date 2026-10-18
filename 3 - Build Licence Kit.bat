@echo off
setlocal
title Shop Desk - Legacy Licence Kit Disabled
echo.
echo The old portable USB licence kit has been retired for commercial safety.
echo It could copy the supplier private signing key onto a customer computer.
echo.
echo To issue a customer licence, run 4 - Issue Customer Licence.bat on YOUR supplier PC.
echo Or run: npm run license:supplier
echo.
echo First-time supplier key setup is described in LICENSING.md.
echo The underlying script is tools\license-keygen.mjs; run it only on the supplier PC.
echo Only on the supplier PC, the setup command is: npm run license:keygen
echo It creates the private key and updates lib\license-public.mjs; the matching public-key build must be installed before issuing keys.
echo The old sync marker was vendor\license-key-sync-pending.txt.
echo NEVER send vendor\license-private-key.pem.
echo.
echo Send customers only the signed offline licence key. Do not send source or a USB signing kit.
echo.
pause
exit /b 0
