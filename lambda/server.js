const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { handler, setSocketIO, getStreamUrlForVideoId, setActiveProxyStreamRes } = require('./index.js');

process.on('uncaughtException', (err) => {
    console.error('❌ [Server Crash] Uncaught Exception:', err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [Server Warning] Unhandled Rejection:', reason);
});

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
const MAX_RING_BUFFER_BYTES = 32 * 1024; // 32KB buffer (~1 second ultra-low latency buffer)
const CHUNK_SIZE_KB = parseInt(process.env.CHUNK_SIZE_KB || '4', 10);
const MIN_BATCH_BYTES = CHUNK_SIZE_KB * 1024; // 4KB micro-chunks (~125ms of audio)
let pendingChunks = [];
let pendingBatchSize = 0;
let totalBytesTransferred = 0;
let idleTimeoutTimer = null;

const renderProgressBar = (current, total) => {
    const width = 12;
    const ratio = Math.min(1, current / total);
    const filled = Math.round(width * ratio);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
};

const getFFmpegPath = () => {
    if (process.platform === 'darwin') {
        const { existsSync } = require('fs');
        if (existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
        if (existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
    }
    return 'ffmpeg';
};

const getAudioCaptureArgs = () => {
    // 1. Custom, persisted, or default HTTP audio stream URL
    let audioSource = process.env.AUDIO_SOURCE_URL;
    if (!audioSource) {
        try {
            const path = require('path');
            const fs = require('fs');
            const urlFile = path.join(__dirname, '..', '.audio_source_url');
            if (fs.existsSync(urlFile)) {
                audioSource = fs.readFileSync(urlFile, 'utf8').trim();
            }
        } catch (e) {}
    }

    // Default stream URL for Android / Termux helper apps (defaults to http://127.0.0.1:8080)
    if (!audioSource && (process.platform === 'android' || process.env.TERMUX_VERSION)) {
        audioSource = 'http://127.0.0.1:8080';
    }

    if (audioSource) {
        console.log(`[Live Audio] Streaming from audio source URL: ${audioSource}`);
        return [
            '-i', audioSource,
            '-ac', '2',
            '-ar', '48000',
            '-af', 'volume=0.9',
            '-c:a', 'libmp3lame',
            '-b:a', '128k',
            '-fflags', '+nobuffer+flush_packets',
            '-flags', '+low_delay',
            '-write_id3v1', '0',
            '-id3v2_version', '0',
            '-f', 'mp3',
            'pipe:1'
        ];
    }

    // 2. macOS System Audio via BlackHole
    if (process.platform === 'darwin') {
        return [
            '-thread_queue_size', '4096',
            '-f', 'avfoundation',
            '-i', ':BlackHole 2ch',
            '-ac', '2',
            '-ar', '48000',
            '-af', 'volume=0.9',
            '-c:a', 'libmp3lame',
            '-b:a', '128k',
            '-fflags', '+nobuffer+flush_packets',
            '-flags', '+low_delay',
            '-write_id3v1', '0',
            '-id3v2_version', '0',
            '-f', 'mp3',
            'pipe:1'
        ];
    }

    // 3. Android (Termux) OpenSL ES
    if (process.platform === 'android' || process.env.TERMUX_VERSION) {
        return [
            '-f', 'opensles',
            '-i', 'default',
            '-ac', '2',
            '-ar', '48000',
            '-af', 'volume=0.9',
            '-c:a', 'libmp3lame',
            '-b:a', '128k',
            '-fflags', '+nobuffer+flush_packets',
            '-flags', '+low_delay',
            '-write_id3v1', '0',
            '-id3v2_version', '0',
            '-f', 'mp3',
            'pipe:1'
        ];
    }

    // 4. Linux PulseAudio / ALSA
    return [
        '-f', 'pulse',
        '-i', 'default',
        '-ac', '2',
        '-ar', '48000',
        '-af', 'volume=0.9',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-fflags', '+nobuffer+flush_packets',
        '-flags', '+low_delay',
        '-write_id3v1', '0',
        '-id3v2_version', '0',
        '-f', 'mp3',
        'pipe:1'
    ];
};

const startLiveAudioCapture = () => {
    if (idleTimeoutTimer) {
        clearTimeout(idleTimeoutTimer);
        idleTimeoutTimer = null;
        console.log('[Live Audio] Cancelled idle shutdown (listener reconnected)');
    }

    if (liveAudioProcess) return; // Already running
    
    const ffmpegPath = getFFmpegPath();
    console.log(`[Live Audio] Starting Live Audio Capture (${process.platform}) | Chunk Size: ${CHUNK_SIZE_KB}KB`);
    
    ringBuffer = [];
    ringBufferSize = 0;
    pendingChunks = [];
    pendingBatchSize = 0;
    totalBytesTransferred = 0;
    
    let lastChunkTime = 0;
    let bytesSinceLastLog = 0;
    let lastLogTime = Date.now();
    let outputBatchCount = 0;

    liveAudioProcess = spawn(ffmpegPath, getAudioCaptureArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });
    
    liveAudioProcess.stdout.on('data', (chunk) => {
        const now = Date.now();
        lastChunkTime = now;
        
        bytesSinceLastLog += chunk.length;

        // Accumulate chunks into larger batch for network transmission
        pendingChunks.push(chunk);
        pendingBatchSize += chunk.length;

        if (pendingBatchSize >= MIN_BATCH_BYTES) {
            const bigChunk = Buffer.concat(pendingChunks);
            pendingChunks = [];
            pendingBatchSize = 0;
            outputBatchCount++;
            totalBytesTransferred += bigChunk.length;

            // Add bigChunk to ring buffer for instant pre-buffering on new connections (no duplicates!)
            ringBuffer.push(bigChunk);
            ringBufferSize += bigChunk.length;

            while (ringBufferSize > MAX_RING_BUFFER_BYTES && ringBuffer.length > 0) {
                const removed = ringBuffer.shift();
                ringBufferSize -= removed.length;
            }

            const sizeKb = (bigChunk.length / 1024).toFixed(1);
            const totalMb = (totalBytesTransferred / (1024 * 1024)).toFixed(2);
            const bufBar = renderProgressBar(ringBufferSize, MAX_RING_BUFFER_BYTES);

            // Broadcast aggregated chunk to all connected clients
            const writeStart = process.hrtime();
            let activeListeners = 0;
            for (const client of Array.from(liveAudioClients)) {
                if (client.destroyed || client.writableEnded || !client.writable) {
                    liveAudioClients.delete(client);
                    continue;
                }
                try {
                    const ok = client.write(bigChunk);
                    if (!ok && client.destroyed) {
                        liveAudioClients.delete(client);
                        continue;
                    }
                    activeListeners++;
                } catch (e) {
                    liveAudioClients.delete(client);
                }
            }
            const writeEnd = process.hrtime(writeStart);
            const writeMs = ((writeEnd[0] * 1000) + (writeEnd[1] / 1000000)).toFixed(1);

            console.log(`📡 [Stream Out] 📦 ${sizeKb}KB ➔ ${activeListeners} listener(s) (${writeMs}ms) | Buffer: ${bufBar} (${Math.round(ringBufferSize/1024)}KB) | Total: ${totalMb}MB`);

            if (now - lastLogTime >= 5000) { // Periodic summary log every 5s
                const bps = (bytesSinceLastLog * 8) / ((now - lastLogTime) / 1000);
                console.log(`📊 [Stream Summary] Config: ${CHUNK_SIZE_KB}KB chunks | Bandwidth: ${Math.round(bps / 1024)} kbps | ${outputBatchCount} chunks sent in last 5s`);
                bytesSinceLastLog = 0;
                outputBatchCount = 0;
                lastLogTime = now;
            }
        }
    });
    
    liveAudioProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
            console.log('[Live Audio] FFmpeg info:', msg);
        }
    });
    
    liveAudioProcess.on('close', (code) => {
        console.log(`[Live Audio] FFmpeg process exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error(`⚠️ [Live Audio] FFmpeg terminated with non-zero exit code: ${code}`);
        }
        liveAudioProcess = null;
        ringBuffer = [];
        ringBufferSize = 0;
        pendingChunks = [];
        pendingBatchSize = 0;
        for (const client of liveAudioClients) {
            try { client.end(); } catch (e) {}
        }
        liveAudioClients.clear();
    });
    
    liveAudioProcess.on('error', (err) => {
        console.error('❌ [Live Audio] FFmpeg spawn error:', err.message);
        if (err.code === 'ENOENT') {
            console.error(`👉 Hint: FFmpeg binary was not found at '${ffmpegPath}'.\n   Install it via: 'pkg install ffmpeg -y' (Termux) or 'brew install ffmpeg' (macOS).`);
        }
        liveAudioProcess = null;
    });
};

app.get('/live-audio', (req, res) => {
    if (req.method === 'HEAD') {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'none');
        return res.status(200).end();
    }

    console.log(`[Live Audio] New listener connected (${process.platform})`);
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    
    startLiveAudioCapture();

    // Immediately send ring buffer so Alexa fills its buffer instantly and starts playing without silence
    if (ringBuffer.length > 0) {
        console.log(`[Live Audio] Sending ring buffer of size ${Math.round(ringBufferSize/1024)}KB to new listener`);
        const prebufferStart = process.hrtime();
        for (const chunk of ringBuffer) {
            try {
                res.write(chunk);
            } catch (e) {
                console.log(`[Live Audio] Failed to write ring buffer to new listener`);
                return;
            }
        }
        const prebufferEnd = process.hrtime(prebufferStart);
        const prebufferMs = (prebufferEnd[0] * 1000) + (prebufferEnd[1] / 1000000);
        console.log(`[Live Audio] Pre-buffering took ${prebufferMs.toFixed(2)}ms`);
    }
    
    liveAudioClients.add(res);
    
    const removeListener = () => {
        if (liveAudioClients.has(res)) {
            console.log('[Live Audio] Listener disconnected');
            liveAudioClients.delete(res);
            
            // Use a 30-second grace period before shutting down FFmpeg
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
        }
    };

    req.on('close', removeListener);
    req.on('end', removeListener);
    res.on('close', removeListener);
    res.on('finish', removeListener);
    res.on('error', removeListener);
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
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use by another process! Run ./stop-local.sh to free the port.`);
        } else {
            console.error(`❌ Server error:`, err);
        }
    });

    server.listen(PORT, () => {
        console.log(`\n--- YouTube Music Alexa Skill Endpoint Running ---`);
        console.log(`Listening on http://localhost:${PORT}`);
        console.log(`Live Dashboard: http://localhost:${PORT}/dashboard`);
    });
}

module.exports = app;
