#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR/lambda" || exit 1

echo "=================================================="
echo "🚀 Starting YouTube Music Alexa Skill Local Server"
echo "=================================================="

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

# Auto-install dependencies if missing
if [ ! -d "$PROJECT_DIR/lambda/node_modules" ]; then
    echo "📦 node_modules not found. Installing dependencies in lambda/..."
    npm install
fi

# Always restart node server to load latest code changes
pkill -9 -f "server.js" 2>/dev/null || true
pkill -9 -f "node server" 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true
sleep 1
echo "Starting node server.js on port 3000..."
> "$LOG_DIR/server.log"
node server.js > "$LOG_DIR/server.log" 2>&1 &
sleep 2
PID_SERVER=$(pgrep -f "node server.js" 2>/dev/null || echo "")

if [ -z "$PID_SERVER" ] || ! kill -0 "$PID_SERVER" 2>/dev/null; then
    echo ""
    echo "❌ ERROR: Node server.js failed to start or crashed on startup!"
    echo "=================================================="
    echo "📜 Server Error Log ($LOG_DIR/server.log):"
    echo "--------------------------------------------------"
    tail -n 25 "$LOG_DIR/server.log" 2>/dev/null || echo "No server log found."
    echo "=================================================="
    exit 1
fi
echo "✔ Node server.js started (PID: $PID_SERVER)"

# Parse optional audio source URL (--source <URL> or -s <URL>)
while [[ $# -gt 0 ]]; do
    case "$1" in
        --source|-s|--audio-source)
            if [ -n "$2" ]; then
                echo "$2" > "$PROJECT_DIR/.audio_source_url"
                export AUDIO_SOURCE_URL="$2"
                echo "✔ Audio source URL configured: $2"
                shift 2
            else
                shift
            fi
            ;;
        --cloudflared|-c)
            TUNNEL_MODE="cloudflared"
            echo "cloudflared" > "$PROJECT_DIR/.tunnel_mode"
            shift
            ;;
        --ngrok|-n)
            TUNNEL_MODE="ngrok"
            echo "ngrok" > "$PROJECT_DIR/.tunnel_mode"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

if [ -z "$TUNNEL_MODE" ]; then
    if [ -f "$PROJECT_DIR/.tunnel_mode" ]; then
        TUNNEL_MODE=$(cat "$PROJECT_DIR/.tunnel_mode")
    else
        TUNNEL_MODE="cloudflared"
    fi
fi

if [ "$TUNNEL_MODE" = "cloudflared" ]; then
    if ! command -v cloudflared &> /dev/null; then
        echo "📦 cloudflared not found. Installing via pkg (Termux)..."
        pkg install cloudflared -y 2>/dev/null || true
    fi

    # Auto-install ffmpeg on Termux if missing
    if [ -n "$PREFIX" ] || [ -d "/data/data/com.termux" ]; then
        if ! command -v ffmpeg &> /dev/null; then
            echo "📦 ffmpeg not found. Installing via pkg (Termux) for pure MP3 Echo streaming..."
            pkg install ffmpeg -y 2>/dev/null || true
        fi
    fi

    # Kill any stale/expired cloudflared process to guarantee a fresh healthy quick tunnel
    pkill -f "cloudflared tunnel" 2>/dev/null || kill -9 $(pgrep -f "cloudflared tunnel" 2>/dev/null) 2>/dev/null || true
    sleep 1
    echo "Starting fresh cloudflared tunnel on port 3000..."
    > "$LOG_DIR/tunnel.log"
    cloudflared tunnel --protocol http2 --url http://localhost:3000 > "$LOG_DIR/tunnel.log" 2>&1 &
    
    # Wait for cloudflared to establish tunnel and print URL
    TUNNEL_URL=""
    for i in {1..20}; do
        sleep 1
        TUNNEL_URL=$(grep -a -o 'https://[a-z0-9\-]*\.trycloudflare\.com' "$LOG_DIR/tunnel.log" 2>/dev/null | head -n 1)
        if [ -n "$TUNNEL_URL" ]; then break; fi
    done

    if [ -z "$TUNNEL_URL" ]; then
        echo ""
        echo "❌ ERROR: cloudflared tunnel failed to establish a connection!"
        echo "=================================================="
        echo "📜 Tunnel Error Log ($LOG_DIR/tunnel.log):"
        echo "--------------------------------------------------"
        tail -n 25 "$LOG_DIR/tunnel.log" 2>/dev/null || echo "No tunnel log found."
        echo "=================================================="
        exit 1
    fi

    if [ -n "$TUNNEL_URL" ]; then
        echo ""
        echo "=================================================="
        echo "🎉 SUCCESS! Your Alexa Skill HTTPS Endpoint is Live:"
        echo "👉 $TUNNEL_URL"
        echo "=================================================="
        
        # Save tunnel URL for the live audio stream intent
        echo "$TUNNEL_URL" > "$PROJECT_DIR/.tunnel_url"
        
        # Auto-deploy the new URL to Alexa skill
        if [ -f "$PROJECT_DIR/update-endpoint.sh" ] && command -v ask &> /dev/null; then
            echo ""
            echo "📡 Auto-deploying endpoint to Alexa skill..."
            bash "$PROJECT_DIR/update-endpoint.sh" "$TUNNEL_URL" || echo "⚠️  Auto-deploy failed. Update manually in Alexa Developer Console."
        else
            echo ""
            echo "Copy the URL above and paste it into Alexa Developer Console:"
            echo "1. Go to https://developer.amazon.com/alexa/console/ask"
            echo "2. Open YouTube Music -> Endpoints -> Select HTTPS"
            echo "3. Paste URL and select 'My development endpoint is a sub-domain...'"
            echo "4. Save Endpoints & Test!"
            echo ""
            echo "💡 TIP: Install ASK CLI to auto-deploy: npm install -g ask-cli && ask configure"
        fi
    else
        echo ""
        echo "⚠️  cloudflared tunnel failed to start."
        if [ -f "$LOG_DIR/tunnel.log" ]; then
            echo "Log details:"
            tail -n 10 "$LOG_DIR/tunnel.log"
        fi
    fi

else
    # ---- NGROK TUNNEL (Mac / Linux Desktop) ----
    STATIC_DOMAIN="broadside-drank-excusably.ngrok-free.dev"

    # Determine ngrok command binary
    if command -v ngrok &> /dev/null; then
        NGROK_BIN="ngrok"
        NGROK_EXTRA=""
    elif [ -f "$PROJECT_DIR/lambda/bin/ngrok" ] && "$PROJECT_DIR/lambda/bin/ngrok" --version &> /dev/null; then
        NGROK_BIN="$PROJECT_DIR/lambda/bin/ngrok"
        NGROK_EXTRA=""
    else
        NGROK_BIN="npx"
        NGROK_EXTRA="ngrok"
    fi

    PID_NGROK=$(pgrep -f "ngrok http 3000")
    if [ -z "$PID_NGROK" ]; then
        echo "Starting ngrok tunnel on port 3000..."
        if [ -n "$STATIC_DOMAIN" ]; then
            $NGROK_BIN $NGROK_EXTRA http 3000 --url="$STATIC_DOMAIN" > "$LOG_DIR/tunnel.log" 2>&1 &
        else
            $NGROK_BIN $NGROK_EXTRA http 3000 > "$LOG_DIR/tunnel.log" 2>&1 &
        fi
        
        for i in {1..8}; do
            sleep 1
            NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok[^"]*' | head -n 1)
            if [ -n "$NGROK_URL" ]; then break; fi
        done
    else
        NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok[^"]*' | head -n 1)
    fi

    if [ -n "$NGROK_URL" ]; then
        echo ""
        echo "=================================================="
        echo "🎉 SUCCESS! Your Alexa Skill HTTPS Endpoint is Live:"
        echo "👉 $NGROK_URL"
        echo "=================================================="
        
        # Save tunnel URL for the live audio stream intent
        echo "$NGROK_URL" > "$PROJECT_DIR/.tunnel_url"
        
        echo ""
        echo "Copy the URL above and paste it into Alexa Developer Console:"
        echo "1. Go to https://developer.amazon.com/alexa/console/ask"
        echo "2. Open YouTube Music -> Endpoints -> Select HTTPS"
        echo "3. Paste URL and select 'My development endpoint is a sub-domain...'"
        echo "4. Save Endpoints & Test!"
    else
        echo ""
        echo "⚠️  ngrok tunnel failed to start or needs authentication."
        if [ -f "$LOG_DIR/tunnel.log" ]; then
            echo "Log details:"
            tail -n 10 "$LOG_DIR/tunnel.log"
        fi
        echo ""
        echo "👉 To fix, add your ngrok authtoken:"
        echo "   $NGROK_BIN $NGROK_EXTRA config add-authtoken <YOUR_AUTHTOKEN>"
    fi
fi

