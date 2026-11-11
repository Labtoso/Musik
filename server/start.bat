@echo off
rem Starts the Musik server on Windows. Installs Node.js with winget if needed.
title Musik server
cd /d "%~dp0"
echo.
echo   Musik server
echo   ------------
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Installing Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
if not exist node_modules (
  call npm ci --omit=dev --no-audit --no-fund
)
if not exist .env (
  echo PORT=8484> .env
  echo MUSIC_DIRS=%USERPROFILE%\Music>> .env
)
node --disable-warning=ExperimentalWarning src\index.js
pause
