#!/bin/bash

# ==================================================
# 🎵 YouTube Music Alexa Skill Setup Script
# ==================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=================================================="
echo "📦 Setting up YouTube Music Alexa Skill"
echo "=================================================="

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed. Please install Node.js (>= 16) first."
    exit 1
fi
echo "✔ Node.js version: $(node -v)"

# 2. Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is required but not installed."
    exit 1
fi
echo "✔ npm version: $(npm -v)"

# 3. Check yt-dlp
if command -v yt-dlp &> /dev/null; then
    echo "✔ yt-dlp detected: $(yt-dlp --version 2>/dev/null || echo 'installed')"
else
    echo "⚠️ yt-dlp not found in PATH. Downloading standalone binary into lambda/bin/..."
    mkdir -p "$SCRIPT_DIR/lambda/bin"
    
    OS_TYPE="$(uname -s)"
    if [ "$OS_TYPE" = "Darwin" ]; then
        curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o "$SCRIPT_DIR/lambda/bin/yt-dlp"
    else
        curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$SCRIPT_DIR/lambda/bin/yt-dlp"
    fi
    chmod +x "$SCRIPT_DIR/lambda/bin/yt-dlp"
    echo "✔ Downloaded yt-dlp to lambda/bin/yt-dlp"
fi

# 4. Install npm dependencies
echo "📦 Installing Node.js dependencies in lambda/..."
cd "$SCRIPT_DIR/lambda"
npm install

# 5. Create logs directory
mkdir -p "$SCRIPT_DIR/logs"

# 6. ngrok Authtoken Setup
echo ""
echo "=================================================="
echo "🔑 ngrok Authtoken Setup"
echo "=================================================="
echo "ngrok creates a secure HTTPS tunnel so Alexa can reach your local server."
echo "If you don't have a token, get one free at: https://dashboard.ngrok.com/get-started/your-authtoken"
echo ""

if [ -t 0 ]; then
    read -p "👉 Enter your ngrok authtoken (press Enter to skip if already set): " NGROK_TOKEN
    if [ -n "$NGROK_TOKEN" ]; then
        npx ngrok config add-authtoken "$NGROK_TOKEN"
        echo "✔ ngrok authtoken configured successfully!"
    else
        echo "ℹ️  Skipped ngrok token configuration."
    fi
else
    echo "ℹ️  Non-interactive session detected. To configure ngrok token manually, run:"
    echo "   npx ngrok config add-authtoken <YOUR_AUTHTOKEN>"
fi

chmod +x "$SCRIPT_DIR/start-local.sh" "$SCRIPT_DIR/stop-local.sh"

echo ""
echo "=================================================="
echo "🎉 Setup Complete!"
echo "=================================================="
echo "To start the local server & ngrok tunnel, run:"
echo "   ./start-local.sh"
echo "=================================================="
