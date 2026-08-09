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

chmod +x "$SCRIPT_DIR/start-local.sh" "$SCRIPT_DIR/stop-local.sh"

echo "=================================================="
echo "🎉 Setup Complete!"
echo "=================================================="
echo "To start the local server & ngrok tunnel, run:"
echo "   ./start-local.sh"
echo "=================================================="
