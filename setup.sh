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

# 5. Check / Install Native ngrok binary for Android/ARM/Linux
mkdir -p "$SCRIPT_DIR/lambda/bin"
ARCH="$(uname -m)"
OS_TYPE="$(uname -s)"

if [ -d "/data/data/com.termux" ] || [ -n "$TERMUX_VERSION" ]; then
    echo "📱 Android Termux environment detected!"
    rm -f "$SCRIPT_DIR/lambda/bin/ngrok" 2>/dev/null || true
    if ! command -v ngrok &> /dev/null; then
        echo "📦 Installing Android-compatible ngrok package via Termux TUR repository..."
        pkg install tur-repo -y 2>/dev/null || true
        pkg install ngrok -y 2>/dev/null || true
    fi
elif [ "$OS_TYPE" = "Linux" ]; then
    if ! command -v ngrok &> /dev/null && [ ! -f "$SCRIPT_DIR/lambda/bin/ngrok" ]; then
        echo "📦 Downloading native ngrok binary for $ARCH..."
        if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
            NGROK_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz"
        elif [ "$ARCH" = "armv7l" ] || [ "$ARCH" = "arm" ]; then
            NGROK_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm.tgz"
        else
            NGROK_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz"
        fi
        
        curl -sL "$NGROK_URL" -o "$SCRIPT_DIR/lambda/bin/ngrok.tgz"
        tar -xzf "$SCRIPT_DIR/lambda/bin/ngrok.tgz" -C "$SCRIPT_DIR/lambda/bin/"
        rm -f "$SCRIPT_DIR/lambda/bin/ngrok.tgz"
        chmod +x "$SCRIPT_DIR/lambda/bin/ngrok"
        echo "✔ Native ngrok binary installed to lambda/bin/ngrok"
    fi
fi

# Determine working ngrok command binary
if command -v ngrok &> /dev/null; then
    NGROK_CMD="ngrok"
elif [ -f "$SCRIPT_DIR/lambda/bin/ngrok" ] && "$SCRIPT_DIR/lambda/bin/ngrok" --version &> /dev/null; then
    NGROK_CMD="$SCRIPT_DIR/lambda/bin/ngrok"
else
    NGROK_CMD="npx ngrok"
fi

# 6. Create logs directory
mkdir -p "$SCRIPT_DIR/logs"

# 7. ngrok Authtoken Setup
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
        "$NGROK_CMD" config add-authtoken "$NGROK_TOKEN"
        echo "✔ ngrok authtoken configured successfully!"
    else
        echo "ℹ️  Skipped ngrok token configuration."
    fi
else
    echo "ℹ️  Non-interactive session detected. To configure ngrok token manually, run:"
    echo "   $NGROK_CMD config add-authtoken <YOUR_AUTHTOKEN>"
fi

chmod +x "$SCRIPT_DIR/start-local.sh" "$SCRIPT_DIR/stop-local.sh"

echo ""
echo "=================================================="
echo "🎉 Setup Complete!"
echo "=================================================="
echo "To start the local server & ngrok tunnel, run:"
echo "   ./start-local.sh"
echo "=================================================="
