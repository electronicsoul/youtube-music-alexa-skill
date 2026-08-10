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

# 4b. Install ASK CLI (Alexa Skills Kit) for auto-deploying endpoints
if ! command -v ask &> /dev/null; then
    echo ""
    echo "📦 Installing ASK CLI (Alexa Skills Kit) for auto-deployment..."
    npm install -g ask-cli 2>/dev/null || true
fi

if command -v ask &> /dev/null; then
    echo "✔ ASK CLI detected: $(ask --version 2>/dev/null || echo 'installed')"
    # Check if already configured
    if ! ask smapi list-skills-for-vendor &> /dev/null; then
        echo ""
        echo "=================================================="
        echo "🔑 ASK CLI Login"
        echo "=================================================="
        echo "This allows auto-deploying the tunnel URL to your Alexa skill."
        echo "A browser window will open for Amazon login."
        echo ""
        if [ -t 0 ]; then
            read -p "👉 Configure ASK CLI now? (y/N): " CONFIGURE_ASK
            if [ "$CONFIGURE_ASK" = "y" ] || [ "$CONFIGURE_ASK" = "Y" ]; then
                ask configure --no-browser 2>/dev/null || ask configure 2>/dev/null || true
            else
                echo "ℹ️  Skipped. Run 'ask configure' later to enable auto-deploy."
            fi
        fi
    else
        echo "✔ ASK CLI already configured"
    fi
else
    echo "ℹ️  ASK CLI not installed. Endpoint URLs must be updated manually in the Alexa Developer Console."
fi

# 5. Check / Install tunnel (ngrok or cloudflared for Android)
mkdir -p "$SCRIPT_DIR/lambda/bin"
ARCH="$(uname -m)"
OS_TYPE="$(uname -s)"
TUNNEL_MODE=""

if [ -d "/data/data/com.termux" ] || [ -n "$TERMUX_VERSION" ]; then
    # Android Termux: ngrok binaries don't work (Bionic linker incompatibility)
    echo "📱 Android Termux environment detected!"
    echo "   ngrok is not compatible with Android. Using cloudflared (Cloudflare Tunnel) instead."
    rm -f "$SCRIPT_DIR/lambda/bin/ngrok" 2>/dev/null || true
    
    if ! command -v cloudflared &> /dev/null; then
        echo "📦 Installing cloudflared via Termux..."
        pkg install cloudflared -y
    fi
    echo "✔ cloudflared detected: $(cloudflared --version 2>/dev/null | head -n 1)"
    TUNNEL_MODE="cloudflared"

else
    echo ""
    echo "=================================================="
    echo "🌐 Choose HTTPS Tunnel Provider"
    echo "=================================================="
    echo "1) cloudflared (Cloudflare Tunnel - Recommended: High Speed, Unlimited, No Rate Limits)"
    echo "2) ngrok (ngrok - Static Domain Support)"
    echo ""
    
    TUNNEL_CHOICE="1"
    if [ -t 0 ]; then
        read -p "👉 Select tunnel provider [1/2] (default: 1 - cloudflared): " USER_INPUT
        if [ "$USER_INPUT" = "2" ]; then
            TUNNEL_CHOICE="2"
        fi
    fi

    if [ "$TUNNEL_CHOICE" = "1" ]; then
        TUNNEL_MODE="cloudflared"
        if ! command -v cloudflared &> /dev/null; then
            if [ "$OS_TYPE" = "Darwin" ]; then
                echo "📦 Installing cloudflared via Homebrew..."
                brew install cloudflared 2>/dev/null || true
            fi
        fi
        if command -v cloudflared &> /dev/null; then
            echo "✔ cloudflared detected: $(cloudflared --version 2>/dev/null | head -n 1)"
        else
            echo "⚠️  cloudflared auto-install failed. Falling back to ngrok..."
            TUNNEL_MODE="ngrok"
        fi
    else
        TUNNEL_MODE="ngrok"
    fi

    if [ "$TUNNEL_MODE" = "ngrok" ]; then
        if command -v ngrok &> /dev/null; then
            echo "✔ ngrok detected: $(ngrok --version 2>/dev/null || echo 'installed')"
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
        fi
    fi
fi

# Save tunnel mode for start-local.sh
echo "$TUNNEL_MODE" > "$SCRIPT_DIR/.tunnel_mode"

# 6. Create logs directory
mkdir -p "$SCRIPT_DIR/logs"

# 7. Tunnel Authtoken Setup (ngrok only)
if [ "$TUNNEL_MODE" = "ngrok" ]; then
    # Determine ngrok binary
    if command -v ngrok &> /dev/null; then
        NGROK_CMD="ngrok"
    elif [ -f "$SCRIPT_DIR/lambda/bin/ngrok" ]; then
        NGROK_CMD="$SCRIPT_DIR/lambda/bin/ngrok"
    else
        NGROK_CMD="npx"
    fi

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
            if [ "$NGROK_CMD" = "npx" ]; then
                # Write directly to config file for npx usage
                NGROK_CONFIG_DIR="${HOME}/.config/ngrok"
                mkdir -p "$NGROK_CONFIG_DIR"
                echo "version: \"2\"" > "$NGROK_CONFIG_DIR/ngrok.yml"
                echo "authtoken: $NGROK_TOKEN" >> "$NGROK_CONFIG_DIR/ngrok.yml"
                echo "✔ ngrok authtoken saved to $NGROK_CONFIG_DIR/ngrok.yml"
            else
                $NGROK_CMD config add-authtoken "$NGROK_TOKEN"
                echo "✔ ngrok authtoken configured successfully!"
            fi
        else
            echo "ℹ️  Skipped ngrok token configuration."
        fi
    else
        echo "ℹ️  Non-interactive session. Run: ngrok config add-authtoken <YOUR_AUTHTOKEN>"
    fi

elif [ "$TUNNEL_MODE" = "cloudflared" ]; then
    echo ""
    echo "=================================================="
    echo "☁️  Cloudflare Tunnel (cloudflared)"
    echo "=================================================="
    echo "✔ cloudflared requires NO account or token for quick tunnels!"
    echo "  A free HTTPS URL will be generated automatically when you run ./start-local.sh"
    echo ""
    echo "⚠️  NOTE: The tunnel URL will change each restart."
    echo "  You will need to update it in the Alexa Developer Console each time."
fi

chmod +x "$SCRIPT_DIR/start-local.sh" "$SCRIPT_DIR/stop-local.sh"

echo ""
echo "=================================================="
echo "🎉 Setup Complete!"
echo "=================================================="
echo "To start the local server & tunnel, run:"
echo "   ./start-local.sh"
echo "=================================================="

