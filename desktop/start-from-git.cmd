@echo off
setlocal
cd /d "%~dp0"

echo Pulling latest live-dashboard-app...
git -C .. fetch origin
git -C .. pull --ff-only
if errorlevel 1 (
  echo Git pull failed — starting with whatever is on disk.
)

if not exist "node_modules\" (
  echo Installing desktop dependencies...
  call npm install
)

echo Starting Live Dashboard tray from this repo (no installer)...
call npm start
endlocal
