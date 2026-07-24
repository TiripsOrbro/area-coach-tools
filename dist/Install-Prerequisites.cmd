@echo off
setlocal EnableExtensions
title Area Coach Tools - Install Prerequisites
cd /d "%~dp0"

echo.
echo Area Coach Tools - Install Git + Node.js
echo ========================================
echo This may ask for Administrator approval.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Prerequisites.ps1"
set "ERR=%ERRORLEVEL%"

if not "%ERR%"=="0" (
  echo.
  echo Prerequisites install failed (exit %ERR%).
  pause
  exit /b %ERR%
)

exit /b 0
