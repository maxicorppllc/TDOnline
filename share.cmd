@echo off
rem Host TD Online from this PC and get a public link for friends.
rem Double-click this file, then send friends the https://...trycloudflare.com link it prints.
rem The link changes every time. Close this window (or press Ctrl+C) to stop hosting.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8787

set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
where cloudflared >nul 2>nul && set "CF=cloudflared"
if not "%CF%"=="cloudflared" if not exist "%CF%" (
  echo cloudflared is not installed. Install it with:  winget install Cloudflare.cloudflared
  pause
  exit /b 1
)

echo Building the game...
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)

echo Starting the game server on port %PORT%...
start "TD Online server" /b node server/index.ts

echo.
echo Opening a public link. Look for the https://....trycloudflare.com address below
echo and send it to your friends. Keep this window open while you play.
echo.
"%CF%" tunnel --url http://localhost:%PORT%
