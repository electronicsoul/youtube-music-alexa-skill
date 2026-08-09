#!/bin/bash

# ==================================================
# 🔄 Update Alexa Skill Endpoint URL
# ==================================================
# Updates the Alexa skill's HTTPS endpoint to the given URL
# via ASK CLI (Alexa Skills Kit Command Line Interface).
#
# Usage:
#   ./update-endpoint.sh <HTTPS_URL>
#   ./update-endpoint.sh https://xxxx.trycloudflare.com
# ==================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_JSON="$SCRIPT_DIR/skill-package/skill.json"

NEW_URL="$1"

if [ -z "$NEW_URL" ]; then
    echo "❌ Usage: ./update-endpoint.sh <HTTPS_URL>"
    exit 1
fi

# Check ASK CLI
if ! command -v ask &> /dev/null; then
    echo "📦 ASK CLI not found. Installing..."
    npm install -g ask-cli
fi

# Get Skill ID
SKILL_ID_FILE="$SCRIPT_DIR/.skill_id"
if [ -f "$SKILL_ID_FILE" ]; then
    SKILL_ID=$(cat "$SKILL_ID_FILE")
fi

if [ -z "$SKILL_ID" ]; then
    SKILL_ID=$(ask smapi list-skills-for-vendor 2>/dev/null | grep -B5 '"YouTube Music"' | grep '"skillId"' | head -n 1 | grep -o '"amzn1[^"]*"' | tr -d '"')
fi

if [ -z "$SKILL_ID" ]; then
    echo "⚠️  Could not auto-detect Skill ID."
    echo "   Find your Skill ID at: https://developer.amazon.com/alexa/console/ask"
    
    if [ -t 0 ]; then
        read -p "👉 Enter your Alexa Skill ID (amzn1.ask.skill.xxxxx): " INPUT_SKILL_ID
        
        # Ensure it has the correct prefix
        if [[ "$INPUT_SKILL_ID" == amzn1.ask.skill.* ]]; then
            SKILL_ID="$INPUT_SKILL_ID"
        elif [ -n "$INPUT_SKILL_ID" ]; then
            SKILL_ID="amzn1.ask.skill.$INPUT_SKILL_ID"
        fi
        
        if [ -n "$SKILL_ID" ]; then
            echo "$SKILL_ID" > "$SKILL_ID_FILE"
            echo "✔ Saved Skill ID for future deployments."
        fi
    fi
    
    if [ -z "$SKILL_ID" ]; then
        echo "❌ No Skill ID provided. Exiting."
        exit 1
    fi
fi

echo "=================================================="
echo "🔄 Updating Alexa Skill Endpoint"
echo "=================================================="
echo "Skill ID: $SKILL_ID"
echo "New URL:  $NEW_URL"

# Update skill.json locally
if command -v python3 &> /dev/null; then
    python3 -c "
import json, sys
with open('$SKILL_JSON', 'r') as f:
    data = json.load(f)
data['manifest']['apis']['custom']['endpoint']['uri'] = '$NEW_URL'
with open('$SKILL_JSON', 'w') as f:
    json.dump(data, f, indent=2)
print('✔ Updated skill.json locally')
"
elif command -v node &> /dev/null; then
    node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('$SKILL_JSON', 'utf8'));
data.manifest.apis.custom.endpoint.uri = '$NEW_URL';
fs.writeFileSync('$SKILL_JSON', JSON.stringify(data, null, 2));
console.log('✔ Updated skill.json locally');
"
fi

# Deploy via ASK CLI
echo "📡 Deploying updated endpoint to Alexa..."
ask smapi update-skill-manifest \
    --skill-id "$SKILL_ID" \
    --stage development \
    --manifest "$(cat "$SKILL_JSON")"

echo ""
echo "=================================================="
echo "🎉 Alexa Skill endpoint updated successfully!"
echo "👉 $NEW_URL"
echo "=================================================="
