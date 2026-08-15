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
// Fast resolution API for Cloudflare Worker streaming proxy
app.get('/api/resolve-stream', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId v' });
    try {
        const streamMeta = await getStreamUrlForVideoId(videoId);
        const streamUrl = typeof streamMeta === 'string' ? streamMeta : streamMeta.streamUrl;
        const proxyUsed = streamMeta.proxyUsed || null;
        res.json({ videoId, streamUrl, proxyUsed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Diagnostic endpoint to test yt-dlp binary directly
app.get('/api/debug-ytdlp', (req, res) => {
    const videoId = req.query.v || 'Rif-RTvmmss';
    const proxyUrl = req.query.proxy || 'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684';
    const ytdlp = getYtDlpPath ? getYtDlpPath() : 'yt-dlp';
    const { execFile } = require('child_process');
    execFile(ytdlp, ['--version'], (err, stdout, stderr) => {
        const ver = stdout ? stdout.trim() : (err ? err.message : 'unknown');
        const args = [
            '--no-warnings',
            '--force-ipv4',
            '--no-check-certificates',
            '--socket-timeout', '6',
            '--extractor-args', 'youtube:player_client=android_vr,android',
            '-g',
            '-f', 'ba/b'
        ];
        if (proxyUrl && proxyUrl !== 'none') {
            args.push('--proxy', proxyUrl);
        }
        args.push(`https://www.youtube.com/watch?v=${videoId}`);

        execFile(ytdlp, args, { timeout: 10000 }, (e2, out2, err2) => {
            res.json({
                binary: ytdlp,
                version: ver,
                proxy: proxyUrl,
                error: e2 ? e2.message : null,
                stdout: out2 ? out2.trim().slice(0, 100) : null,
                stderr: err2 ? err2.trim() : null
            });
        });
    });
});

// REST State endpoint for Serverless Dashboard polling — authoritative newest state
app.get('/api/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let localState = getLastState ? getLastState() : null;
    
    // Check disk cache
    try {
        const fs = require('fs');
        if (fs.existsSync('/tmp/alexa_state.json')) {
            const diskState = JSON.parse(fs.readFileSync('/tmp/alexa_state.json', 'utf8'));
            if (diskState && (!localState || (diskState.timestamp && diskState.timestamp > (localState.timestamp || 0)))) {
                localState = diskState;
            }
        }
    } catch (e) {}

    // Fetch authoritative cloud state
    const cloudReq = https.get(CLOUD_STATE_URL, { timeout: 2500 }, (cloudRes) => {
        let d = '';
        cloudRes.on('data', c => d += c);
        cloudRes.on('end', () => {
            try {
                const parsed = JSON.parse(d);
                const cloudState = parsed && parsed.data && parsed.data.queue && parsed.data.queue.length > 0 ? parsed.data : null;
                if (cloudState && localState) {
                    const cloudTs = cloudState.timestamp || 0;
                    const localTs = localState.timestamp || 0;
                    return res.json(localTs > cloudTs ? localState : cloudState);
                } else if (cloudState) {
                    return res.json(cloudState);
                }
            } catch (err) {}
            res.json(localState || { status: 'IDLE', queue: [], index: 0 });
        });
    });

    cloudReq.on('error', () => {
        res.json(localState || { status: 'IDLE', queue: [], index: 0 });
    });

    cloudReq.on('timeout', () => {
        cloudReq.destroy();
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

const { HttpsProxyAgent } = require('https-proxy-agent');
const streamUrlCache = new Map();
const metaCache = new Map();

// Helper to get total file size and stream URL
async function getVideoMeta(videoId) {
    let meta = metaCache.get(videoId);
    if (meta && (Date.now() - meta.timestamp < 3600000)) {
        return meta;
    }
    let directUrl = streamUrlCache.get(videoId);
    if (!directUrl) {
        directUrl = await getStreamUrlForVideoId(videoId);
        if (directUrl) streamUrlCache.set(videoId, directUrl);
    }
    const proxy = 'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684';
    const agent = new HttpsProxyAgent(proxy);
    
    // Probe initial 100 bytes to determine total size
    const size = await new Promise((resolve) => {
        const req = https.get(directUrl, {
            agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                'Range': 'bytes=0-100'
            }
        }, (res) => {
            const range = res.headers['content-range'];
            if (range) {
                const total = parseInt(range.split('/')[1]);
                if (total > 0) return resolve(total);
            }
            const len = parseInt(res.headers['content-length']);
            resolve(len || 9000000);
        });
        req.on('error', () => resolve(9000000));
    });

    meta = { directUrl, totalBytes: size, timestamp: Date.now() };
    metaCache.set(videoId, meta);
    return meta;
}

// HLS Master Playlist for videoId
app.get('/hls/:videoId/playlist.m3u8', async (req, res) => {
    const videoId = req.params.videoId;
    console.log(`[HLS Audio] Generating M3U8 playlist for videoId=${videoId}`);
    try {
        const { totalBytes } = await getVideoMeta(videoId);
        const segmentBytes = 250000; // ~250KB per segment (~10 seconds of 200kbps audio)
        const totalSegments = Math.ceil(totalBytes / segmentBytes);
        const segmentDuration = 10.0;

        let m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
        for (let i = 0; i < totalSegments; i++) {
            m3u8 += `#EXTINF:${segmentDuration.toFixed(1)},\nseg_${i}.m4a\n`;
        }
        m3u8 += `#EXT-X-ENDLIST\n`;

        res.setHeader('Content-Type', 'application/x-mpegURL');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.send(m3u8);
    } catch (e) {
        console.error('[HLS Playlist Error]', e.message);
        res.status(500).send('Error generating playlist');
    }
});

// HLS Segment for videoId
app.get('/hls/:videoId/seg_:index.m4a', async (req, res) => {
    const { videoId, index } = req.params;
    const segIdx = parseInt(index);
    const segmentBytes = 250000;
    const startByte = segIdx * segmentBytes;
    
    try {
        const { directUrl, totalBytes } = await getVideoMeta(videoId);
        const endByte = Math.min(totalBytes - 1, startByte + segmentBytes - 1);
        const proxy = 'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684';
        const agent = new HttpsProxyAgent(proxy);

        const forwardHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
            'Sec-Fetch-Mode': 'navigate',
            'Range': `bytes=${startByte}-${endByte}`
        };

        https.get(directUrl, { agent, headers: forwardHeaders }, (audioRes) => {
            res.status(200);
            res.setHeader('Content-Type', 'audio/mp4');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            audioRes.pipe(res);
        }).on('error', (err) => {
            res.status(502).end();
        });
    } catch (e) {
        res.status(500).end();
    }
});

// Audio Stream Proxy route for Alexa playback with instant startup and Range support
app.get('/stream/:videoId', async (req, res) => {
    const videoId = req.params.videoId;
    console.log(`[Audio Proxy Stream] Alexa requesting audio stream for videoId=${videoId}`);

    try {
        const fetchStream = async (isRetry = false) => {
            let cached = streamUrlCache.get(videoId);
            let streamMeta = cached && (Date.now() - cached.timestamp < 900000) ? cached.meta : null;
            if (!streamMeta || isRetry) {
                streamUrlCache.delete(videoId);
                streamMeta = await getStreamUrlForVideoId(videoId);
                if (streamMeta) streamUrlCache.set(videoId, { meta: streamMeta, timestamp: Date.now() });
            }

            const directUrl = typeof streamMeta === 'string' ? streamMeta : (streamMeta.streamUrl || streamMeta);
            const agent = streamMeta.proxyUsed ? new HttpsProxyAgent(streamMeta.proxyUsed) : undefined;

            // Check if FFmpeg is available on local/Mac/Linux system for pure MP3 audio streaming
            const getFFmpegPath = () => {
                if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
                if (fs.existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
                if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
                if (process.platform === 'darwin') {
                    if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
                }
                return 'ffmpeg';
            };

            if (process.platform === 'darwin' || !process.env.VERCEL) {
                const ffmpegBin = getFFmpegPath();
                console.log(`[Audio MP3 Stream] Streaming pure MP3 via FFmpeg for videoId=${videoId}`);
                res.status(200);
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Cache-Control', 'no-cache, no-store');
                res.setHeader('Connection', 'keep-alive');

                const ffmpegProc = spawn(ffmpegBin, [
                    '-loglevel', 'error',
                    '-i', 'pipe:0',
                    '-vn',
                    '-c:a', 'libmp3lame',
                    '-b:a', '192k',
                    '-f', 'mp3',
                    'pipe:1'
                ], { stdio: ['pipe', 'pipe', 'pipe'] });

                ffmpegProc.stdout.pipe(res);

                const forwardHeaders = {
                    'User-Agent': 'com.google.android.apps.youtube.vr/1.37.24 (Linux; U; Android 10; quest)',
                    'Range': 'bytes=0-'
                };

                const requestOptions = { headers: forwardHeaders };
                if (agent) requestOptions.agent = agent;

                const audioReq = https.get(directUrl, requestOptions, (audioRes) => {
                    if (audioRes.statusCode === 403 && !isRetry) {
                        console.log(`[Audio Proxy Stream] Got 403 on URL for ${videoId}, refreshing stream URL...`);
                        try { ffmpegProc.kill('SIGTERM'); } catch (e) {}
                        streamUrlCache.delete(videoId);
                        return fetchStream(true);
                    }
                    audioRes.pipe(ffmpegProc.stdin);
                });

                audioReq.on('error', (err) => {
                    console.error('[Audio Proxy Stream] Upstream request error:', err.message);
                    try { ffmpegProc.kill('SIGTERM'); } catch (e) {}
                    if (!res.headersSent) res.status(502).end();
                });

                ffmpegProc.stderr.on('data', (d) => {
                    const msg = d.toString().trim();
                    if (msg) console.error(`[FFmpeg Stream ${videoId}]`, msg);
                });

                ffmpegProc.stdin.on('error', (err) => {
                    // Ignore EPIPE on client disconnect
                });

                req.on('close', () => {
                    try { audioReq.destroy(); } catch (e) {}
                    try { ffmpegProc.kill('SIGTERM'); } catch (e) {}
                });

                return;
            }

            const forwardHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-us,en;q=0.5',
                'Sec-Fetch-Mode': 'navigate',
                'Range': req.headers.range || 'bytes=0-'
            };

            const requestOptions = { headers: forwardHeaders };
            if (agent) requestOptions.agent = agent;

            const audioReq = https.get(directUrl, requestOptions, (audioRes) => {
                if (audioRes.statusCode === 403 && !isRetry) {
                    console.log(`[Audio Proxy Stream] Got 403 on cached URL for ${videoId}, refreshing stream URL...`);
                    streamUrlCache.delete(videoId);
                    return fetchStream(true);
                }

                res.status(audioRes.statusCode || 200);
                res.setHeader('Content-Type', 'audio/mp4');
                if (audioRes.headers['content-length']) res.setHeader('Content-Length', audioRes.headers['content-length']);
                if (audioRes.headers['content-range']) res.setHeader('Content-Range', audioRes.headers['content-range']);
                if (audioRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', audioRes.headers['accept-ranges']);
                res.setHeader('Cache-Control', 'no-cache, no-store');
                res.setHeader('Connection', 'keep-alive');

                audioRes.pipe(res);

                req.on('close', () => {
                    try { audioRes.destroy(); } catch (e) {}
                });
            });

            audioReq.on('error', (err) => {
                console.error('[Audio Proxy Stream] Stream error:', err.message);
                if (!res.headersSent) res.status(502).end();
            });
        };

        await fetchStream(false);

    } catch (err) {
        console.error('[Audio Proxy Stream] Resolution error:', err.message);
        if (!res.headersSent) res.status(500).end();
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
