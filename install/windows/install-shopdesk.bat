@echo off
title Shop Desk installer
net session >nul 2>nul
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shopdesk.ps1" %*
echo.
pause
