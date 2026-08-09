#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR/lambda" || exit 1

echo "=================================================="
echo "🚀 Starting YouTube Music Alexa Skill Local Server"
echo "=================================================="

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

# Check if node server.js is already running
PID_SERVER=$(pgrep -f "node server.js")
if [ -n "$PID_SERVER" ]; then
    echo "✔ Node server.js is already running (PID: $PID_SERVER)"
else
    echo "Starting node server.js on port 3000..."
    node server.js > "$LOG_DIR/server.log" 2>&1 &
    sleep 2
    PID_SERVER=$(pgrep -f "node server.js")
    echo "✔ Node server.js started (PID: $PID_SERVER)"
fi

# Static ngrok domain (prevents URL changing on restarts)
STATIC_DOMAIN="broadside-drank-excusably.ngrok-free.dev"

# Check if ngrok is already running
PID_NGROK=$(pgrep -f "ngrok http 3000")
if [ -z "$PID_NGROK" ]; then
    echo "Starting ngrok tunnel on port 3000..."
    if [ -n "$STATIC_DOMAIN" ]; then
        npx ngrok http 3000 --url="$STATIC_DOMAIN" > "$LOG_DIR/ngrok.log" 2>&1 &
    else
        npx ngrok http 3000 > "$LOG_DIR/ngrok.log" 2>&1 &
    fi
    sleep 3
fi

# Get ngrok HTTPS URL from ngrok API
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok[^"]*' | head -n 1)

if [ -n "$NGROK_URL" ]; then
    echo ""
    echo "=================================================="
    echo "🎉 SUCCESS! Your Alexa Skill HTTPS Endpoint is Live:"
    echo "👉 $NGROK_URL"
    echo "=================================================="
    echo ""
    echo "Copy the URL above and paste it into Alexa Developer Console:"
    echo "1. Go to https://developer.amazon.com/alexa/console/ask"
    echo "2. Open YouTube Music -> Endpoints -> Select HTTPS"
    echo "3. Paste URL and select 'My development endpoint is a sub-domain...'"
    echo "4. Save Endpoints & Test!"
else
    echo "⚠️  ngrok tunnel starting... If this is your first time using ngrok, add your authtoken:"
    echo "   npx ngrok config add-authtoken <YOUR_AUTHTOKEN>"
    echo "   Check logs at $LOG_DIR/ngrok.log"
fi
