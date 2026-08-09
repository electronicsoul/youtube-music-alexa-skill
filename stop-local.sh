#!/bin/bash

echo "=================================================="
echo "🛑 Stopping YouTube Music Alexa Skill Services"
echo "=================================================="

# Kill node server.js
pkill -f "node server.js" 2>/dev/null && echo "✔ Stopped Node server.js" || echo "ℹ️  Node server.js was not running"

# Kill ngrok
pkill -f "ngrok http 3000" 2>/dev/null && echo "✔ Stopped ngrok tunnel" || echo "ℹ️  ngrok tunnel was not running"

echo "=================================================="
echo "✔ All local Alexa Skill services stopped."
echo "=================================================="
