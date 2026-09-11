const Alexa = require('ask-sdk-core');
const os = require('os');
const path = require('path');
const fs = require('fs');

const STATE_FILE = path.join(os.tmpdir(), 'alexa_state.json');

let io = null;
let lastState = null;
let useProxyMode = false; // Disabled because Alexa aggressive buffering ignores proxy stream termination
let activeProxyStreamRes = null;

// Initialize state from persistent disk cache on startup
try {
    if (fs.existsSync(STATE_FILE)) {
        const diskState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (diskState && diskState.queue && diskState.queue.length > 0) {
            lastState = diskState;
            console.log(`[State Recovery] Loaded active state (${diskState.queue.length} tracks, "${diskState.queue[diskState.index || 0]?.title || 'track'}") from ${STATE_FILE}`);
        }
    }
} catch (e) {}

exports.setSocketIO = (socketIo) => {
    io = socketIo;
    io.on('connection', (socket) => {
        console.log('Dashboard client connected');
        let stateToSend = lastState;
        if (!stateToSend) {
            try {
                if (fs.existsSync(STATE_FILE)) {
                    stateToSend = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                    lastState = stateToSend;
                }
            } catch (e) {}
        }
        if (stateToSend) {
            socket.emit('state', { ...stateToSend, useProxyMode });
        } else {
            socket.emit('state', { useProxyMode, status: 'IDLE', queue: [], index: 0 });
        }

        socket.on('setMode', (mode) => {
            useProxyMode = (mode === 'proxy');
            console.log('Stream Mode toggled to:', useProxyMode ? 'PROXY (Click-Seekable)' : 'DIRECT (Fast Stream)');
            if (lastState) {
                lastState.useProxyMode = useProxyMode;
                io.emit('state', lastState);
            }
        });

        socket.on('seekTo', (data) => {
            console.log('Web UI Click-to-Seek event received:', data);
            if (!data || data.targetMs === undefined || !lastState || !lastState.queue) return;
            const targetMs = Math.max(0, data.targetMs);
            lastState.offset = targetMs;
            lastState.timestamp = Date.now();
            io.emit('state', lastState);

            // Terminate active HTTP proxy stream to force Alexa to request new stream position
            if (activeProxyStreamRes) {
                console.log('Terminating active proxy stream to trigger Alexa seek reposition...');
                try {
                    activeProxyStreamRes.end();
                } catch (e) {
                    console.warn('Error ending proxy stream res:', e.message);
                }
                activeProxyStreamRes = null;
            }
        });
    });
};

exports.setActiveProxyStreamRes = (res) => {
    activeProxyStreamRes = res;
};

exports.getStreamUrlForVideoId = (videoId) => getStreamUrlForVideoId(videoId);
exports.getLastState = () => lastState;

// In-memory queue storage per user (cached per warm container)
const userQueues = new Map();

const encodeToken = (obj) => {
    try {
        return Buffer.from(JSON.stringify(obj)).toString('base64url');
    } catch (e) {
        return obj.v || 'token';
    }
};

const getStreamBase = () => {
    let base = '';
    if (process.env.STREAM_BASE_URL) base = process.env.STREAM_BASE_URL;
    else if (process.env.RENDER_EXTERNAL_URL) base = process.env.RENDER_EXTERNAL_URL;
    else if (process.env.TUNNEL_URL) base = process.env.TUNNEL_URL;
    else {
        try {
            const tunnelFile = path.join(__dirname, '..', '.tunnel_url');
            if (fs.existsSync(tunnelFile)) {
                const tUrl = fs.readFileSync(tunnelFile, 'utf8').trim();
                if (tUrl && tUrl.startsWith('http')) base = tUrl;
            }
        } catch (e) {}
    }
    if (!base) {
        base = 'https://alexa-audio-streamer.abhinavmlr.workers.dev';
    }
    return base.replace(/\/+$/, '');
};

const decodeToken = (tokenStr) => {
    if (!tokenStr) return null;
    try {
        let parsed;
        if (tokenStr.startsWith('{')) {
            parsed = JSON.parse(tokenStr);
        } else {
            const json = Buffer.from(tokenStr, 'base64url').toString('utf8');
            parsed = JSON.parse(json);
        }
        if (parsed) {
            return {
                videoId: parsed.v || tokenStr,
                title: parsed.t || '',
                index: typeof parsed.i === 'number' ? parsed.i : 0
            };
        }
        return { videoId: tokenStr, index: 0 };
    } catch (e) {
        return { videoId: tokenStr, index: 0 };
    }
};

const createToken = (videoId, title, index) => {
    return encodeToken({
        v: videoId,
        t: (title || '').slice(0, 30),
        i: index || 0
    });
};

const CLOUD_STATE_URL = 'https://api.restful-api.dev/objects/ff8081819ff5b11001a001901d111f9c';

const loadStateFromCloud = () => {
    return new Promise((resolve) => {
        try {
            https.get(CLOUD_STATE_URL, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(d);
                        if (parsed && parsed.data && parsed.data.queue) {
                            return resolve({
                                tracks: parsed.data.queue,
                                index: parsed.data.index || 0
                            });
                        }
                    } catch (e) {}
                    resolve(null);
                });
            }).on('error', () => resolve(null));
        } catch (e) {
            resolve(null);
        }
    });
};

const ensureUserQueue = async (handlerInput) => {
    const userId = Alexa.getUserId(handlerInput.requestEnvelope);
    let queue = userQueues.get(userId);
    if (queue && queue.tracks && queue.tracks.length > 0) {
        return queue;
    }
    
    const tokenStr = handlerInput.requestEnvelope.request?.token || 
                     handlerInput.requestEnvelope.context?.AudioPlayer?.token;
    const tokenData = decodeToken(tokenStr);

    // Check in-memory lastState
    if (lastState && lastState.queue && lastState.queue.length > 0) {
        queue = {
            tracks: lastState.queue,
            index: typeof tokenData?.index === 'number' ? tokenData.index : (lastState.index || 0)
        };
        userQueues.set(userId, queue);
        return queue;
    }

    // Check disk cache
    try {
        if (fs.existsSync(STATE_FILE)) {
            const diskState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (diskState && diskState.queue && diskState.queue.length > 0) {
                queue = {
                    tracks: diskState.queue,
                    index: typeof tokenData?.index === 'number' ? tokenData.index : (diskState.index || 0)
                };
                userQueues.set(userId, queue);
                lastState = diskState;
                console.log(`[Disk Recovery] Restored queue (${queue.tracks.length} tracks) from ${STATE_FILE}`);
                return queue;
            }
        }
    } catch (e) {}

    // Check Cloud Database (only in serverless/cloud environments)
    const isCloudEnv = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.VERCEL || process.env.RENDER);
    if (isCloudEnv) {
        const cloudState = await loadStateFromCloud();
        if (cloudState && cloudState.tracks && cloudState.tracks.length > 0) {
            queue = {
                tracks: cloudState.tracks,
                index: typeof tokenData?.index === 'number' ? tokenData.index : cloudState.index
            };
            userQueues.set(userId, queue);
            console.log(`[Cloud Recovery] Restored queue (${queue.tracks.length} tracks) from Cloud DB`);
            return queue;
        }
    }

    if (tokenData && tokenData.videoId) {
        queue = {
            tracks: [{ videoId: tokenData.videoId, title: tokenData.title || 'Playing Track', durationMs: 0 }],
            index: tokenData.index || 0
        };
        userQueues.set(userId, queue);
        return queue;
    }

    return null;
};

const syncStateToCloud = (stateData) => {
    return new Promise((resolve) => {
        try {
            const payload = JSON.stringify({
                name: 'alexa_music_state',
                data: stateData
            });
            const u = new URL(CLOUD_STATE_URL);
            const req = https.request({
                hostname: u.hostname,
                path: u.pathname,
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 3000
            }, (res) => {
                res.resume();
                res.on('end', resolve);
            });
            req.on('error', () => resolve());
            req.on('timeout', () => { req.destroy(); resolve(); });
            req.write(payload);
            req.end();
        } catch (e) {
            resolve();
        }
    });
};

const emitState = async (userId, status = 'PLAYING', overrideOffset = null) => {
    console.log('emitState called, userId:', userId ? 'present' : 'missing', 'status:', status);
    let userQueue = userId ? userQueues.get(userId) : null;
    if (!userQueue && userQueues.size > 0) {
        userQueue = Array.from(userQueues.values())[userQueues.size - 1];
    }
    if (!userQueue && lastState && lastState.queue && lastState.queue.length > 0) {
        userQueue = { tracks: lastState.queue, index: lastState.index || 0 };
    }
    if (!userQueue) {
        console.log('emitState: no userQueue found for user');
        return;
    }
    if (userId && !userQueues.has(userId)) {
        userQueues.set(userId, userQueue);
    }
    const currentTrack = userQueue.tracks[userQueue.index] || userQueue.tracks[0];
    lastState = {
        queue: userQueue.tracks,
        index: (typeof userQueue.index === 'number') ? userQueue.index : 0,
        status: status,
        offset: overrideOffset !== null ? overrideOffset : (lastState ? lastState.offset : 0),
        durationMs: currentTrack ? (currentTrack.durationMs || 0) : 0,
        timestamp: Date.now(),
        useProxyMode: useProxyMode
    };
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(lastState));
    } catch (e) {
        console.warn('[State Disk Write Error]:', e.message);
    }
    if (io) {
        io.emit('state', lastState);
    }
    syncStateToCloud(lastState).catch(() => {});
};

const parseDurationToMs = (durationStr) => {
    if (!durationStr) return 0;
    const match = durationStr.match(/P(?:([0-9]+)D)?T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?/);
    if (!match) return 0;
    const days = parseInt(match[1] || 0) * 86400000;
    const hours = parseInt(match[2] || 0) * 3600000;
    const minutes = parseInt(match[3] || 0) * 60000;
    const seconds = parseInt(match[4] || 0) * 1000;
    return days + hours + minutes + seconds;
};
const ytlist = require('yt-list');
const ytdl = require('ytdl-core');
require('dotenv').config();

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        const speakOutput = 'Welcome to youtube music';
        const repromptSpeakOutput = 'You can say, play vikram title track, to begin'

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(repromptSpeakOutput)
            .getResponse();
    }
};

const PlaySongIntentHandler = {
    async canHandle(handlerInput) {
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === "PlaySongIntent"
        );
    },
    async handle(handlerInput) {
        const slots = handlerInput.requestEnvelope.request.intent.slots;
        const speechText = slots ? (
            (slots.songQuery && slots.songQuery.value) ||
            (slots.query && slots.query.value) ||
            (slots.Song && slots.Song.value) ||
            (slots.Artist && slots.Artist.value) ||
            (slots.track && slots.track.value)
        ) : null;
        if (speechText) {
            return await controller.searchAndPlay(handlerInput, speechText);
        } else {
            return handlerInput.responseBuilder
                .speak("What song would you like to play?")
                .reprompt("Tell me the name of a song or artist to play.")
                .getResponse();
        }
    },
};

const StreamMacAudioIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'StreamMacAudioIntent';
    },
    handle(handlerInput) {
        // Determine the tunnel URL: env var > .tunnel_url file > hardcoded fallback
        let tunnelHost = process.env.TUNNEL_URL || '';
        if (!tunnelHost) {
            try {
                const urlFile = require('path').join(__dirname, '..', '.tunnel_url');
                tunnelHost = require('fs').readFileSync(urlFile, 'utf8').trim();
            } catch (e) {}
        }
        if (!tunnelHost) {
            tunnelHost = 'https://broadside-drank-excusably.ngrok-free.dev';
        }

        const streamUrl = `${tunnelHost}/live-audio?t=${Date.now()}`;
        console.log(`[StreamMacAudio] Starting live audio stream: ${streamUrl}`);

        return handlerInput.responseBuilder
            .speak('Streaming live audio from your device.')
            .withShouldEndSession(true)
            .addAudioPlayerPlayDirective(
                'REPLACE_ALL',
                streamUrl,
                'live-mac-audio',
                0,
                null
            )
            .getResponse();
    }
};

const { execFile } = require('child_process');

const getYtDlpPath = () => {
    if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
    if (process.env.PREFIX && fs.existsSync(`${process.env.PREFIX}/bin/yt-dlp`)) return `${process.env.PREFIX}/bin/yt-dlp`;
    if (fs.existsSync('/data/data/com.termux/files/usr/bin/yt-dlp')) return '/data/data/com.termux/files/usr/bin/yt-dlp';
    if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
    if (fs.existsSync('/usr/bin/yt-dlp')) return '/usr/bin/yt-dlp';

    if (process.platform === 'darwin') {
        if (fs.existsSync('/opt/homebrew/bin/yt-dlp')) return '/opt/homebrew/bin/yt-dlp';
        return 'yt-dlp';
    }

    if (process.platform === 'win32') {
        const winCandidates = [
            path.join(process.cwd(), 'bin', 'yt-dlp.exe'),
            path.join(process.cwd(), 'lambda', 'bin', 'yt-dlp.exe'),
            path.join(__dirname, 'bin', 'yt-dlp.exe'),
            path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
        ];
        for (const p of winCandidates) {
            if (fs.existsSync(p)) return p;
        }
        return 'yt-dlp.exe';
    }

    const candidatePaths = [
        path.join(__dirname, 'bin', 'yt-dlp'),
        path.join(__dirname, '..', 'bin', 'yt-dlp'),
        path.join(__dirname, '..', 'lambda', 'bin', 'yt-dlp'),
        path.join(process.cwd(), 'lambda', 'bin', 'yt-dlp'),
        path.join(process.cwd(), 'bin', 'yt-dlp')
    ];

    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

    for (const localBin of candidatePaths) {
        if (fs.existsSync(localBin)) {
            if (!isLambda) {
                try { fs.chmodSync(localBin, '755'); } catch (e) {}
                return localBin;
            }
            const tmpDir = process.env.TMPDIR || '/tmp';
            const tmpBin = path.join(tmpDir, 'yt-dlp');
            try {
                if (!fs.existsSync(tmpBin) || fs.statSync(tmpBin).size !== fs.statSync(localBin).size) {
                    fs.copyFileSync(localBin, tmpBin);
                }
                fs.chmodSync(tmpBin, '755');
                console.log(`[Binary Resolver] Located yt-dlp at ${localBin}, prepared executable at ${tmpBin}`);
                return tmpBin;
            } catch (e) {
                return localBin;
            }
        }
    }
    console.warn('[Binary Resolver] No local yt-dlp binary found in candidate paths, falling back to system PATH yt-dlp');
    return 'yt-dlp';
};

const getCookiesPath = () => {
    const candidateCookiePaths = [
        path.join(__dirname, 'cookies.txt'),
        path.join(__dirname, '..', 'cookies.txt'),
        path.join(process.cwd(), 'lambda', 'cookies.txt'),
        path.join(process.cwd(), 'cookies.txt')
    ];
    for (const cPath of candidateCookiePaths) {
        if (fs.existsSync(cPath)) {
            return cPath;
        }
    }
    return null;
};

const https = require('https');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCI88LsI-cO8D4NmS43xFJGluwcVSLMt_4';

const searchForVideosWithApi = (searchQuery) => {
    return new Promise((resolve, reject) => {
        const query = searchQuery.toLowerCase().includes('audio') ? searchQuery : `${searchQuery} audio`;
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const item = json.items[0];
                        resolve({
                            videoId: item.id.videoId,
                            title: item.snippet.title
                        });
                    } else {
                        reject(new Error(`No video results found for: ${query}`));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse YouTube API response: ${e.message}`));
                }
            });
        }).on('error', (err) => {
            reject(new Error(`YouTube API request failed: ${err.message}`));
        });
    });
};

const isCloudEnvironment = () => {
    return !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.VERCEL || process.env.RENDER);
};

const getRotatingProxies = () => {
    // Custom proxy configured by user takes precedence
    const custom = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (custom) return [custom];
    // On local devices (Windows, Mac, Linux/Termux), never use proxies
    return [];
};

const searchAndGetAudioStreamWithYtDlp = async (searchQuery) => {
    let meta;
    try {
        meta = await searchForVideosWithApi(searchQuery);
        console.log('YouTube API Search Result:', meta.title, meta.videoId);
    } catch (apiErr) {
        console.warn('YouTube API search failed, falling back to yt-dlp search:', apiErr.message);
        meta = { videoId: null, title: searchQuery };
    }

    const ytdlp = getYtDlpPath();
    const nodeDir = path.dirname(process.execPath);
    const isWin = process.platform === 'win32';
    const env = {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH || ''}`,
        ...(isWin ? {} : { TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' })
    };

    if (!meta.videoId) {
        const searchArgs = [
            '--no-warnings',
            '--force-ipv4',
            '--geo-bypass',
            '--flat-playlist',
            '--print', '%(id)s||%(title)s',
            `ytsearch1:${searchQuery}`
        ];
        const searchOutput = await new Promise((resolve, reject) => {
            execFile(ytdlp, searchArgs, { env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`yt-dlp search error: ${error.message} - ${stderr}`));
                resolve(stdout.trim());
            });
        });
        const parts = searchOutput.split('||');
        meta.videoId = parts[0];
        meta.title = parts[1] || searchQuery;
    }

    if (!meta.videoId) {
        throw new Error(`No video found for query: ${searchQuery}`);
    }

    const runYtDlpUrlResolution = (proxyUrl = null) => {
        const urlArgs = [
            '--no-warnings',
            '--force-ipv4',
            '--geo-bypass',
            '--socket-timeout', '4',
            '--extractor-args', 'youtube:player_client=android,mweb',
            '-g',
            '-f', 'ba/b'
        ];
        const cookieFile = getCookiesPath();
        if (cookieFile) {
            urlArgs.push('--cookies', cookieFile);
        }
        if (proxyUrl) {
            const formattedProxy = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
            urlArgs.push('--proxy', formattedProxy);
        }
        urlArgs.push(`https://www.youtube.com/watch?v=${meta.videoId}`);

        return new Promise((resolve, reject) => {
            execFile(ytdlp, urlArgs, { env, maxBuffer: 10 * 1024 * 1024, timeout: 7000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[yt-dlp error] binary: ${ytdlp}, proxy: ${proxyUrl ? proxyUrl.replace(/:[^:]*@/, ':***@') : 'none'}, msg: ${error.message}, stderr: ${stderr ? stderr.trim() : ''}`);
                    return reject(new Error(`yt-dlp url resolution error: ${error.message} - ${stderr}`));
                }
                resolve(stdout.trim());
            });
        });
    };

    let streamUrl;
    const isCloudEnv = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.VERCEL || process.env.RENDER);
    const proxies = getRotatingProxies();

    if (!isCloudEnv) {
        try {
            const urlOutput = await runYtDlpUrlResolution(null);
            streamUrl = urlOutput.split('\n').pop().trim();
        } catch (directErr) {
            console.warn('Direct stream resolution blocked/failed, falling back to Webshare proxy pool:', directErr.message);
        }
    }

    if (!streamUrl) {
        for (let i = 0; i < proxies.length; i += 2) {
            const batch = proxies.slice(i, i + 2);
            try {
                const fastest = await Promise.any(batch.map(async (proxy) => {
                    const output = await runYtDlpUrlResolution(proxy);
                    const cand = output.split('\n').pop().trim();
                    if (cand && cand.startsWith('http')) return cand;
                    throw new Error('Invalid URL');
                }));
                if (fastest) {
                    streamUrl = fastest;
                    console.log('✔ [Proxy Success] Resolved stream URL via Webshare proxy batch!');
                    break;
                }
            } catch (err) {
                // try next batch
            }
        }
    }

    if (!streamUrl || !streamUrl.startsWith('http')) {
        throw new Error(`Failed to extract audio stream URL for videoId: ${meta.videoId}`);
    }

    return { videoId: meta.videoId, title: meta.title, url: streamUrl };
};

const searchWithYtDlp = (searchQuery, sourcePrefix = 'YouTube Mix: ') => {
    return new Promise((resolve) => {
        const ytdlp = getYtDlpPath();
        const args = [
            '--no-warnings',
            '--force-ipv4',
            '--geo-bypass',
            '--flat-playlist',
            '--print', '%(id)s\t%(title)s',
            `ytsearch5:${searchQuery}`
        ];
        execFile(ytdlp, args, { timeout: 4500 }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const lines = stdout.trim().split('\n').filter(l => l.includes('\t'));
            const tracks = lines.map(line => {
                const [videoId, ...rest] = line.split('\t');
                return {
                    videoId: videoId.trim(),
                    title: sourcePrefix + rest.join('\t').trim(),
                    durationMs: 0
                };
            });
            resolve(tracks);
        });
    });
};

const searchCache = new Map();

const searchPlaylistForQuery = (searchQuery) => {
    return new Promise(async (resolve, reject) => {
        const startTime = Date.now();
        let query = searchQuery.trim();
        let sourcePrefix = 'YouTube Mix: ';
        
        if (query.includes('spotify')) {
            query = query.replace('on spotify', '').replace('spotify', '').trim();
            sourcePrefix = 'Spotify Mix: ';
        } else if (query.includes('jio saavn') || query.includes('jiosaavn') || query.includes('saavn')) {
            query = query.replace('on jio saavn', '').replace('on jiosaavn', '').replace('on saavn', '').replace('jio saavn', '').replace('jiosaavn', '').replace('saavn', '').trim();
            sourcePrefix = 'JioSaavn Mix: ';
        } else if (query.includes('apple music')) {
            query = query.replace('on apple music', '').replace('apple music', '').trim();
            sourcePrefix = 'Apple Music Mix: ';
        }
        
        // Ensure "audio" is appended for better music results
        query = query.includes('audio') ? query : `${query} audio`;

        const cacheKey = query.toLowerCase();
        if (searchCache.has(cacheKey)) {
            const cached = searchCache.get(cacheKey);
            if (cached && cached.length > 0) {
                console.log(`✔ [Search Cache Hit] Returning ${cached.length} tracks for "${query}" in 0ms`);
                return resolve(cached);
            }
        }

        let completed = false;
        const doResolve = (tracks) => {
            if (!completed) {
                completed = true;
                searchCache.set(cacheKey, tracks);
                console.log(`✔ [Search Success] Found ${tracks.length} tracks for "${query}" in ${Date.now() - startTime}ms`);
                resolve(tracks);
            }
        };

        const doFallback = async (reason) => {
            if (completed) return;
            console.log(`⚠️ [Search Fallback] YouTube API (${reason}), running fast yt-dlp search...`);
            try {
                const fallbackTracks = await searchWithYtDlp(query, sourcePrefix);
                if (fallbackTracks.length > 0) return doResolve(fallbackTracks);
            } catch (e) {}
            if (!completed) {
                completed = true;
                reject(new Error(`No video results found for: ${query}`));
            }
        };

        // If no API key configured, go straight to fast yt-dlp
        if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY.trim() === '') {
            return doFallback('no API key');
        }

        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
        
        const req = https.get(url, { family: 4, timeout: 2500 }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', async () => {
                if (res.statusCode !== 200) {
                    return doFallback(`HTTP status ${res.statusCode}`);
                }
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const apiTracks = json.items.filter(item => item.id && item.id.videoId).map(item => ({
                            videoId: item.id.videoId,
                            title: sourcePrefix + item.snippet.title,
                            durationMs: 0
                        }));
                        if (apiTracks.length === 0) {
                            return doFallback('no video items in search response');
                        }

                        // Resolve immediately so Alexa can start playback without waiting!
                        doResolve(apiTracks);

                        // Asynchronously fetch durations in background for queue/dashboard
                        try {
                            const ids = apiTracks.map(t => t.videoId).join(',');
                            const durUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YOUTUBE_API_KEY}`;
                            const durReq = https.get(durUrl, { family: 4, timeout: 2000 }, (durRes) => {
                                let durData = '';
                                durRes.on('data', (chunk) => durData += chunk);
                                durRes.on('end', () => {
                                    try {
                                        const durJson = JSON.parse(durData);
                                        if (durJson.items) {
                                            durJson.items.forEach(v => {
                                                const t = apiTracks.find(tr => tr.videoId === v.id);
                                                if (t) t.durationMs = parseDurationToMs(v.contentDetails.duration);
                                            });
                                        }
                                    } catch (e) {}
                                });
                            });
                            durReq.on('error', () => {});
                        } catch (e) {}
                    } else {
                        await doFallback('items empty');
                    }
                } catch (e) {
                    await doFallback(`parse error: ${e.message}`);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            doFallback('timeout > 2500ms');
        });
        req.on('error', (err) => {
            doFallback(`network error: ${err.message}`);
        });
    });
};

const searchForPlaylistTracksWithApi = searchPlaylistForQuery;

const fetchMoreRelatedTracks = async (currentTrack, existingTracks = []) => {
    try {
        if (!currentTrack || !currentTrack.title) return [];
        const cleanTitle = currentTrack.title
            .replace(/^(YouTube Mix: |Spotify Mix: |Apple Music Mix: |JioSaavn Mix: )/i, '')
            .replace(/[\(\[\{].*?[\)\]\}]/g, '')
            .trim();
        const query = `${cleanTitle} songs audio`;
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
        
        const existingIds = new Set((existingTracks || []).map(t => t.videoId));
        const newTracks = await new Promise((resolve) => {
            const req = https.get(url, { timeout: 3500 }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.items && json.items.length > 0) {
                            const items = json.items
                                .filter(it => it.id && it.id.videoId && !existingIds.has(it.id.videoId))
                                .map(it => ({
                                    videoId: it.id.videoId,
                                    title: 'YouTube Mix: ' + it.snippet.title,
                                    durationMs: 0
                                }));
                            resolve(items);
                        } else {
                            resolve([]);
                        }
                    } catch (e) {
                        resolve([]);
                    }
                });
            });
            req.on('timeout', () => { req.destroy(); resolve([]); });
            req.on('error', () => resolve([]));
        });

        if (newTracks.length > 0) {
            const ids = newTracks.map(t => t.videoId).join(',');
            const durUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YOUTUBE_API_KEY}`;
            await new Promise((resolve) => {
                const durReq = https.get(durUrl, { timeout: 1200 }, (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => {
                        try {
                            const durJson = JSON.parse(d);
                            if (durJson.items) {
                                durJson.items.forEach(v => {
                                    const t = newTracks.find(tr => tr.videoId === v.id);
                                    if (t) t.durationMs = parseDurationToMs(v.contentDetails.duration);
                                });
                            }
                        } catch (e) {}
                        resolve();
                    });
                });
                durReq.on('timeout', () => { durReq.destroy(); resolve(); });
                durReq.on('error', () => resolve());
            });
        }

        return newTracks;
    } catch (err) {
        console.warn('[AutoReplenish] Error fetching related tracks:', err.message);
        return [];
    }
};

const streamUrlMemoryCache = new Map();

const getStreamUrlForVideoId = async (videoId) => {
    const cached = streamUrlMemoryCache.get(videoId);
    if (cached && (Date.now() - cached.timestamp < 900000)) {
        console.log(`[Stream Memory Cache] Hit for videoId=${videoId}`);
        return cached.data;
    }

    const ytdlp = getYtDlpPath();
    const nodeDir = path.dirname(process.execPath);
    const isWin = process.platform === 'win32';
    const pathSep = isWin ? ';' : ':';
    const env = {
        ...process.env,
        PATH: `${nodeDir}${pathSep}${process.env.PATH || ''}`,
        ...(isWin ? {} : { TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' })
    };

    const runYtDlpUrlResolution = (proxyUrl = null, client = 'android') => {
        const label = proxyUrl ? proxyUrl.replace(/:[^:]*@/, ':***@') : `Direct (${client})`;
        const t0 = Date.now();
        const urlArgs = [
            '--no-warnings',
            '--force-ipv4',
            '--no-check-certificates',
            '--socket-timeout', '10',
            '--extractor-args', `youtube:player_client=${client}`,
            '-g',
            '-f', 'ba/b'
        ];
        if (proxyUrl) {
            const formattedProxy = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
            urlArgs.push('--proxy', formattedProxy);
        }
        urlArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

        return new Promise((resolve, reject) => {
            execFile(ytdlp, urlArgs, { env, maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
                const duration = Date.now() - t0;
                if (error || !stdout) {
                    const errMsg = `[yt-dlp Extract (${label})] FAILED (${duration}ms): ${error ? error.message : 'no stdout'} | stderr: ${stderr ? stderr.trim().slice(0, 300) : 'none'}`;
                    console.error(errMsg);
                    return reject(new Error(errMsg));
                }
                const firstUrl = stdout.trim().split('\n')[0].trim();
                if (firstUrl && firstUrl.startsWith('http')) {
                    console.log(`✔ [yt-dlp Extract (${label})] SUCCESS (${duration}ms)`);
                    const result = { streamUrl: firstUrl, proxyUsed: proxyUrl, durationMs: duration };
                    streamUrlMemoryCache.set(videoId, { data: result, timestamp: Date.now() });
                    resolve(result);
                } else {
                    const errMsg = `[yt-dlp Extract (${label})] INVALID OUTPUT (${duration}ms): ${stdout.slice(0, 100)}`;
                    console.error(errMsg);
                    reject(new Error(errMsg));
                }
            });
        });
    };

    const isLocal = !isCloudEnvironment();
    const proxies = getRotatingProxies();

    // Local machines (Windows, Mac, Android) run directly without proxies for maximum speed and zero thrashing
    if (isLocal || proxies.length === 0) {
        console.log(`[Stream Resolve] Local device (${process.platform}) - Direct extraction (no proxies) for videoId=${videoId}...`);
        try {
            return await runYtDlpUrlResolution(null, 'android');
        } catch (androidErr) {
            console.warn(`[Stream Resolve] Android client direct extraction failed, trying mweb client fallback...`);
            return await runYtDlpUrlResolution(null, 'mweb');
        }
    }

    console.log(`[Stream Resolve] Cloud environment - extracting with proxies (${proxies.length} available)...`);
    const attempts = [
        runYtDlpUrlResolution(null, 'android'),
        ...proxies.slice(0, 2).map(p => runYtDlpUrlResolution(p, 'android'))
    ];

    try {
        const fastest = await Promise.any(attempts);
        const resolvedProxy = fastest.proxyUsed ? fastest.proxyUsed.replace(/:[^:]*@/, ':***@') : 'Direct';
        console.log(`✔ [Stream Resolved] videoId=${videoId} via: ${resolvedProxy} (${fastest.durationMs || 0}ms)`);
        return fastest;
    } catch (allErr) {
        console.error(`❌ [Stream Resolve Error] All resolution attempts failed for videoId=${videoId}:`, allErr.errors ? allErr.errors.map(e => e.message).join(' | ') : allErr.message);
        throw new Error(`Failed to extract audio stream URL for videoId: ${videoId}`);
    }
};

const controller = {
    async searchAndPlay(handlerInput, query) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        try {
            console.log('Searching track playlist for query:', query);
            const tracks = await searchForPlaylistTracksWithApi(query);
            if (!tracks || tracks.length === 0) {
                throw new Error(`No tracks found for query: ${query}`);
            }
            userQueues.set(userId, { tracks, index: 0 });
            const currentTrack = tracks[0];
            await emitState(userId, 'PLAYING', 0);
            return this.playTrack(handlerInput, currentTrack, "REPLACE_ALL", `Playing ${currentTrack.title}`);
        } catch (err) {
            console.error('Search failed:', err.message);
            return handlerInput.responseBuilder
                .speak(`Sorry, I couldn't find any track for ${query}. Please try another song.`)
                .getResponse();
        }
    },
    async playNext(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = await ensureUserQueue(handlerInput);
        if (!userQueue || !userQueue.tracks) {
            return handlerInput.responseBuilder
                .speak("You've reached the end of the playlist.")
                .getResponse();
        }

        // Replenish queue if near the end
        if (userQueue.index >= userQueue.tracks.length - 3) {
            const currentTrack = userQueue.tracks[userQueue.index] || userQueue.tracks[userQueue.tracks.length - 1];
            const moreTracks = await fetchMoreRelatedTracks(currentTrack, userQueue.tracks);
            if (moreTracks.length > 0) {
                userQueue.tracks.push(...moreTracks);
                console.log(`[AutoReplenish playNext] Added ${moreTracks.length} tracks. Total queue size: ${userQueue.tracks.length}`);
            }
        }

        if (userQueue.index >= userQueue.tracks.length - 1) {
            return handlerInput.responseBuilder
                .speak("You've reached the end of the playlist.")
                .getResponse();
        }

        userQueue.index += 1;
        const track = userQueue.tracks[userQueue.index];
        await emitState(userId, 'PLAYING', 0);
        return this.playTrack(handlerInput, track, "REPLACE_ALL", `Next track: ${track.title}`);
    },
    async playPrevious(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = await ensureUserQueue(handlerInput);
        if (!userQueue || !userQueue.tracks || userQueue.index <= 0) {
            return handlerInput.responseBuilder
                .speak("You are at the beginning of the playlist.")
                .getResponse();
        }
        userQueue.index -= 1;
        const track = userQueue.tracks[userQueue.index];
        await emitState(userId, 'PLAYING', 0);
        return this.playTrack(handlerInput, track, "REPLACE_ALL", `Previous track: ${track.title}`);
    },
    async playTrack(handlerInput, track, playBehavior = "REPLACE_ALL", speakText = null, offsetMs = 0) {
        const { responseBuilder } = handlerInput;
        if (speakText) {
            responseBuilder.speak(speakText);
        }

        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = userQueues.get(userId) || { tracks: [track], index: 0 };
        const streamBase = getStreamBase();
        const audioUrl = `${streamBase}/stream/${track.videoId}`;
        const token = createToken(track.videoId, track.title, userQueue.index);

        console.log(`playTrack: streamBase=${streamBase}, track=${track.title}, audioUrl=${audioUrl}, offset=${offsetMs}ms`);

        // Pre-fetch stream URL in background while Alexa speaks title to eliminate buffering delay
        getStreamUrlForVideoId(track.videoId).catch(() => {});

        return responseBuilder
            .withShouldEndSession(true)
            .addAudioPlayerPlayDirective(
                playBehavior,
                audioUrl,
                token,
                offsetMs,
                null
            )
            .getResponse();
    },
    async stop(handlerInput, message = 'Stopped') {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        await emitState(userId, 'PAUSED');
        return handlerInput.responseBuilder
            .speak(message)
            .addAudioPlayerStopDirective()
            .getResponse();
    },
    async seek(handlerInput, direction, durationStr) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = await ensureUserQueue(handlerInput);
        if (!userQueue || !userQueue.tracks || !userQueue.tracks[userQueue.index]) {
            return handlerInput.responseBuilder.speak("Nothing is currently playing.").getResponse();
        }
        const track = userQueue.tracks[userQueue.index];
        const audioPlayerContext = handlerInput.requestEnvelope.context.AudioPlayer;
        let currentOffset = audioPlayerContext ? audioPlayerContext.offsetInMilliseconds : 0;
        
        const offsetDeltaMs = parseDurationToMs(durationStr);
        let newOffset = direction === 'FORWARD' ? currentOffset + offsetDeltaMs : currentOffset - offsetDeltaMs;
        if (newOffset < 0) newOffset = 0;

        console.log(`SEEK ${direction}: duration=${durationStr} (${offsetDeltaMs}ms), from=${currentOffset}ms, to=${newOffset}ms`);

        try {
            track.url = await getStreamUrlForVideoId(track.videoId);
            await emitState(userId, 'PLAYING', newOffset);
            return this.playTrack(handlerInput, track, "REPLACE_ALL", null, newOffset);
        } catch (err) {
            console.error('Seek failed:', err.message);
            return handlerInput.responseBuilder.speak("Sorry, I couldn't seek.").getResponse();
        }
    },
    async startOver(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = await ensureUserQueue(handlerInput);
        if (!userQueue || !userQueue.tracks || !userQueue.tracks[userQueue.index]) {
            return handlerInput.responseBuilder.speak("Nothing is currently playing.").getResponse();
        }
        const track = userQueue.tracks[userQueue.index];
        try {
            track.url = await getStreamUrlForVideoId(track.videoId);
            await emitState(userId, 'PLAYING', 0);
            return this.playTrack(handlerInput, track, "REPLACE_ALL", "Starting over", 0);
        } catch (err) {
            return handlerInput.responseBuilder.speak("Sorry, I couldn't restart the track.").getResponse();
        }
    },
};

const NextIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NextIntent';
    },
    async handle(handlerInput) {
        return await controller.playNext(handlerInput);
    }
};

const PreviousIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PreviousIntent';
    },
    async handle(handlerInput) {
        return await controller.playPrevious(handlerInput);
    }
};

const PauseIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent');
    },
    async handle(handlerInput) {
        return await controller.stop(handlerInput, 'Playback stopped. Have a great day!');
    }
};

const ResumeIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent';
    },
    async handle(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = await ensureUserQueue(handlerInput);
        if (userQueue && userQueue.tracks && userQueue.tracks[userQueue.index]) {
            const track = userQueue.tracks[userQueue.index];
            const audioPlayerContext = handlerInput.requestEnvelope.context.AudioPlayer;
            const offsetMs = audioPlayerContext ? audioPlayerContext.offsetInMilliseconds : 0;
            await emitState(userId, 'PLAYING', offsetMs);
            return await controller.playTrack(handlerInput, track, "REPLACE_ALL", `Resuming ${track.title}`, offsetMs);
        }
        return handlerInput.responseBuilder.speak("Nothing is currently playing.").getResponse();
    }
};

const StartOverIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StartOverIntent';
    },
    async handle(handlerInput) {
        return await controller.startOver(handlerInput);
    }
};

const SeekForwardIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'SeekForwardIntent';
    },
    async handle(handlerInput) {
        const durationStr = handlerInput.requestEnvelope.request.intent.slots.duration.value;
        return await controller.seek(handlerInput, 'FORWARD', durationStr);
    }
};

const SeekBackwardIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'SeekBackwardIntent';
    },
    async handle(handlerInput) {
        const durationStr = handlerInput.requestEnvelope.request.intent.slots.duration.value;
        return await controller.seek(handlerInput, 'BACKWARD', durationStr);
    }
};

const PlaybackNearlyFinishedHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackNearlyFinished';
    },
    async handle(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = await ensureUserQueue(handlerInput);
        if (!userQueue || !userQueue.tracks) return handlerInput.responseBuilder.getResponse();

        // Check if queue needs replenishment (3 or fewer tracks remaining)
        const tracksRemaining = userQueue.tracks.length - 1 - userQueue.index;
        if (tracksRemaining <= 3) {
            const currentTrack = userQueue.tracks[userQueue.index];
            console.log(`[AutoReplenish] Queue low (${tracksRemaining} tracks remaining). Fetching more songs...`);
            const moreTracks = await fetchMoreRelatedTracks(currentTrack, userQueue.tracks);
            if (moreTracks.length > 0) {
                userQueue.tracks.push(...moreTracks);
                console.log(`[AutoReplenish] Added ${moreTracks.length} new tracks to queue. Total queue size: ${userQueue.tracks.length}`);
                await emitState(userId, 'PLAYING', 0);
            }
        }

        if (userQueue.index < userQueue.tracks.length - 1) {
            const nextIndex = userQueue.index + 1;
            const nextTrack = userQueue.tracks[nextIndex];
            const currentTrack = userQueue.tracks[userQueue.index];
            try {
                const streamBase = getStreamBase();
                const nextStreamUrl = `${streamBase}/stream/${nextTrack.videoId}`;
                const nextToken = createToken(nextTrack.videoId, nextTrack.title, nextIndex);
                const currentToken = createToken(currentTrack.videoId, currentTrack.title, userQueue.index);
                
                console.log(`[AutoQueue] Enqueuing next track: ${nextTrack.title} (${nextTrack.videoId}) -> ${nextStreamUrl}`);
                return handlerInput.responseBuilder
                    .addAudioPlayerPlayDirective("ENQUEUE", nextStreamUrl, nextToken, 0, currentToken)
                    .getResponse();
            } catch (e) {
                console.error('Failed auto-enqueue next track:', e.message);
            }
        }
        return handlerInput.responseBuilder.getResponse();
    }
};

const AudioPlayerEventHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope).startsWith('AudioPlayer.')
            && Alexa.getRequestType(handlerInput.requestEnvelope) !== 'AudioPlayer.PlaybackNearlyFinished';
    },
    async handle(handlerInput) {
        const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const request = handlerInput.requestEnvelope.request;
        const token = request.token;
        const offsetMs = request.offsetInMilliseconds || (handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.AudioPlayer ? handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds : 0);

        console.log(`AudioPlayer Event: ${requestType}, token: ${token ? 'present' : 'none'}, offset: ${offsetMs}ms`);

        const userQueue = await ensureUserQueue(handlerInput);

        if (requestType === 'AudioPlayer.PlaybackFailed') {
            const reqError = handlerInput.requestEnvelope.request.error || {};
            const curState = handlerInput.requestEnvelope.request.currentPlaybackState || {};
            console.error(`\n❌ ==================================================`);
            console.error(`❌ [Alexa AudioPlayer.PlaybackFailed Event]`);
            console.error(`   Error Type   : ${reqError.type || 'UNKNOWN'}`);
            console.error(`   Error Message: ${reqError.message || 'None provided'}`);
            console.error(`   Failed Token : ${token || 'none'}`);
            console.error(`   Offset       : ${offsetMs}ms`);
            console.error(`   Player State : token=${curState.token || 'none'} offset=${curState.offsetInMilliseconds || 0}ms activity=${curState.playerActivity || 'UNKNOWN'}`);
            console.error(`   Raw Details  :`, JSON.stringify(reqError));
            console.error(`❌ ==================================================\n`);
        }

        if (requestType === 'AudioPlayer.PlaybackStarted') {
            if (userQueue && token) {
                const tokenData = decodeToken(token);
                const activeId = tokenData.videoId || token;
                const idx = userQueue.tracks.findIndex(t => t.videoId === activeId);
                if (idx !== -1) userQueue.index = idx;
            }
            await emitState(userId, 'PLAYING', offsetMs);
        } else if (requestType === 'AudioPlayer.PlaybackStopped' || requestType === 'AudioPlayer.PlaybackFinished' || requestType === 'AudioPlayer.PlaybackFailed') {
            await emitState(userId, 'PAUSED', offsetMs);
        }

        return handlerInput.responseBuilder.getResponse();
    }
};

const SystemExceptionHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'System.ExceptionEncountered';
    },
    handle(handlerInput) {
        console.error('System Exception:', JSON.stringify(handlerInput.requestEnvelope.request.error));
        return handlerInput.responseBuilder.getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'You can say play believer, next, previous, pause, or resume.';
        return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
    }
};

const CancelAndStopIntentHandler = PauseIntentHandler;

const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'Sorry, I don\'t know about that. Please try again.';
        return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
    }
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`~~~~ Session ended: ${JSON.stringify(handlerInput.requestEnvelope)}`);
        return handlerInput.responseBuilder.getResponse();
    }
};

const IntentReflectorHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
    },
    handle(handlerInput) {
        const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        const speakOutput = `You just triggered ${intentName}`;
        return handlerInput.responseBuilder.speak(speakOutput).getResponse();
    }
};

const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.';
        const request = handlerInput.requestEnvelope.request;
        console.error(`~~~~ Error handled:`, error ? error.message : error);
        console.error(`Un-handled Request Type:`, request.type);
        if (request.type === 'IntentRequest') {
            console.error(`Un-handled Intent:`, request.intent.name);
        }

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        PlaySongIntentHandler,
        StreamMacAudioIntentHandler,
        NextIntentHandler,
        PreviousIntentHandler,
        StartOverIntentHandler,
        SeekForwardIntentHandler,
        SeekBackwardIntentHandler,
        PauseIntentHandler,
        ResumeIntentHandler,
        PlaybackNearlyFinishedHandler,
        AudioPlayerEventHandler,
        SystemExceptionHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler,
        IntentReflectorHandler)
    .addErrorHandlers(
        ErrorHandler)
    .withCustomUserAgent('sample/hello-world/v1.2')
    .lambda();

exports.getYtDlpPath = getYtDlpPath;
exports.getCookiesPath = getCookiesPath;
exports.getStreamUrlForVideoId = getStreamUrlForVideoId;
exports.getLastState = () => lastState;