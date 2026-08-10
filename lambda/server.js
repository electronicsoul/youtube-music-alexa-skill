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

const getFFmpegPath = () => {
    if (process.platform === 'darwin') {
        const { existsSync } = require('fs');
        if (existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
        if (existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
    }
    return 'ffmpeg';
};

const startLiveAudioCapture = () => {
    if (liveAudioProcess) return; // Already running
    
    const ffmpegPath = getFFmpegPath();
    console.log('[Live Audio] Starting FFmpeg capture from BlackHole 2ch...');
    
    liveAudioProcess = spawn(ffmpegPath, [
        '-f', 'avfoundation',
        '-i', ':BlackHole 2ch',
        '-ac', '2',
        '-ar', '44100',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-f', 'mp3',
        '-fflags', '+nobuffer',
        '-flags', '+low_delay',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    
    liveAudioProcess.stdout.on('data', (chunk) => {
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
        // Close all client connections
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
    
    // Check if running on macOS
    if (process.platform !== 'darwin') {
        return res.status(400).json({ error: 'Live audio streaming is only available on macOS with BlackHole installed' });
    }
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    // Start FFmpeg if not already running
    startLiveAudioCapture();
    
    liveAudioClients.add(res);
    
    req.on('close', () => {
        console.log('[Live Audio] Listener disconnected');
        liveAudioClients.delete(res);
        // Stop FFmpeg if no more listeners
        if (liveAudioClients.size === 0 && liveAudioProcess) {
            console.log('[Live Audio] No more listeners, stopping FFmpeg');
            try { liveAudioProcess.kill('SIGTERM'); } catch (e) {}
            liveAudioProcess = null;
        }
    });
});

app.get('/live-audio/status', (req, res) => {
    res.json({
        active: liveAudioProcess !== null,
        listeners: liveAudioClients.size,
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
