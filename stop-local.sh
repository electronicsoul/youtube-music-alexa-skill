#!/usr/bin/env bash

echo "=================================================="
echo "🛑 Stopping YouTube Music Alexa Skill"
echo "=================================================="

pkill -f "node server.js" 2>/dev/null && echo "✔ Stopped node server.js" || echo "ℹ️  Node server was not running"
pkill -f "cloudflared tunnel" 2>/dev/null && echo "✔ Stopped cloudflared tunnel" || echo "ℹ️  Cloudflare tunnel was not running"
pkill -f "ngrok" 2>/dev/null && echo "✔ Stopped ngrok tunnel" || echo "ℹ️  Ngrok tunnel was not running"

echo "=================================================="
echo "✔ All processes stopped successfully."
echo "=================================================="
