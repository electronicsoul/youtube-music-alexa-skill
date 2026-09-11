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

:: Ensure bin directory exists
if not exist "bin" mkdir "bin"

:: Check and auto-download yt-dlp.exe for Windows if missing
where yt-dlp >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if not exist "bin\yt-dlp.exe" (
        echo [INFO] Downloading yt-dlp.exe for Windows (standalone YouTube extractor)...
        curl.exe -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -o "bin\yt-dlp.exe"
    )
)

echo [INFO] Stopping any stale server on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [INFO] Starting Node.js server on port 3000...
start "YouTube Music Alexa Skill" cmd /k "node lambda/server.js"

timeout /t 2 /nobreak >nul

set TUNNEL_CHOICE=cloudflared
if "%1"=="--ngrok" set TUNNEL_CHOICE=ngrok
if "%1"=="-n" set TUNNEL_CHOICE=ngrok

if "!TUNNEL_CHOICE!"=="cloudflared" (
    where cloudflared >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        if not exist "bin\cloudflared.exe" (
            echo [INFO] Downloading Cloudflare Tunnel for Windows (zero signup, no warning pages)...
            if not exist "bin" mkdir "bin"
            curl.exe -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -o "bin\cloudflared.exe"
        )
        set CLOUDFLARED_BIN=bin\cloudflared.exe
    ) else (
        set CLOUDFLARED_BIN=cloudflared
    )

    if exist "!CLOUDFLARED_BIN!" (
        echo [INFO] Starting Cloudflare Tunnel...
        start "Cloudflare Tunnel" cmd /k "!CLOUDFLARED_BIN! tunnel --protocol http2 --url http://localhost:3000"
        echo.
        echo ====================================================================
        echo [NEXT STEP] Look at the "Cloudflare Tunnel" window that just opened:
        echo 1. Find the URL ending with .trycloudflare.com
        echo    (e.g. https://random-name.trycloudflare.com)
        echo 2. Go to Alexa Developer Console: https://developer.amazon.com/alexa/console/ask
        echo 3. Open "YouTube Music" -^> Endpoints -^> HTTPS
        echo 4. Paste that HTTPS URL into "Default Region"
        echo 5. Select: "My development endpoint is a sub-domain of a domain that has a wildcard certificate..."
        echo 6. Click "Save Endpoints" (top right)
        echo ====================================================================
        goto :done
    )
)

:use_ngrok
where ngrok >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Starting ngrok tunnel on port 3000...
    start "ngrok" cmd /k "ngrok http 3000"
) else (
    echo [INFO] Starting tunnel via npx ngrok...
    start "ngrok" cmd /k "npx ngrok http 3000"
)

echo.
echo ====================================================================
echo [NEXT STEP] Look at the ngrok window that just opened:
echo 1. Copy the "Forwarding" HTTPS URL (e.g. https://xxxx.ngrok-free.app)
echo 2. Go to Alexa Developer Console: https://developer.amazon.com/alexa/console/ask
echo 3. Open "YouTube Music" -^> Endpoints -^> HTTPS
echo 4. Paste that HTTPS URL into "Default Region"
echo 5. Select: "My development endpoint is a sub-domain of a domain that has a wildcard certificate..."
echo 6. Click "Save Endpoints" (top right)
echo.
echo NOTE: If Alexa gives an error on free ngrok, run:
echo   start-local.bat
echo to use Cloudflare Tunnel which has zero browser warning pages.
echo ====================================================================

:done
echo.
echo Local Server: http://localhost:3000
echo Live Dashboard: http://localhost:3000/dashboard
echo.
pause
