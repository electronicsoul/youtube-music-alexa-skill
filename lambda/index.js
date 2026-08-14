const Alexa = require('ask-sdk-core');
let io = null;
let lastState = null;
let useProxyMode = false; // Disabled because Alexa aggressive buffering ignores proxy stream termination
let activeProxyStreamRes = null;

exports.setSocketIO = (socketIo) => {
    io = socketIo;
    io.on('connection', (socket) => {
        console.log('Dashboard client connected');
        if (lastState) {
            socket.emit('state', { ...lastState, useProxyMode });
        } else {
            socket.emit('state', { useProxyMode });
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
        if (parsed && parsed.tr) {
            return {
                videoId: parsed.v,
                title: parsed.t,
                index: parsed.i,
                tracks: parsed.tr.map(item => ({
                    videoId: item.id,
                    title: item.title,
                    durationMs: item.dur || 0
                }))
            };
        }
        return { videoId: tokenStr, tracks: [{ videoId: tokenStr, title: 'Playing Track', durationMs: 0 }], index: 0 };
    } catch (e) {
        return { videoId: tokenStr, tracks: [{ videoId: tokenStr, title: 'Playing Track', durationMs: 0 }], index: 0 };
    }
};

const createToken = (videoId, title, index, tracks) => {
    const compactTracks = (tracks || []).slice(0, 8).map(t => ({
        id: t.videoId,
        title: (t.title || '').slice(0, 35),
        dur: t.durationMs || 0
    }));
    return encodeToken({
        v: videoId,
        t: (title || '').slice(0, 35),
        i: index,
        tr: compactTracks
    });
};

const ensureUserQueue = (handlerInput) => {
    const userId = Alexa.getUserId(handlerInput.requestEnvelope);
    let queue = userQueues.get(userId);
    if (queue && queue.tracks && queue.tracks.length > 0) {
        return queue;
    }
    
    // Attempt restoration from AudioPlayer token
    const tokenStr = handlerInput.requestEnvelope.request?.token || 
                     handlerInput.requestEnvelope.context?.AudioPlayer?.token;
    const tokenData = decodeToken(tokenStr);
    if (tokenData && tokenData.tracks && tokenData.tracks.length > 0) {
        queue = {
            tracks: tokenData.tracks,
            index: typeof tokenData.index === 'number' ? tokenData.index : 0
        };
        userQueues.set(userId, queue);
        console.log(`[Stateless Recovery] Successfully restored queue (${queue.tracks.length} tracks) from Alexa token`);
        return queue;
    }
    return null;
};

const CLOUD_STATE_URL = 'https://api.restful-api.dev/objects/ff8081819ff5b11001a001901d111f9c';

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
                timeout: 1000
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
    const userQueue = userQueues.get(userId);
    if (!userQueue) {
        console.log('emitState: no userQueue found for user');
        return;
    }
    const currentTrack = userQueue.tracks[userQueue.index];
    lastState = {
        queue: userQueue.tracks,
        index: userQueue.index,
        status: status,
        offset: overrideOffset,
        durationMs: currentTrack ? (currentTrack.durationMs || 0) : 0,
        timestamp: Date.now(),
        useProxyMode: useProxyMode
    };
    try {
        const fs = require('fs');
        fs.writeFileSync('/tmp/alexa_state.json', JSON.stringify(lastState));
    } catch (e) {}
    if (io) {
        io.emit('state', lastState);
    }
    await syncStateToCloud(lastState);
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
        const speechText = slots && slots.songQuery ? slots.songQuery.value : null;
        if (speechText) {
            return await controller.searchAndPlay(handlerInput, speechText);
        } else {
            return handlerInput.responseBuilder
                .speak("What song would you like to play?")
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

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const getYtDlpPath = () => {
    if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;

    if (process.platform === 'darwin') {
        if (fs.existsSync('/opt/homebrew/bin/yt-dlp')) return '/opt/homebrew/bin/yt-dlp';
        return 'yt-dlp';
    }

    const candidatePaths = [
        path.join(__dirname, 'bin', 'yt-dlp'),
        path.join(__dirname, '..', 'bin', 'yt-dlp'),
        path.join(__dirname, '..', 'lambda', 'bin', 'yt-dlp'),
        path.join(process.cwd(), 'lambda', 'bin', 'yt-dlp'),
        path.join(process.cwd(), 'bin', 'yt-dlp')
    ];

    const tmpBin = '/tmp/yt-dlp';

    for (const localBin of candidatePaths) {
        if (fs.existsSync(localBin)) {
            try {
                if (!fs.existsSync(tmpBin) || fs.statSync(tmpBin).size !== fs.statSync(localBin).size) {
                    fs.copyFileSync(localBin, tmpBin);
                }
                fs.chmodSync(tmpBin, '755');
                console.log(`[Binary Resolver] Located yt-dlp at ${localBin}, prepared executable at ${tmpBin}`);
                return tmpBin;
            } catch (e) {
                console.error('Failed copying yt-dlp to /tmp:', e.message);
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
    const tmpCookies = '/tmp/cookies.txt';
    for (const cPath of candidateCookiePaths) {
        if (fs.existsSync(cPath)) {
            try {
                fs.copyFileSync(cPath, tmpCookies);
                return tmpCookies;
            } catch (e) {
                return cPath;
            }
        }
    }
    return fs.existsSync(tmpCookies) ? tmpCookies : null;
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

const WEBSHARE_PROXIES = [
    'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684',
    'http://upwuznhk:9mvyb16wdu1o@31.59.20.176:6754'
];

const getRotatingProxies = () => {
    const custom = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (custom) return [custom, ...WEBSHARE_PROXIES];
    // Always put verified working fast proxies in first batch
    return [...WEBSHARE_PROXIES];
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
    const env = {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH || ''}`,
        TMPDIR: '/tmp',
        TEMP: '/tmp',
        TMP: '/tmp'
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
            '--extractor-args', 'youtube:player_client=android_vr,tv_embedded',
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



const searchForPlaylistTracksWithApi = (searchQuery) => {
    return new Promise((resolve, reject) => {
        let query = searchQuery.toLowerCase();
        let sourcePrefix = '';
        
        // Parse multi-source intents
        if (query.includes('spotify')) {
            query = query.replace('on spotify', '').replace('spotify', '').trim();
            sourcePrefix = 'Spotify Mix: ';
        } else if (query.includes('jio saavn') || query.includes('jiosaavn') || query.includes('saavn')) {
            query = query.replace('on jio saavn', '').replace('on jiosaavn', '').replace('on saavn', '').replace('jio saavn', '').replace('jiosaavn', '').replace('saavn', '').trim();
            sourcePrefix = 'JioSaavn Mix: ';
        } else if (query.includes('apple music')) {
            query = query.replace('on apple music', '').replace('apple music', '').trim();
            sourcePrefix = 'Apple Music Mix: ';
        } else {
            sourcePrefix = 'YouTube Mix: ';
        }
        
        // Ensure "audio" is appended for better music results
        query = query.includes('audio') ? query : `${query} audio`;
        
        // Step 1: Find top 5 search matches
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=5&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const apiTracks = json.items.filter(item => item.id && item.id.videoId).map(item => ({
                            videoId: item.id.videoId,
                            title: sourcePrefix + item.snippet.title,
                            durationMs: 0
                        }));
                        let tracks = [...apiTracks];

                        // Fetch durations for all tracks via YouTube API
                        const ids = tracks.map(t => t.videoId).join(',');
                        const durUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YOUTUBE_API_KEY}`;
                        https.get(durUrl, (durRes) => {
                            let durData = '';
                            durRes.on('data', (chunk) => durData += chunk);
                            durRes.on('end', () => {
                                try {
                                    const durJson = JSON.parse(durData);
                                    if (durJson.items) {
                                        durJson.items.forEach(v => {
                                            const t = tracks.find(tr => tr.videoId === v.id);
                                            if (t) t.durationMs = parseDurationToMs(v.contentDetails.duration);
                                        });
                                    }
                                } catch (e) {
                                    console.warn('Failed to parse duration response:', e.message);
                                }
                                resolve(tracks);
                            });
                        }).on('error', () => resolve(tracks));
                        
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

const getStreamUrlForVideoId = async (videoId) => {
    const ytdlp = getYtDlpPath();
    const nodeDir = path.dirname(process.execPath);
    const env = {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH || ''}`,
        TMPDIR: '/tmp',
        TEMP: '/tmp',
        TMP: '/tmp'
    };

    const runYtDlpUrlResolution = (proxyUrl = null) => {
        const urlArgs = [
            '--no-warnings',
            '--force-ipv4',
            '--geo-bypass',
            '--socket-timeout', '4',
            '--extractor-args', 'youtube:player_client=android_vr,tv_embedded',
            '-g',
            '-f', 'ba[ext=m4a]/140/18/b[ext=mp4]/bestaudio/best'
        ];
        const cookieFile = getCookiesPath();
        if (cookieFile) {
            urlArgs.push('--cookies', cookieFile);
        }
        if (proxyUrl) {
            const formattedProxy = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
            urlArgs.push('--proxy', formattedProxy);
        }
        urlArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

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
                    console.log('✔ [Proxy Success] Resolved video stream via Webshare proxy batch!');
                    break;
                }
            } catch (err) {
                // try next batch
            }
        }
    }

    if (!streamUrl || !streamUrl.startsWith('http')) {
        throw new Error(`Failed to extract audio stream URL for videoId: ${videoId}`);
    }

    return streamUrl;
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
        const userQueue = ensureUserQueue(handlerInput);
        if (!userQueue || !userQueue.tracks || userQueue.index >= userQueue.tracks.length - 1) {
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
        const userQueue = ensureUserQueue(handlerInput);
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
        const streamBase = process.env.STREAM_BASE_URL || (process.env.VERCEL ? 'https://youtube-music-alexa-skill.vercel.app' : (process.env.TUNNEL_URL || 'https://youtube-music-alexa-skill.vercel.app'));
        const audioUrl = `${streamBase}/stream/${track.videoId}`;
        const token = createToken(track.videoId, track.title, userQueue.index, userQueue.tracks);

        console.log(`playTrack: mode=PROXY_STREAM, track=${track.title}, audioUrl=${audioUrl}, offset=${offsetMs}ms`);

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
        const userQueue = ensureUserQueue(handlerInput);
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
        const userQueue = ensureUserQueue(handlerInput);
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
        const userQueue = ensureUserQueue(handlerInput);
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
        const userQueue = ensureUserQueue(handlerInput);
        if (userQueue && userQueue.tracks && userQueue.index < userQueue.tracks.length - 1) {
            const nextIndex = userQueue.index + 1;
            const nextTrack = userQueue.tracks[nextIndex];
            const currentTrack = userQueue.tracks[userQueue.index];
            try {
                const streamBase = process.env.STREAM_BASE_URL || (process.env.VERCEL ? 'https://youtube-music-alexa-skill.vercel.app' : (process.env.TUNNEL_URL || 'https://youtube-music-alexa-skill.vercel.app'));
                const nextStreamUrl = `${streamBase}/stream/${nextTrack.videoId}`;
                const nextToken = createToken(nextTrack.videoId, nextTrack.title, nextIndex, userQueue.tracks);
                const currentToken = createToken(currentTrack.videoId, currentTrack.title, userQueue.index, userQueue.tracks);
                
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

        const userQueue = ensureUserQueue(handlerInput);

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