const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { handler, setSocketIO, getStreamUrlForVideoId, setActiveProxyStreamRes } = require('./index.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

if (setSocketIO) setSocketIO(io);

app.use(express.json());

// Serve dashboard UI (no caching)
app.use('/dashboard', express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
}));

// Alexa Skill handler — only intercept POST to root
app.post('/', (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).send('Bad Request: Missing body');
    }

    handler(req.body, null, (err, responsePayload) => {
        if (err) {
            console.error('Skill Execution Error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(responsePayload);
    });
});

// Audio Stream Proxy route for click-to-seek support
app.get('/stream/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    const offsetSec = parseInt(req.query.offset || '0', 10);
    console.log(`HTTP Audio Proxy request for videoId=${videoId}, offset=${offsetSec}s`);

    try {
        const directUrl = await getStreamUrlForVideoId(videoId);
        
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        if (setActiveProxyStreamRes) {
            setActiveProxyStreamRes(res);
        }

        const ffmpegArgs = [
            '-ss', String(offsetSec),
            '-i', directUrl,
            '-vn',
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-f', 'mp3',
            'pipe:1'
        ];

        const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', ffmpegArgs);

        ffmpeg.stdout.pipe(res);

        req.on('close', () => {
            console.log(`Client closed connection for stream ${videoId}`);
            try { ffmpeg.kill('SIGKILL'); } catch(e) {}
        });

    } catch (err) {
        console.error('Audio stream proxy error:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Stream error: ' + err.message);
        }
    }
});

// Live Mac Audio Stream - captures system audio via BlackHole and streams as MP3
let liveAudioProcess = null;
let liveAudioClients = new Set();
let ringBuffer = [];
let ringBufferSize = 0;
const MAX_RING_BUFFER_BYTES = 192 * 1024; // ~6 seconds of 256kbps MP3 data
let idleTimeoutTimer = null;

const getFFmpegPath = () => {
    if (process.platform === 'darwin') {
        const { existsSync } = require('fs');
        if (existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
        if (existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
    }
    return 'ffmpeg';
};

const startLiveAudioCapture = () => {
    if (idleTimeoutTimer) {
        clearTimeout(idleTimeoutTimer);
        idleTimeoutTimer = null;
        console.log('[Live Audio] Cancelled idle shutdown (listener reconnected)');
    }

    if (liveAudioProcess) return; // Already running
    
    const ffmpegPath = getFFmpegPath();
    console.log('[Live Audio] Starting High-Quality (256kbps) FFmpeg capture from BlackHole 2ch...');
    
    ringBuffer = [];
    ringBufferSize = 0;

    liveAudioProcess = spawn(ffmpegPath, [
        '-thread_queue_size', '4096',
        '-f', 'avfoundation',
        '-i', ':BlackHole 2ch',
        '-ac', '2',
        '-ar', '48000',
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'libmp3lame',
        '-b:a', '256k',
        '-write_id3v1', '0',
        '-id3v2_version', '0',
        '-f', 'mp3',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    
    liveAudioProcess.stdout.on('data', (chunk) => {
        // Add chunk to ring buffer for instant pre-buffering on new connections
        ringBuffer.push(chunk);
        ringBufferSize += chunk.length;

        while (ringBufferSize > MAX_RING_BUFFER_BYTES && ringBuffer.length > 0) {
            const removed = ringBuffer.shift();
            ringBufferSize -= removed.length;
        }

        // Broadcast chunk to all connected clients
        for (const client of liveAudioClients) {
            try {
                client.write(chunk);
            } catch (e) {
                liveAudioClients.delete(client);
            }
        }
    });
    
    liveAudioProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('Error')) {
            console.error('[Live Audio] FFmpeg error:', msg.trim());
        }
    });
    
    liveAudioProcess.on('close', (code) => {
        console.log(`[Live Audio] FFmpeg process exited with code ${code}`);
        liveAudioProcess = null;
        ringBuffer = [];
        ringBufferSize = 0;
        for (const client of liveAudioClients) {
            try { client.end(); } catch (e) {}
        }
        liveAudioClients.clear();
    });
    
    liveAudioProcess.on('error', (err) => {
        console.error('[Live Audio] FFmpeg spawn error:', err.message);
        liveAudioProcess = null;
    });
};

app.get('/live-audio', (req, res) => {
    console.log('[Live Audio] New listener connected');
    
    if (process.platform !== 'darwin') {
        return res.status(400).json({ error: 'Live audio streaming is only available on macOS with BlackHole installed' });
    }
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    startLiveAudioCapture();

    // Immediately send ring buffer so Alexa fills its buffer instantly and starts playing without silence
    if (ringBuffer.length > 0) {
        for (const chunk of ringBuffer) {
            try {
                res.write(chunk);
            } catch (e) {
                return;
            }
        }
    }
    
    liveAudioClients.add(res);
    
    req.on('close', () => {
        console.log('[Live Audio] Listener disconnected');
        liveAudioClients.delete(res);
        
        // Use a 30-second grace period before shutting down FFmpeg
        // This prevents FFmpeg from restarting when Alexa re-connects or checks stream headers
        if (liveAudioClients.size === 0 && liveAudioProcess && !idleTimeoutTimer) {
            console.log('[Live Audio] No active listeners. Waiting 30s before stopping FFmpeg...');
            idleTimeoutTimer = setTimeout(() => {
                if (liveAudioClients.size === 0 && liveAudioProcess) {
                    console.log('[Live Audio] Grace period elapsed. Stopping FFmpeg capture.');
                    try { liveAudioProcess.kill('SIGTERM'); } catch (e) {}
                    liveAudioProcess = null;
                }
                idleTimeoutTimer = null;
            }, 30000);
        }
    });
});

app.get('/live-audio/status', (req, res) => {
    res.json({
        active: liveAudioProcess !== null,
        listeners: liveAudioClients.size,
        bufferKb: Math.round(ringBufferSize / 1024),
        platform: process.platform
    });
});

app.get('/', (req, res) => res.send('Alexa Skill Endpoint Active'));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`\n--- YouTube Music Alexa Skill Endpoint Running ---`);
        console.log(`Listening on http://localhost:${PORT}`);
        console.log(`Live Dashboard: http://localhost:${PORT}/dashboard`);
    });
}

module.exports = app;
