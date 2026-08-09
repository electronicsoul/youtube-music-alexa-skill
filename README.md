# 🎵 YouTube Music & Multi-Source Alexa Skill

An advanced, feature-rich Alexa Skill that streams audio directly from **YouTube & YouTube Music** to your Amazon Echo devices. Includes **Smart Radio Auto-Queueing**, **Multi-Source Platform Emulation (Spotify, JioSaavn, Apple Music)**, and a **Real-Time Glassmorphic Web Dashboard**.

---

## 🌟 Key Features

- 📻 **Smart Radio Station Algorithm**: When you play a track, the skill automatically generates a 20-song endless radio queue based on YouTube Music's native *"Up Next"* recommendation engine.
- 🎧 **Multi-Source Curation Emulation**: Play music from your favorite service by voice! Simply specify Spotify, JioSaavn, or Apple Music in your voice request (e.g., *"play Starboy on Spotify"*).
- 📊 **Real-Time Visual Dashboard**: Open `http://localhost:3000/dashboard` to monitor live playback status, view high-res album art, track progress, and view the 20-song upcoming queue.
- ⏩ **Native Audio Controls**: Full support for standard Alexa voice commands (`"Alexa, next"`, `"Alexa, previous"`, `"Alexa, pause"`, `"Alexa, fast forward 30 seconds"`).
- ⚡ **Zero AWS Infrastructure Required**: Run locally with a single script using `ngrok` HTTPS tunneling.

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js**: `v16.x` or higher
- **npm**: `v8.x` or higher
- **yt-dlp** (Optional - `setup.sh` will auto-download a standalone binary if missing)

---

### Step 1: Clone & Run Setup Script
```bash
git clone https://github.com/akhilerm/youtube-music-alexa-skill.git
cd youtube-music-alexa-skill
./setup.sh
```
`setup.sh` will verify Node.js, install all npm packages in `lambda/`, and ensure `yt-dlp` is available.

---

### Step 2: Start the Local Server & Ngrok Tunnel
```bash
./start-local.sh
```
This script starts:
1. The **Node.js Express backend & WebSocket server** on port `3000`.
2. An **ngrok HTTPS tunnel** mapping port `3000` to a public URL.

You will see output like:
```text
==================================================
🎉 SUCCESS! Your Alexa Skill HTTPS Endpoint is Live:
👉 https://xxxx-xxxx-xxxx.ngrok-free.dev
==================================================
```

---

### Step 3: Configure Alexa Developer Console (One-Time Setup)

1. Go to the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask).
2. Create a new Skill (or open your existing YouTube Skill):
   - **Name**: `YouTube`
   - **Model**: `Custom`
   - **Method**: `Provision your own`
3. In **Interaction Model -> JSON Editor**, upload or paste `skill-package/interactionModels/custom/en-US.json`. Click **Save Model** and **Build Model**.
4. In **Endpoints**:
   - Select **HTTPS**.
   - Paste your ngrok HTTPS URL (e.g. `https://xxxx-xxxx-xxxx.ngrok-free.dev`).
   - In the SSL certificate dropdown, select:
     `My development endpoint is a sub-domain of a domain that has wildcard certificates from a certificate authority`.
   - Click **Save Endpoints**.

---

## 🗣️ Voice Commands Reference

| Action | What to say to Alexa |
| :--- | :--- |
| **Play a song** | *"Alexa, ask youtube to play Shape of You"* |
| **Play from Spotify** | *"Alexa, ask youtube to play Blinding Lights on Spotify"* |
| **Play from JioSaavn** | *"Alexa, ask youtube to play Arijit Singh on JioSaavn"* |
| **Next Track** | *"Alexa, next"* |
| **Previous Track** | *"Alexa, previous"* |
| **Fast Forward** | *"Alexa, ask youtube to fast forward 30 seconds"* |
| **Rewind** | *"Alexa, ask youtube to rewind 15 seconds"* |
| **Pause / Stop** | *"Alexa, pause"* or *"Alexa, stop"* |

---

## 🖥️ Live Web Dashboard

Open `http://localhost:3000/dashboard` in your browser.

- View **Now Playing** artwork, title, and live progress bar.
- Monitor the **Up Next Queue** (up to 20 songs).
- Side-by-side dark glassmorphic responsive layout.

---

## 📁 Repository Structure

```text
├── README.md                 # Documentation
├── setup.sh                  # One-click installation script
├── start-local.sh            # Starts local Express server + ngrok tunnel
├── stop-local.sh             # Stops background local services
├── lambda/
│   ├── index.js              # Alexa Skill Handler & Smart Radio logic
│   ├── server.js             # Express & Socket.IO server
│   ├── package.json          # Node dependencies
│   └── public/
│       └── index.html        # Live Dashboard UI
└── skill-package/
    └── interactionModels/
        └── custom/en-US.json # Alexa Intent & Utterance schema
```

---

## 🛑 Stopping the Server

To stop the background server and tunnel at any time:
```bash
./stop-local.sh
```

---

## 📜 License
[MIT](LICENSE.txt)
