@echo off
setlocal enabledelayedexpansion

echo ==================================================
echo   Starting YouTube Music Alexa Skill
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
        echo [INFO] Downloading yt-dlp.exe for Windows...
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

node scripts/start-tunnel.js %*

pause
