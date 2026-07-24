@echo off
setlocal EnableExtensions
title Area Coach Tools
REM Opens / builds the unified Area Coach Tools.exe (install + update + launch).

set "ROOT=%~dp0"
set "APP=%ROOT%Area Coach Tools.exe"
set "DIST_APP=%ROOT%dist\Area Coach Tools.exe"
set "BUILD_PS1=%ROOT%tools\Build-SetupExe.ps1"

if exist "%APP%" goto :run
if exist "%DIST_APP%" (
  copy /Y "%DIST_APP%" "%APP%" >nul
  goto :run
)

echo Building Area Coach Tools.exe...
if not exist "%BUILD_PS1%" (
  echo Missing tools\Build-SetupExe.ps1
  echo Clone the repo or download Area Coach Tools.exe from GitHub.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BUILD_PS1%" -OutDir "%ROOT%"
if errorlevel 1 (
  echo Failed to build Area Coach Tools.exe
  pause
  exit /b 1
)

:run
start "" "%APP%"
exit /b 0
