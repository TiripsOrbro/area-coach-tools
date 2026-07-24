@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-AreaCoachTools.ps1" -InstallDir "%~dp0." -Quiet -Launch
exit /b %ERRORLEVEL%
