const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { handler, setSocketIO, getStreamUrlForVideoId, setActiveProxyStreamRes, getLastState, getYtDlpPath, getCookiesPath } = require('./index.js');

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

const CLOUD_STATE_URL = 'https://api.restful-api.dev/objects/ff8081819ff5b11001a001901d111f9c';
const https = require('https');

// Diagnostic route
app.get('/api/debug-extract', async (req, res) => {
    const videoId = req.query.v || '7wtfhZwyrcc';
    const { execFile } = require('child_process');
    const ytdlp = getYtDlpPath ? getYtDlpPath() : 'yt-dlp';
    const cookieFile = getCookiesPath ? getCookiesPath() : null;
    
    const results = [];
    const proxies = [
        'http://upwuznhk:9mvyb16wdu1o@31.59.20.176:6754',
        'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684'
    ];
    
    for (const p of proxies) {
        const start = Date.now();
        await new Promise((resolve) => {
            const args = [
                '--force-ipv4', '--geo-bypass',
                '--socket-timeout', '4',
                '--extractor-args', 'youtube:player_client=android_vr,tv_embedded',
                '-g', '-f', 'ba/b'
            ];
            if (cookieFile) args.push('--cookies', cookieFile);
            args.push('--proxy', p, `https://www.youtube.com/watch?v=${videoId}`);

            execFile(ytdlp, args, { env: { ...process.env, TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' }, timeout: 7000 }, (err, stdout, stderr) => {
                results.push({
                    proxy: p.split('@')[1],
                    timeMs: Date.now() - start,
                    error: err ? err.message : null,
                    stderr: stderr ? stderr.trim() : null,
                    stdout: stdout ? stdout.trim().slice(0, 60) : null
                });
                resolve();
            });
        });
    }
    res.json({ binary: ytdlp, cookieFile, videoId, results });
});

// REST State endpoint for Serverless Dashboard polling — authoritative cloud source
app.get('/api/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Fetch authoritative cloud state
    const cloudReq = https.get(CLOUD_STATE_URL, { timeout: 1200 }, (cloudRes) => {
        let d = '';
        cloudRes.on('data', c => d += c);
        cloudRes.on('end', () => {
            try {
                const parsed = JSON.parse(d);
                if (parsed && parsed.data && parsed.data.queue && parsed.data.queue.length > 0) {
                    return res.json(parsed.data);
                }
            } catch (err) {}
            const localState = getLastState ? getLastState() : null;
            res.json(localState || { status: 'IDLE', queue: [], index: 0 });
        });
    });

    cloudReq.on('error', () => {
        const localState = getLastState ? getLastState() : null;
        res.json(localState || { status: 'IDLE', queue: [], index: 0 });
    });

    cloudReq.on('timeout', () => {
        cloudReq.destroy();
        const localState = getLastState ? getLastState() : null;
        res.json(localState || { status: 'IDLE', queue: [], index: 0 });
    });
});

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

// Audio Stream Proxy route for Alexa playback without GoogleVideo 403 Forbidden errors
app.get('/stream/:videoId', (req, res) => {
    const videoId = req.params.videoId;
    console.log(`[Audio Proxy Stream] Alexa requesting audio stream for videoId=${videoId}`);

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Accept-Ranges', 'none');

    const ytdlp = getYtDlpPath ? getYtDlpPath() : 'yt-dlp';
    const cookieFile = getCookiesPath ? getCookiesPath() : null;
    const proxy = 'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684';

    const args = [
        '--no-warnings',
        '--no-part',
        '--buffer-size', '64K',
        '--force-ipv4',
        '--geo-bypass',
        '--socket-timeout', '5',
        '--extractor-args', 'youtube:player_client=android_vr,tv_embedded',
        '-f', '18/ba[ext=m4a]/b[ext=mp4]/best',
        '-o', '-',
        '--proxy', proxy,
        `https://www.youtube.com/watch?v=${videoId}`
    ];
    if (cookieFile) args.push('--cookies', cookieFile);

    const child = spawn(ytdlp, args, {
        env: {
            ...process.env,
            TMPDIR: '/tmp',
            TEMP: '/tmp',
            TMP: '/tmp'
        }
    });

    child.stdout.pipe(res);

    child.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('ERROR')) {
            console.error(`[Audio Proxy Stream] yt-dlp stderr:`, msg.trim());
        }
    });

    child.on('error', (err) => {
        console.error(`[Audio Proxy Stream] Spawn error:`, err.message);
        if (!res.headersSent) res.status(500).end();
    });

    req.on('close', () => {
        try { child.kill('SIGTERM'); } catch (e) {}
    });
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

const checkHttpStream = (urlStr, timeoutMs = 350) => {
    return new Promise((resolve) => {
        const http = require('http');
        try {
            const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
                res.destroy();
                resolve(true); // Valid HTTP stream responded!
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => { resolve(false); });
        } catch (e) {
            resolve(false);
        }
    });
};

const checkPort = (port, host = '127.0.0.1', timeoutMs = 300) => {
    return new Promise((resolve) => {
        const net = require('net');
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, host);
    });
};

const checkStreamSource = async (urlStr, timeoutMs = 400) => {
    if (!urlStr) return false;
    try {
        if (urlStr.startsWith('rtsp://')) {
            const parsed = new URL(urlStr);
            const port = parseInt(parsed.port || '554', 10);
            const host = parsed.hostname || '127.0.0.1';
            return await checkPort(port, host, timeoutMs);
        } else {
            return await checkHttpStream(urlStr, timeoutMs);
        }
    } catch (e) {
        return false;
    }
};

const autoDetectAudioSource = async () => {
    // 1. Check explicitly configured source (via env var or file)
    let explicitSource = process.env.AUDIO_SOURCE_URL;
    if (!explicitSource) {
        try {
            const urlFile = path.join(__dirname, '..', '.audio_source_url');
            if (require('fs').existsSync(urlFile)) {
                explicitSource = require('fs').readFileSync(urlFile, 'utf8').trim();
            }
        } catch (e) {}
    }
    if (explicitSource) {
        const isLive = await checkStreamSource(explicitSource);
        if (isLive) {
            console.log(`[Live Audio] Using verified audio source: ${explicitSource}`);
            return explicitSource;
        } else {
            console.log(`⚠️ [Live Audio] Configured source ${explicitSource} is unreachable or not running.`);
        }
    }

    // 2. Auto-probe common streaming app ports on localhost
    const commonAppPorts = [
        { port: 8554, proto: 'rtsp', path: '/screen', name: 'ScreenStream RTSP' },
        { port: 8080, proto: 'http', path: '', name: 'ScreenStream / AirMusic / LAN Mic' },
        { port: 5000, proto: 'http', path: '', name: 'AirMusic' },
        { port: 8000, proto: 'http', path: '', name: 'Icecast / VLC' },
        { port: 8888, proto: 'http', path: '', name: 'SoundWire' }
    ];

    for (const app of commonAppPorts) {
        const targetUrl = `${app.proto}://127.0.0.1:${app.port}${app.path}`;
        const isLive = await checkStreamSource(targetUrl);
        if (isLive) {
            console.log(`[Live Audio] 🎯 AUTO-DETECTED active streamer (${app.name}) on ${targetUrl}!`);
            return targetUrl;
        }
    }

    return null;
};

const getAudioCaptureArgs = (detectedSourceUrl) => {
    // 1. Use detected or explicit source URL (HTTP or RTSP)
    if (detectedSourceUrl) {
        console.log(`[Live Audio] Streaming from source URL: ${detectedSourceUrl}`);
        const inputArgs = detectedSourceUrl.startsWith('rtsp://') 
            ? ['-rtsp_transport', 'tcp', '-analyzeduration', '2000000', '-probesize', '2000000', '-i', detectedSourceUrl]
            : ['-i', detectedSourceUrl];

        return [
            ...inputArgs,
            '-vn', // Ignore video stream if present (e.g. RTSP screen/camera)
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

    // 3. Android (Termux) Fallback (lavfi chime when no streamer app is active)
    if (process.platform === 'android' || process.env.TERMUX_VERSION) {
        console.log('[Live Audio] ℹ️  No active HTTP streamer detected on localhost (e.g., Screen Stream on port 8080).');
        console.log('[Live Audio] 👉 Start "Screen Stream over HTTP" or your audio broadcaster app on Android to stream your device audio.');
        return [
            '-re', // Enforce real-time 1.0x playback rate for synthetic generator
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:beep_factor=4:sample_rate=48000',
            '-ac', '2',
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

const startLiveAudioCapture = async () => {
    if (idleTimeoutTimer) {
        clearTimeout(idleTimeoutTimer);
        idleTimeoutTimer = null;
        console.log('[Live Audio] Cancelled idle shutdown (listener reconnected)');
    }

    if (liveAudioProcess) return; // Already running

    const detectedUrl = await autoDetectAudioSource();
    if (liveAudioProcess) return; // Double check after async probe
    
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

    liveAudioProcess = spawn(ffmpegPath, getAudioCaptureArgs(detectedUrl), { stdio: ['ignore', 'pipe', 'pipe'] });
    
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

            if (now - lastLogTime >= 5000) { // Clean periodic log every 5s
                const bps = (bytesSinceLastLog * 8) / ((now - lastLogTime) / 1000);
                const sizeKb = (bigChunk.length / 1024).toFixed(1);
                const totalMb = (totalBytesTransferred / (1024 * 1024)).toFixed(2);
                const bufBar = renderProgressBar(ringBufferSize, MAX_RING_BUFFER_BYTES);
                console.log(`📡 [Stream Out] ➔ ${activeListeners} listener(s) | Bandwidth: ${Math.round(bps / 1024)} kbps | Buffer: ${bufBar} (${Math.round(ringBufferSize/1024)}KB) | Total: ${totalMb}MB`);
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

app.get('/live-audio', async (req, res) => {
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
    
    await startLiveAudioCapture();

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

app.get('/', (req, res) => res.redirect('/dashboard'));

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
