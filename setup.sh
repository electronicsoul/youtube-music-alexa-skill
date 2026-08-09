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

# 5. Check / Install ngrok
mkdir -p "$SCRIPT_DIR/lambda/bin"
ARCH="$(uname -m)"
OS_TYPE="$(uname -s)"
NGROK_CMD=""

if command -v ngrok &> /dev/null; then
    NGROK_CMD="ngrok"
    echo "✔ ngrok detected: $(ngrok --version 2>/dev/null || echo 'installed')"
elif [ -d "/data/data/com.termux" ] || [ -n "$TERMUX_VERSION" ]; then
    # Android Termux: standard Linux binaries won't work due to Bionic linker
    echo "📱 Android Termux environment detected!"
    rm -f "$SCRIPT_DIR/lambda/bin/ngrok" 2>/dev/null || true
    
    # Try Termux package manager first
    echo "📦 Attempting to install ngrok via Termux packages..."
    pkg install tur-repo -y 2>/dev/null || true
    pkg install ngrok -y 2>/dev/null || true
    
    if command -v ngrok &> /dev/null; then
        NGROK_CMD="ngrok"
        echo "✔ ngrok installed via Termux packages"
    else
        # Fallback: use pyngrok (Python wrapper that downloads Android-compatible ngrok)
        echo "📦 Installing ngrok via pyngrok (Python)..."
        pip install pyngrok 2>/dev/null || pip3 install pyngrok 2>/dev/null || true
        if command -v ngrok &> /dev/null; then
            NGROK_CMD="ngrok"
            echo "✔ ngrok installed via pyngrok"
        else
            echo "⚠️  Could not auto-install ngrok on this device."
            echo "   Please install manually: pip install pyngrok"
        fi
    fi
elif [ "$OS_TYPE" = "Linux" ]; then
    if [ ! -f "$SCRIPT_DIR/lambda/bin/ngrok" ]; then
        echo "📦 Downloading native ngrok binary for $ARCH..."
        if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
            DL_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz"
        elif [ "$ARCH" = "armv7l" ] || [ "$ARCH" = "arm" ]; then
            DL_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm.tgz"
        else
            DL_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz"
        fi
        curl -sL "$DL_URL" -o "$SCRIPT_DIR/lambda/bin/ngrok.tgz"
        tar -xzf "$SCRIPT_DIR/lambda/bin/ngrok.tgz" -C "$SCRIPT_DIR/lambda/bin/"
        rm -f "$SCRIPT_DIR/lambda/bin/ngrok.tgz"
        chmod +x "$SCRIPT_DIR/lambda/bin/ngrok"
        echo "✔ Native ngrok binary installed to lambda/bin/ngrok"
    fi
    NGROK_CMD="$SCRIPT_DIR/lambda/bin/ngrok"
fi

# Final fallback for macOS or other systems
if [ -z "$NGROK_CMD" ]; then
    NGROK_CMD="npx"
    NGROK_ARGS="ngrok"
else
    NGROK_ARGS=""
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
        # Try running ngrok config command
        if $NGROK_CMD $NGROK_ARGS config add-authtoken "$NGROK_TOKEN" 2>/dev/null; then
            echo "✔ ngrok authtoken configured successfully!"
        else
            # Direct write to ngrok config file as fallback
            NGROK_CONFIG_DIR="${HOME}/.config/ngrok"
            mkdir -p "$NGROK_CONFIG_DIR"
            echo "version: \"2\"" > "$NGROK_CONFIG_DIR/ngrok.yml"
            echo "authtoken: $NGROK_TOKEN" >> "$NGROK_CONFIG_DIR/ngrok.yml"
            echo "✔ ngrok authtoken saved to $NGROK_CONFIG_DIR/ngrok.yml"
        fi
    else
        echo "ℹ️  Skipped ngrok token configuration."
    fi
else
    echo "ℹ️  Non-interactive session detected. To configure ngrok token manually, run:"
    echo "   ngrok config add-authtoken <YOUR_AUTHTOKEN>"
fi

chmod +x "$SCRIPT_DIR/start-local.sh" "$SCRIPT_DIR/stop-local.sh"

echo ""
echo "=================================================="
echo "🎉 Setup Complete!"
echo "=================================================="
echo "To start the local server & ngrok tunnel, run:"
echo "   ./start-local.sh"
echo "=================================================="
