@echo off
setlocal enabledelayedexpansion

echo ==================================================
echo   Starting YouTube Music Alexa Skill on Windows
echo ==================================================

cd /d "%~dp0"

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist "lambda\node_modules" (
    echo [INFO] Installing dependencies in lambda...
    cd lambda
    call npm install
    cd ..
)

echo [INFO] Starting Node.js server on port 3000...
start "YouTube Music Alexa Skill" node lambda/server.js

timeout /t 2 /nobreak >nul

where cloudflared >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Starting cloudflared tunnel...
    start "Cloudflare Tunnel" cloudflared tunnel --protocol http2 --url http://localhost:3000
    echo ==================================================
    echo Check the Cloudflare Tunnel window for your HTTPS URL
    echo (e.g. https://xxxx.trycloudflare.com)
    echo ==================================================
) else (
    where ngrok >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo [INFO] Starting ngrok tunnel...
        start "ngrok" ngrok http 3000
    ) else (
        echo [INFO] Starting tunnel via npx ngrok...
        start "ngrok" npx ngrok http 3000
    )
)

echo.
echo Server running at http://localhost:3000
echo Live Dashboard at http://localhost:3000/dashboard
echo.
pause
