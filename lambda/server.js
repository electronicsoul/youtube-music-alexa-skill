require('./env.js');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { handler, setSocketIO, getStreamUrlForVideoId, setActiveProxyStreamRes, getLastState, getYtDlpPath, getCookiesPath, setStreamStopper } = require('./index.js');

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

const os = require('os');
const STATE_FILE = path.join(os.tmpdir(), 'alexa_state.json');
const CLOUD_STATE_URL = process.env.CLOUD_STATE_URL || '';
const https = require('https');

let cachedFFmpegPath = undefined;
const getFFmpegPath = () => {
    if (cachedFFmpegPath !== undefined) return cachedFFmpegPath;
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
        cachedFFmpegPath = process.env.FFMPEG_PATH;
        return cachedFFmpegPath;
    }
    if (process.env.PREFIX && fs.existsSync(`${process.env.PREFIX}/bin/ffmpeg`)) {
        cachedFFmpegPath = `${process.env.PREFIX}/bin/ffmpeg`;
        return cachedFFmpegPath;
    }
    if (fs.existsSync('/data/data/com.termux/files/usr/bin/ffmpeg')) {
        cachedFFmpegPath = '/data/data/com.termux/files/usr/bin/ffmpeg';
        return cachedFFmpegPath;
    }
    if (fs.existsSync('/usr/bin/ffmpeg')) {
        cachedFFmpegPath = '/usr/bin/ffmpeg';
        return cachedFFmpegPath;
    }
    if (fs.existsSync('/usr/local/bin/ffmpeg')) {
        cachedFFmpegPath = '/usr/local/bin/ffmpeg';
        return cachedFFmpegPath;
    }
    if (process.platform === 'darwin') {
        if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
            cachedFFmpegPath = '/opt/homebrew/bin/ffmpeg';
            return cachedFFmpegPath;
        }
    }
    if (process.platform === 'win32') {
        const winPaths = [
            'C:\\ffmpeg\\bin\\ffmpeg.exe',
            path.join(process.cwd(), 'bin', 'ffmpeg.exe'),
            path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
            path.join(__dirname, 'bin', 'ffmpeg.exe'),
            path.join(process.cwd(), 'ffmpeg.exe')
        ];
        for (const wp of winPaths) {
            if (fs.existsSync(wp)) {
                cachedFFmpegPath = wp;
                return cachedFFmpegPath;
            }
        }
        try {
            const { execSync } = require('child_process');
            execSync('where ffmpeg', { stdio: 'ignore' });
            cachedFFmpegPath = 'ffmpeg.exe';
            return cachedFFmpegPath;
        } catch (e) {
            cachedFFmpegPath = null;
            return cachedFFmpegPath;
        }
    }
    try {
        const { execSync } = require('child_process');
        execSync('which ffmpeg || command -v ffmpeg', { stdio: 'ignore' });
        cachedFFmpegPath = 'ffmpeg';
        return cachedFFmpegPath;
    } catch (e) {
        cachedFFmpegPath = null;
        return cachedFFmpegPath;
    }
};

let cachedSystemDiagnostics = null;
const getSystemDiagnostics = () => {
    if (!cachedSystemDiagnostics) {
        let gitCommit = 'unknown';
        let gitBranch = 'unknown';
        let gitDate = 'unknown';
        let gitDirty = false;
        try {
            const { execSync } = require('child_process');
            const root = path.join(__dirname, '..');
            gitCommit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            gitDate = execSync('git log -1 --format=%cd --date=relative', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            const st = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
            gitDirty = st.length > 0;
        } catch (e) {}

        let ytdlpVer = 'not found';
        const ytdlpPath = getYtDlpPath ? getYtDlpPath() : 'yt-dlp';
        try {
            const { execSync } = require('child_process');
            ytdlpVer = execSync(`"${ytdlpPath}" --version`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        } catch (e) {}

        let ffmpegVer = 'not found';
        const ffmpegPath = getFFmpegPath();
        if (ffmpegPath) {
            try {
                const { execSync } = require('child_process');
                const raw = execSync(`"${ffmpegPath}" -version`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
                ffmpegVer = raw.split('\n')[0].trim();
            } catch (e) {
                ffmpegVer = 'error running binary';
            }
        }

        cachedSystemDiagnostics = {
            git: { commit: gitCommit, branch: gitBranch, date: gitDate, isDirty: gitDirty },
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            ytdlp: { path: ytdlpPath, version: ytdlpVer },
            ffmpeg: { path: ffmpegPath, version: ffmpegVer }
        };
    }

    return {
        ...cachedSystemDiagnostics,
        uptimeSeconds: Math.round(process.uptime()),
        tunnelUrl: process.env.TUNNEL_URL || null
    };
};

// --- Realtime Observability & Telemetry Hub ---
const telemetryEvents = [];
const MAX_TELEMETRY = 80;
let requestCounter = 0;
let activeStreams = 0;
const activeAudioStreams = new Set();

let totalBytesTransferredLifetime = 0;
let currentStreamBytes = 0;
let currentStreamSpeedBps = 0;
let currentStreamRateKbps = 0;
let currentStreamVideoId = null;

function stopAllAudioStreams(reason = 'stopped') {
    const count = activeAudioStreams.size;
    if (count === 0 && activeStreams === 0) return;
    console.log(`[Audio Stream Manager] Stopping all active audio streams (${count} active, reason: ${reason})...`);
    for (const entry of activeAudioStreams) {
        try {
            if (entry.bytesSent) {
                totalBytesTransferredLifetime += entry.bytesSent;
            }
            if (entry.ffmpegProc) {
                try { entry.ffmpegProc.kill('SIGTERM'); } catch (e) {}
            }
            if (entry.ytdlpProc) {
                try { entry.ytdlpProc.kill('SIGTERM'); } catch (e) {}
            }
            if (entry.res && !entry.res.writableEnded) {
                entry.res.end();
            }
        } catch (e) {}
    }
    activeAudioStreams.clear();
    activeStreams = 0;
    currentStreamBytes = 0;
    currentStreamSpeedBps = 0;
    currentStreamRateKbps = 0;
    currentStreamVideoId = null;
    if (io) {
        io.emit('telemetry', {
            category: 'audio_stream',
            type: 'stream_end',
            activeStreams: 0,
            nodes: ['transcoder', 'gateway', 'echo']
        });
        io.emit('stream_status', { activeStreams: 0, status: 'STOPPED' });
        io.emit('stream_transfer', {
            videoId: null,
            bytesTransferred: 0,
            totalLifetimeBytes: totalBytesTransferredLifetime,
            speedBytesPerSec: 0,
            rateKbps: 0,
            activeStreams: 0,
            isStreaming: false
        });
    }
}

if (setStreamStopper) {
    setStreamStopper(stopAllAudioStreams);
}
let currentVoiceRequestId = null;
let currentVoiceVideoId = null;
let currentVoiceTimestamp = 0;

function logTelemetry(event) {
    const item = {
        id: ++requestCounter,
        timestamp: Date.now(),
        ...event
    };
    telemetryEvents.unshift(item);
    if (telemetryEvents.length > MAX_TELEMETRY) {
        telemetryEvents.pop();
    }
    if (io) {
        io.emit('telemetry', item);
    }
    return item;
}

app.get('/api/telemetry', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
        events: telemetryEvents,
        metrics: {
            totalRequests: requestCounter,
            activeStreams: activeStreams,
            currentStreamBytes: currentStreamBytes,
            currentStreamSpeedBps: currentStreamSpeedBps,
            currentStreamRateKbps: currentStreamRateKbps,
            totalBytesTransferred: totalBytesTransferredLifetime + currentStreamBytes,
            uptimeSeconds: Math.round(process.uptime()),
            tunnelUrl: process.env.TUNNEL_URL || null,
            platform: process.platform,
            nodeVersion: process.version,
            hasFfmpeg: !!(process.platform === 'darwin' || !process.env.VERCEL ? getFFmpegPath() : null),
            diagnostics: getSystemDiagnostics()
        }
    });
});

app.get('/api/diagnostics', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(getSystemDiagnostics());
});

app.post('/api/telemetry/simulate', (req, res) => {
    const sampleQueries = ['Starboy - The Weeknd', 'Believer - Imagine Dragons', 'Levitating - Dua Lipa', 'Shape of You - Ed Sheeran', 'Blinding Lights'];
    const q = sampleQueries[Math.floor(Math.random() * sampleQueries.length)];
    const duration = Math.floor(60 + Math.random() * 90);
    const simId = 'sim_' + Date.now().toString(36);
    const event = {
        groupId: simId,
        requestId: simId,
        category: 'voice_intent',
        type: 'alexa_request',
        requestType: 'IntentRequest',
        intentName: 'PlaySongIntent',
        query: q,
        durationMs: duration,
        status: 'ok',
        speech: `Playing ${q} on YouTube Music`,
        directive: 'AudioPlayer.Play',
        audioUrl: `https://${req.headers.host || 'localhost:3000'}/stream/sim_${Date.now()}`,
        nodes: ['echo', 'gateway', 'core', 'extractor', 'core', 'gateway', 'echo']
    };
    logTelemetry(event);

    // Simulate audio stream transfer burst to visualize graph throughput
    let simTransferred = 0;
    let simTicks = 0;
    const simTimer = setInterval(() => {
        simTicks++;
        simTransferred += Math.floor(60000 + Math.random() * 40000); // ~60KB - 100KB per tick
        if (io) {
            io.emit('stream_transfer', {
                videoId: 'sim_' + Date.now(),
                bytesTransferred: simTransferred,
                totalLifetimeBytes: totalBytesTransferredLifetime + simTransferred,
                speedBytesPerSec: 24500,
                rateKbps: 192,
                activeStreams: 1,
                durationMs: simTicks * 300,
                isStreaming: true
            });
        }
        if (simTicks >= 12) {
            clearInterval(simTimer);
        }
    }, 300);

    res.json({ ok: true, simulated: event });
});

// Diagnostic route
app.get('/api/debug-extract', async (req, res) => {
    const videoId = req.query.v || '7wtfhZwyrcc';
    const { execFile } = require('child_process');
    const ytdlp = getYtDlpPath ? getYtDlpPath() : 'yt-dlp';
    const cookieFile = getCookiesPath ? getCookiesPath() : null;
    
    const results = [];
    const proxyList = process.env.HTTP_PROXY ? [process.env.HTTP_PROXY] : [];
    const testTargets = [null, ...proxyList];
    
    for (const p of testTargets) {
        const start = Date.now();
        await new Promise((resolve) => {
            const args = [
                '--force-ipv4', '--geo-bypass',
                '--socket-timeout', '6',
                '--extractor-args', 'youtube:player_client=android',
                '-g', '-f', 'ba/b'
            ];
            if (cookieFile) args.push('--cookies', cookieFile);
            if (p) args.push('--proxy', p);
            args.push(`https://www.youtube.com/watch?v=${videoId}`);

            execFile(ytdlp, args, { env: { ...process.env, TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' }, timeout: 10000 }, (err, stdout, stderr) => {
                results.push({
                    target: p ? p.split('@')[1] || 'proxy' : 'direct',
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
    const resolveStart = Date.now();
    const isLinked = (currentVoiceVideoId === videoId && (Date.now() - currentVoiceTimestamp < 60000));
    const extractGroupId = isLinked ? currentVoiceRequestId : ('extract_' + videoId);
    try {
        const streamMeta = await getStreamUrlForVideoId(videoId);
        const streamUrl = typeof streamMeta === 'string' ? streamMeta : streamMeta.streamUrl;
        const proxyUsed = streamMeta.proxyUsed || null;
        logTelemetry({
            groupId: extractGroupId,
            requestId: extractGroupId,
            category: 'extractor',
            type: 'resolve_stream',
            videoId,
            durationMs: Date.now() - resolveStart,
            proxy: proxyUsed ? proxyUsed.split('@')[1] || 'proxy' : 'direct',
            nodes: ['core', 'extractor', 'core']
        });
        res.json({ videoId, streamUrl, proxyUsed });
    } catch (e) {
        logTelemetry({
            groupId: extractGroupId,
            requestId: extractGroupId,
            category: 'extractor',
            type: 'resolve_stream_error',
            videoId,
            durationMs: Date.now() - resolveStart,
            error: e.message,
            nodes: ['core', 'extractor']
        });
        res.status(500).json({ error: e.message });
    }
});

// Diagnostic endpoint to test yt-dlp binary directly
app.get('/api/debug-ytdlp', (req, res) => {
    const videoId = req.query.v || 'Rif-RTvmmss';
    const proxyUrl = req.query.proxy || process.env.DEBUG_PROXY_URL || process.env.HTTP_PROXY || null;
    const ytdlp = getYtDlpPath ? getYtDlpPath() : 'yt-dlp';
    const { execFile } = require('child_process');
    execFile(ytdlp, ['--version'], (err, stdout, stderr) => {
        const ver = stdout ? stdout.trim() : (err ? err.message : 'unknown');
        const args = [
            '--no-warnings',
            '--force-ipv4',
            '--no-check-certificates',
            '--socket-timeout', '6',
            '--extractor-args', 'youtube:player_client=android,mweb',
            '-g',
            '-f', 'ba/b'
        ];
        if (proxyUrl && proxyUrl !== 'none') {
            args.push('--proxy', proxyUrl);
        }
        args.push(`https://www.youtube.com/watch?v=${videoId}`);

        execFile(ytdlp, args, { timeout: 12000 }, (e2, out2, err2) => {
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
        if (fs.existsSync(STATE_FILE)) {
            const diskState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (diskState && (!localState || (diskState.timestamp && diskState.timestamp > (localState.timestamp || 0)))) {
                localState = diskState;
            }
        }
    } catch (e) {}

    const isCloudEnv = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.VERCEL || process.env.RENDER);
    
    // Local server has authoritative state in memory/disk - respond instantly with 0 external network requests!
    if (!isCloudEnv) {
        if (!res.headersSent) {
            return res.json(localState || { status: 'IDLE', queue: [], index: 0, timestamp: Date.now() });
        }
        return;
    }

    let responded = false;
    const safeRespond = (data) => {
        if (responded || res.headersSent) return;
        responded = true;
        res.json(data || localState || { status: 'IDLE', queue: [], index: 0, timestamp: Date.now() });
    };

    // Only query cloud DB if configured and no local state or running in serverless cloud
    if (!CLOUD_STATE_URL) {
        return safeRespond(localState);
    }

    const cloudReq = https.get(CLOUD_STATE_URL, { timeout: 2000 }, (cloudRes) => {
        let d = '';
        cloudRes.on('data', c => d += c);
        cloudRes.on('end', () => {
            try {
                const parsed = JSON.parse(d);
                const cloudState = parsed && parsed.data && parsed.data.queue && parsed.data.queue.length > 0 ? parsed.data : null;
                if (cloudState && localState) {
                    const cloudTs = cloudState.timestamp || 0;
                    const localTs = localState.timestamp || 0;
                    return safeRespond(localTs > cloudTs ? localState : cloudState);
                } else if (cloudState) {
                    return safeRespond(cloudState);
                }
            } catch (err) {}
            safeRespond(localState);
        });
    });

    cloudReq.on('error', () => {
        safeRespond(localState);
    });

    cloudReq.on('timeout', () => {
        try { cloudReq.destroy(); } catch (e) {}
        safeRespond(localState);
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

    const reqStartTime = Date.now();
    const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 4);

    // Auto-detect and bind public HTTPS base URL from incoming request headers
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
        const currentBase = `https://${host}`.replace(/\/+$/, '');
        if (process.env.TUNNEL_URL !== currentBase) {
            console.log(`[Auto Tunnel Detect] Bound public tunnel URL from request: ${currentBase}`);
            process.env.TUNNEL_URL = currentBase;
            try {
                fs.writeFileSync(path.join(__dirname, '..', '.tunnel_url'), currentBase, 'utf8');
            } catch (e) {}
        }
    }

    const reqType = req.body.request ? req.body.request.type : 'Unknown';
    const intentName = req.body.request && req.body.request.intent ? req.body.request.intent.name : '';
    const isAudioPlayer = reqType.startsWith('AudioPlayer.');

    if (!isAudioPlayer) {
        currentVoiceRequestId = requestId;
        currentVoiceTimestamp = Date.now();
    }
    
    // Extract query slot if present
    let querySlot = null;
    if (req.body.request && req.body.request.intent && req.body.request.intent.slots) {
        const slots = req.body.request.intent.slots;
        querySlot = (slots.query && slots.query.value) || 
                    (slots.Song && slots.Song.value) || 
                    (slots.Artist && slots.Artist.value) || 
                    (slots.track && slots.track.value) || null;
    }

    console.log(`[Alexa Request] Type: ${reqType}${intentName ? ' | Intent: ' + intentName : ''}`);

    let responded = false;
    const alexaTimeoutTimer = setTimeout(() => {
        if (!responded && !res.headersSent) {
            responded = true;
            const elapsed = Date.now() - reqStartTime;
            console.warn(`⚠️ [Alexa Timeout Guard] Request took > 6500ms (${reqType}${intentName ? ' / ' + intentName : ''}). Sending safe prompt to prevent Alexa session termination.`);
            res.json({
                version: '1.0',
                response: {
                    outputSpeech: {
                        type: 'PlainText',
                        text: 'Searching for your music, please ask once more in a few seconds.'
                    },
                    shouldEndSession: true
                }
            });
        }
    }, 6500);

    handler(req.body, null, (err, responsePayload) => {
        clearTimeout(alexaTimeoutTimer);
        if (responded || res.headersSent) return;
        responded = true;

        const durationMs = Date.now() - reqStartTime;
        if (err) {
            console.error(`❌ Skill Execution Error (${durationMs}ms):`, err);
            logTelemetry({
                groupId: requestId,
                requestId: requestId,
                category: isAudioPlayer ? 'audioplayer' : 'voice_intent',
                type: 'alexa_request',
                requestType: reqType,
                intentName: intentName || reqType,
                query: querySlot,
                durationMs,
                status: 'error',
                error: err.message,
                nodes: ['echo', 'gateway', 'core']
            });
            if (!res.headersSent) return res.status(500).json({ error: err.message });
            return;
        }

        console.log(`✔ [Alexa Response Sent] Type: ${reqType}${intentName ? ' | Intent: ' + intentName : ''} in ${durationMs}ms`);

        // Extract response details
        let speech = null;
        if (responsePayload && responsePayload.response && responsePayload.response.outputSpeech) {
            speech = responsePayload.response.outputSpeech.text || responsePayload.response.outputSpeech.ssml || null;
        }

        let directiveType = null;
        let playAudioUrl = null;
        if (responsePayload && responsePayload.response && Array.isArray(responsePayload.response.directives) && responsePayload.response.directives.length > 0) {
            const dir = responsePayload.response.directives[0];
            directiveType = dir.type;
            if (dir.type === 'AudioPlayer.Play' && dir.audioItem && dir.audioItem.stream) {
                playAudioUrl = dir.audioItem.stream.url;
                const vMatch = playAudioUrl.match(/\/stream\/([^/?#]+)/);
                if (vMatch) {
                    currentVoiceVideoId = vMatch[1];
                }
            }
        }

        const involvedNodes = isAudioPlayer 
            ? ['echo', 'gateway', 'core', 'cloud_db', 'core', 'gateway', 'echo']
            : (intentName.includes('Play') || querySlot)
                ? ['echo', 'gateway', 'core', 'extractor', 'core', 'gateway', 'echo']
                : ['echo', 'gateway', 'core', 'gateway', 'echo'];

        logTelemetry({
            groupId: requestId,
            requestId: requestId,
            category: isAudioPlayer ? 'audioplayer' : 'voice_intent',
            type: 'alexa_request',
            requestType: reqType,
            intentName: intentName || (isAudioPlayer ? reqType.replace('AudioPlayer.', '') : reqType),
            query: querySlot,
            durationMs,
            status: 'ok',
            speech: speech ? speech.replace(/<[^>]+>/g, '').trim() : null,
            directive: directiveType,
            audioUrl: playAudioUrl,
            nodes: involvedNodes
        });

        if (directiveType === 'AudioPlayer.Stop' || 
            reqType === 'AudioPlayer.PlaybackStopped' || 
            reqType === 'AudioPlayer.PlaybackFinished' || 
            reqType === 'AudioPlayer.PlaybackFailed' || 
            intentName === 'AMAZON.PauseIntent' || 
            intentName === 'AMAZON.StopIntent' || 
            intentName === 'AMAZON.CancelIntent') {
            stopAllAudioStreams(intentName || reqType || directiveType);
        }

        if (!res.headersSent) {
            res.json(responsePayload);
        }
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
    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    
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
        const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
        const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

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
    const streamStart = Date.now();
    activeStreams++;
    let bytesSent = 0;

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const rangeHeader = req.headers.range || 'full';

    console.log(`\n==================================================`);
    console.log(`[Audio Stream Request] videoId=${videoId} (Active: ${activeStreams})`);
    console.log(`  Client IP    : ${clientIp}`);
    console.log(`  User-Agent   : ${userAgent}`);
    console.log(`  Range Header : ${rangeHeader}`);
    console.log(`==================================================`);

    const ffmpegBin = (process.platform === 'darwin' || !process.env.VERCEL) ? getFFmpegPath() : null;

    const isLinkedToVoice = (currentVoiceVideoId === videoId && (Date.now() - currentVoiceTimestamp < 60000));
    const streamGroupId = isLinkedToVoice ? currentVoiceRequestId : ('stream_' + videoId + '_' + Date.now().toString(36));

    const streamEntry = {
        videoId,
        res,
        req,
        ffmpegProc: null,
        ytdlpProc: null,
        bytesSent: 0
    };
    activeAudioStreams.add(streamEntry);
    currentStreamVideoId = videoId;
    currentStreamBytes = 0;
    let lastEmitTime = Date.now();
    let lastEmitBytes = 0;

    logTelemetry({
        groupId: streamGroupId,
        requestId: streamGroupId,
        category: 'audio_stream',
        type: 'stream_start',
        videoId,
        activeStreams,
        pipeline: ffmpegBin ? 'FFmpeg pure MP3 (192kbps)' : 'Direct yt-dlp M4A',
        range: rangeHeader,
        nodes: ['echo', 'gateway', 'transcoder', 'extractor', 'transcoder', 'gateway', 'echo']
    });

    let closed = false;
    const onStreamClose = () => {
        if (closed) return;
        closed = true;
        activeAudioStreams.delete(streamEntry);
        totalBytesTransferredLifetime += bytesSent;
        currentStreamBytes = 0;
        currentStreamSpeedBps = 0;
        currentStreamRateKbps = 0;
        currentStreamVideoId = null;
        activeStreams = Math.max(0, activeStreams - 1);
        const durationMs = Date.now() - streamStart;
        console.log(`[Audio Stream Request] Stream ended for videoId=${videoId} after ${Math.round(durationMs/1000)}s (${Math.round(bytesSent/1024)}KB transferred, Active streams: ${activeStreams})`);
        logTelemetry({
            groupId: streamGroupId,
            requestId: streamGroupId,
            category: 'audio_stream',
            type: 'stream_end',
            videoId,
            activeStreams,
            durationMs,
            bytesTransferred: bytesSent,
            nodes: ['transcoder', 'gateway', 'echo']
        });
        if (io) {
            io.emit('stream_transfer', {
                videoId,
                bytesTransferred: 0,
                lastTransferredBytes: bytesSent,
                totalLifetimeBytes: totalBytesTransferredLifetime,
                speedBytesPerSec: 0,
                rateKbps: 0,
                activeStreams,
                isStreaming: false
            });
        }
    };

    res.on('finish', onStreamClose);
    res.on('close', onStreamClose);

    const origWrite = res.write;
    res.write = function(chunk, ...args) {
        if (chunk && chunk.length) {
            bytesSent += chunk.length;
            streamEntry.bytesSent = bytesSent;
            currentStreamBytes = bytesSent;

            const now = Date.now();
            if (now - lastEmitTime >= 250) {
                const elapsedSec = (now - lastEmitTime) / 1000;
                const deltaBytes = bytesSent - lastEmitBytes;
                const speedBytesPerSec = elapsedSec > 0 ? (deltaBytes / elapsedSec) : 0;
                const rateKbps = Math.round((speedBytesPerSec * 8) / 1000);

                lastEmitTime = now;
                lastEmitBytes = bytesSent;
                currentStreamSpeedBps = Math.round(speedBytesPerSec);
                currentStreamRateKbps = rateKbps || 192;

                if (io) {
                    io.emit('stream_transfer', {
                        videoId,
                        bytesTransferred: bytesSent,
                        totalLifetimeBytes: totalBytesTransferredLifetime + bytesSent,
                        speedBytesPerSec: currentStreamSpeedBps,
                        rateKbps: currentStreamRateKbps,
                        activeStreams,
                        durationMs: now - streamStart,
                        isStreaming: true
                    });
                }
            }
        }
        return origWrite.apply(res, [chunk, ...args]);
    };

    try {
        const fetchStream = async (isRetry = false) => {
            let cached = streamUrlCache.get(videoId);
            let streamMeta = cached && (Date.now() - cached.timestamp < 900000) ? cached.meta : null;
            if (streamMeta) {
                console.log(`[Stream Cache] Cache HIT for videoId=${videoId} (${Math.round((Date.now() - cached.timestamp)/1000)}s old)`);
            } else {
                console.log(`[Stream Resolve] Cache MISS for videoId=${videoId}, extracting stream URL...`);
                const tResolve = Date.now();
                streamUrlCache.delete(videoId);
                streamMeta = await getStreamUrlForVideoId(videoId);
                if (streamMeta) streamUrlCache.set(videoId, { meta: streamMeta, timestamp: Date.now() });
                console.log(`[Stream Resolve] Extracted in ${Date.now() - tResolve}ms`);
            }

            const directUrl = typeof streamMeta === 'string' ? streamMeta : (streamMeta.streamUrl || streamMeta);
            const proxyUsed = streamMeta && streamMeta.proxyUsed ? streamMeta.proxyUsed : null;

            let urlHostname = 'unknown';
            try { urlHostname = new URL(directUrl).hostname; } catch (e) {}
            console.log(`[Stream Target] Domain: ${urlHostname} | Proxy: ${proxyUsed ? proxyUsed.replace(/:[^:]*@/, ':***@') : 'Direct'}`);

            if (ffmpegBin && directUrl) {
                console.log(`[Stream Pipeline] Selecting FFmpeg MP3 Transcoder (192kbps)`);
                console.log(`  FFmpeg Path  : ${ffmpegBin}`);
                res.status(200);
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Cache-Control', 'no-cache, no-store');
                res.setHeader('Connection', 'keep-alive');

                const ffmpegArgs = [
                    '-loglevel', 'info',
                    '-user_agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5'
                ];
                if (proxyUsed) {
                    ffmpegArgs.push('-http_proxy', proxyUsed);
                }
                ffmpegArgs.push(
                    '-i', directUrl,
                    '-vn',
                    '-c:a', 'libmp3lame',
                    '-b:a', '192k',
                    '-f', 'mp3',
                    'pipe:1'
                );

                const sanitizedArgs = ffmpegArgs.map(a => a.startsWith('http://') && a.includes('@') ? a.replace(/:[^:]*@/, ':***@') : a);
                console.log(`  FFmpeg Args  : ${sanitizedArgs.join(' ')}`);

                const ffmpegProc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                streamEntry.ffmpegProc = ffmpegProc;
                console.log(`  FFmpeg Spawn : PID=${ffmpegProc.pid}`);

                let firstAudioPacket = true;
                ffmpegProc.stdout.on('data', (chunk) => {
                    if (firstAudioPacket) {
                        firstAudioPacket = false;
                        console.log(`✔ [Stream FFmpeg] First audio chunk received (${chunk.length} bytes) in ${Date.now() - streamStart}ms - streaming to client`);
                    }
                });
                ffmpegProc.stdout.pipe(res);

                ffmpegProc.stderr.on('data', (d) => {
                    const lines = d.toString().split('\n');
                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line) continue;
                        if (line.includes('HTTP error') || line.includes('error') || line.includes('Error') || line.includes('Input #0') || line.includes('Output #0') || line.includes('Stream #0') || line.includes('403 Forbidden')) {
                            console.log(`[FFmpeg Stream ${videoId}] ${line}`);
                        }
                    }
                });

                ffmpegProc.on('close', (code, signal) => {
                    const durationSec = Math.round((Date.now() - streamStart)/1000);
                    console.log(`[Stream FFmpeg] Process closed (code: ${code}, signal: ${signal}) | Streamed ${bytesSent} bytes (${Math.round(bytesSent/1024)} KB) in ${durationSec}s`);
                    if (code !== 0 && bytesSent === 0) {
                        console.error(`❌ [Stream FFmpeg Error] FFmpeg exited with non-zero code ${code} before streaming any audio! Check stderr output above.`);
                    }
                });

                ffmpegProc.on('error', (err) => {
                    console.error('❌ [FFmpeg Process Spawn Error]:', err.message);
                    if (!res.headersSent) res.status(502).end();
                });

                req.on('close', () => {
                    try { ffmpegProc.kill('SIGTERM'); } catch (e) {}
                });

                return;
            }

            console.warn(`[Stream Pipeline] Pipeline: Direct yt-dlp M4A fallback (${!ffmpegBin ? 'FFmpeg not detected' : 'directUrl unavailable'})`);
            res.status(200);
            res.setHeader('Content-Type', 'audio/mp4');
            res.setHeader('Cache-Control', 'no-cache, no-store');
            res.setHeader('Connection', 'keep-alive');

            const ytdlpBin = getYtDlpPath();
            console.log(`  yt-dlp Path  : ${ytdlpBin}`);
            const ytdlpArgs = [
                '--no-warnings',
                '--force-ipv4',
                '--no-check-certificates',
                '--extractor-args', 'youtube:player_client=android,mweb',
                '--http-chunk-size', '1048576',
                '-f', 'ba[ext=m4a]/ba/b',
                '-o', '-',
                `https://www.youtube.com/watch?v=${videoId}`
            ];
            if (proxyUsed) {
                ytdlpArgs.push('--proxy', proxyUsed);
            }

            console.log(`  yt-dlp Args  : ${ytdlpArgs.join(' ')}`);
            const ytdlpProc = spawn(ytdlpBin, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            streamEntry.ytdlpProc = ytdlpProc;
            console.log(`  yt-dlp Spawn : PID=${ytdlpProc.pid}`);

            let firstPacket = true;
            ytdlpProc.stdout.on('data', (chunk) => {
                if (firstPacket) {
                    firstPacket = false;
                    console.log(`✔ [Stream yt-dlp] First audio chunk received (${chunk.length} bytes) in ${Date.now() - streamStart}ms - streaming to client`);
                }
            });
            ytdlpProc.stdout.pipe(res);

            ytdlpProc.stderr.on('data', d => {
                const lines = d.toString().split('\n');
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (line) console.error(`[yt-dlp Stream ${videoId} stderr]`, line);
                }
            });

            ytdlpProc.on('close', (code, signal) => {
                console.log(`[Stream yt-dlp] Process closed (code: ${code}, signal: ${signal}) | Streamed ${bytesSent} bytes (${Math.round(bytesSent/1024)} KB)`);
                if (code !== 0 && bytesSent === 0) {
                    console.error(`❌ [Stream yt-dlp Error] yt-dlp exited with non-zero code ${code} before streaming any audio! Check stderr output above.`);
                }
            });

            ytdlpProc.on('error', (err) => {
                console.error('❌ [yt-dlp Process Error]:', err.message);
                if (!res.headersSent) res.status(502).end();
            });

            req.on('close', () => {
                try { ytdlpProc.kill('SIGTERM'); } catch (e) {}
            });
        };

        await fetchStream(false);

    } catch (err) {
        console.error('❌ [Audio Proxy Stream Fatal Error]:', err.message);
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
    activeStreams++;
    logTelemetry({
        category: 'live_audio',
        type: 'live_connect',
        activeStreams,
        activeListeners: liveAudioClients.size,
        platform: process.platform,
        nodes: ['echo', 'gateway', 'transcoder', 'gateway', 'echo']
    });
    
    const removeListener = () => {
        if (liveAudioClients.has(res)) {
            console.log('[Live Audio] Listener disconnected');
            liveAudioClients.delete(res);
            activeStreams = Math.max(0, activeStreams - 1);
            logTelemetry({
                category: 'live_audio',
                type: 'live_disconnect',
                activeStreams,
                activeListeners: liveAudioClients.size,
                nodes: ['gateway', 'transcoder']
            });
            
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
        const sys = getSystemDiagnostics();
        console.log(`\n==================================================`);
        console.log(`  YouTube Music Alexa Skill Endpoint Running`);
        console.log(`==================================================`);
        console.log(`  Git Commit   : ${sys.git.commit} (${sys.git.branch}${sys.git.isDirty ? ' [MODIFIED]' : ' [CLEAN]'}) - ${sys.git.date}`);
        console.log(`  Environment  : Node ${sys.node} | OS: ${sys.platform} (${sys.arch})`);
        console.log(`  yt-dlp       : ${sys.ytdlp.path} [${sys.ytdlp.version}]`);
        console.log(`  FFmpeg       : ${sys.ffmpeg.path || 'NOT FOUND'} [${sys.ffmpeg.version}]`);
        console.log(`  Local Server : http://localhost:${PORT}`);
        console.log(`  Live Dashboard: http://localhost:${PORT}/dashboard`);
        if (process.env.TUNNEL_URL) {
            console.log(`  Public Tunnel: ${process.env.TUNNEL_URL}`);
        }
        console.log(`==================================================\n`);

        // Auto-detect active ngrok tunnel from ngrok local API (http://127.0.0.1:4040/api/tunnels)
        let ngrokPollCount = 0;
        const pollNgrok = () => {
            const hReq = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1000 }, (hRes) => {
                let d = '';
                hRes.on('data', c => d += c);
                hRes.on('end', () => {
                    try {
                        const parsed = JSON.parse(d);
                        if (parsed && parsed.tunnels && parsed.tunnels.length > 0) {
                            const httpsTunnel = parsed.tunnels.find(t => t.public_url && t.public_url.startsWith('https://')) || parsed.tunnels[0];
                            if (httpsTunnel && httpsTunnel.public_url) {
                                const detectedUrl = httpsTunnel.public_url.replace(/\/+$/, '');
                                if (process.env.TUNNEL_URL !== detectedUrl) {
                                    console.log(`\n==================================================`);
                                    console.log(`✔ [ngrok Auto-Detect] Found active ngrok tunnel: ${detectedUrl}`);
                                    console.log(`👉 Alexa Developer Console -> Endpoints -> HTTPS:`);
                                    console.log(`   1. Paste: ${detectedUrl}`);
                                    console.log(`   2. Select: "My development endpoint is a sub-domain of a domain that has a wildcard certificate..."`);
                                    console.log(`   3. Click "Save Endpoints"`);
                                    console.log(`==================================================\n`);
                                    process.env.TUNNEL_URL = detectedUrl;
                                    try {
                                        fs.writeFileSync(path.join(__dirname, '..', '.tunnel_url'), detectedUrl, 'utf8');
                                    } catch (e) {}
                                }
                            }
                        }
                    } catch (e) {}
                });
            });
            hReq.on('error', () => {});
            ngrokPollCount++;
            if (ngrokPollCount < 10) setTimeout(pollNgrok, 3000);
        };
        setTimeout(pollNgrok, 1500);
    });
}

module.exports = app;
