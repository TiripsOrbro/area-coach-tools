@echo off
setlocal EnableExtensions
title Area Coach Tools — Installer
REM Single entry point. Prefer local .ps1 (dev / after clone); otherwise download from GitHub.

set "PS1=%~dp0Install-AreaCoachTools.ps1"
set "REPO_RAW=https://raw.githubusercontent.com/TiripsOrbro/area-coach-tools/main/Install-AreaCoachTools.ps1"
set "ARGS=%*"

if not exist "%PS1%" (
  echo Downloading installer script from GitHub...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "Invoke-WebRequest -UseBasicParsing -Uri '%REPO_RAW%' -OutFile '%TEMP%\Install-AreaCoachTools.ps1'"
  if errorlevel 1 (
    echo Failed to download installer from GitHub.
    echo Ensure the repo is public or you are signed in, then retry.
    pause
    exit /b 1
  )
  set "PS1=%TEMP%\Install-AreaCoachTools.ps1"
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %ARGS%
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo Installer failed with exit code %ERR%.
  pause
)
exit /b %ERR%
