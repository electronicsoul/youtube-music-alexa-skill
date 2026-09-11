@echo off
setlocal enabledelayedexpansion

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

node scripts/start-local.js %*

pause
