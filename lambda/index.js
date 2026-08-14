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

const emitState = (userId, status = 'PLAYING', overrideOffset = null) => {
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
    if (io) {
        io.emit('state', lastState);
    }
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

    const localBin = path.join(__dirname, 'bin', 'yt-dlp');
    const tmpBin = '/tmp/yt-dlp';

    if (fs.existsSync(localBin)) {
        try {
            if (!fs.existsSync(tmpBin)) {
                fs.copyFileSync(localBin, tmpBin);
            }
            fs.chmodSync(tmpBin, '755');
            return tmpBin;
        } catch (e) {
            console.error('Failed copying yt-dlp to /tmp:', e.message);
        }
        return localBin;
    }
    return 'yt-dlp';
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
    'http://upwuznhk:9mvyb16wdu1o@31.59.20.176:6754',
    'http://upwuznhk:9mvyb16wdu1o@31.56.127.193:7684',
    'http://upwuznhk:9mvyb16wdu1o@45.38.107.97:6014',
    'http://upwuznhk:9mvyb16wdu1o@198.105.121.200:6462',
    'http://upwuznhk:9mvyb16wdu1o@64.137.96.74:6641',
    'http://upwuznhk:9mvyb16wdu1o@198.23.243.226:6361',
    'http://upwuznhk:9mvyb16wdu1o@38.154.185.97:6370',
    'http://upwuznhk:9mvyb16wdu1o@84.247.60.125:6095',
    'http://upwuznhk:9mvyb16wdu1o@142.111.67.146:5611',
    'http://upwuznhk:9mvyb16wdu1o@191.96.254.138:6185'
];

const getRotatingProxies = () => {
    const custom = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    const list = custom ? [custom, ...WEBSHARE_PROXIES] : [...WEBSHARE_PROXIES];
    // Randomize rotation
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
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
        PATH: `${nodeDir}:${process.env.PATH || ''}`
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
            '--socket-timeout', '5',
            '--extractor-args', 'youtube:player_client=android,ios',
            '-g',
            '-f', 'ba/b'
        ];
        if (proxyUrl) {
            const formattedProxy = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
            urlArgs.push('--proxy', formattedProxy);
        }
        urlArgs.push(`https://www.youtube.com/watch?v=${meta.videoId}`);

        return new Promise((resolve, reject) => {
            execFile(ytdlp, urlArgs, { env, maxBuffer: 10 * 1024 * 1024, timeout: 6000 }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`yt-dlp url resolution error: ${error.message} - ${stderr}`));
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
        for (let i = 0; i < Math.min(proxies.length, 6); i += 3) {
            const batch = proxies.slice(i, i + 3);
            try {
                const fastestUrl = await Promise.any(batch.map(async (proxy) => {
                    const output = await runYtDlpUrlResolution(proxy);
                    const cand = output.split('\n').pop().trim();
                    if (cand && cand.startsWith('http')) return cand;
                    throw new Error('Invalid URL');
                }));
                if (fastestUrl) {
                    streamUrl = fastestUrl;
                    console.log('✔ [Proxy Success] Resolved stream URL via fastest Webshare proxy in batch!');
                    break;
                }
            } catch (batchErr) {
                console.warn('Proxy batch failed, trying next batch:', batchErr.message);
            }
        }
    }

    if (!streamUrl || !streamUrl.startsWith('http')) {
        throw new Error(`Failed to extract audio stream URL for videoId: ${meta.videoId}`);
    }

    return { videoId: meta.videoId, title: meta.title, url: streamUrl };
};

// In-memory queue storage per user
const userQueues = new Map();

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
        
        // Step 1: Find the #1 best match (videoCategoryId=10 ensures Music)
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=1&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const firstTrack = {
                            videoId: json.items[0].id.videoId,
                            title: sourcePrefix + json.items[0].snippet.title,
                            durationMs: 0
                        };
                        
                        // Step 2: Fetch related tracks to create a Smart Radio Mix using yt-dlp (API is deprecated)
                        const { execFile } = require('child_process');
                        const ytdlp = getYtDlpPath();
                        const ytArgs = [
                            '--playlist-end', '20',
                            '--flat-playlist',
                            '--print', '%(id)s||%(title)s',
                            `https://www.youtube.com/watch?v=${firstTrack.videoId}&list=RDAMVM${firstTrack.videoId}`
                        ];
                        
                        execFile(ytdlp, ytArgs, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
                            let tracks = [firstTrack];
                            if (!err && stdout) {
                                const lines = stdout.trim().split('\n');
                                const mixTracks = lines.map(line => {
                                    const parts = line.split('||');
                                    return {
                                        videoId: parts[0],
                                        title: parts[1] || 'Unknown Title',
                                        durationMs: 0
                                    };
                                }).filter(t => t.videoId && t.videoId.length === 11);
                                
                                // Merge tracks (remove first track if it's duplicated in the mix)
                                if (mixTracks.length > 0 && mixTracks[0].videoId === firstTrack.videoId) {
                                    mixTracks.shift(); 
                                }
                                tracks = tracks.concat(mixTracks);
                            }
                            
                            // Step 3: Fetch durations for all tracks
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

const getStreamUrlForVideoId = async (videoId) => {
    const ytdlp = getYtDlpPath();
    const nodeDir = path.dirname(process.execPath);
    const env = {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH || ''}`
    };

    const runYtDlpUrlResolution = (proxyUrl = null) => {
        const urlArgs = [
            '--no-warnings',
            '--force-ipv4',
            '--geo-bypass',
            '--socket-timeout', '5',
            '--extractor-args', 'youtube:player_client=android,ios',
            '-g',
            '-f', 'ba/b'
        ];
        if (proxyUrl) {
            const formattedProxy = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
            urlArgs.push('--proxy', formattedProxy);
        }
        urlArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

        return new Promise((resolve, reject) => {
            execFile(ytdlp, urlArgs, { env, maxBuffer: 10 * 1024 * 1024, timeout: 6000 }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`yt-dlp url resolution error: ${error.message} - ${stderr}`));
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
        for (let i = 0; i < Math.min(proxies.length, 6); i += 3) {
            const batch = proxies.slice(i, i + 3);
            try {
                const fastestUrl = await Promise.any(batch.map(async (proxy) => {
                    const output = await runYtDlpUrlResolution(proxy);
                    const cand = output.split('\n').pop().trim();
                    if (cand && cand.startsWith('http')) return cand;
                    throw new Error('Invalid URL');
                }));
                if (fastestUrl) {
                    streamUrl = fastestUrl;
                    console.log('✔ [Proxy Success] Resolved video stream via fastest Webshare proxy in batch!');
                    break;
                }
            } catch (batchErr) {
                console.warn('Proxy batch failed, trying next batch:', batchErr.message);
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
            userQueues.set(userId, { tracks, index: 0 });

            const currentTrack = tracks[0];
            const streamUrl = await getStreamUrlForVideoId(currentTrack.videoId);
            currentTrack.url = streamUrl;

            emitState(userId, 'PLAYING', 0);
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
        const userQueue = userQueues.get(userId);
        if (!userQueue || !userQueue.tracks || userQueue.index >= userQueue.tracks.length - 1) {
            return handlerInput.responseBuilder
                .speak("You've reached the end of the playlist.")
                .getResponse();
        }
        userQueue.index += 1;
        const track = userQueue.tracks[userQueue.index];
        try {
            track.url = await getStreamUrlForVideoId(track.videoId);
            emitState(userId, 'PLAYING', 0);
            return this.playTrack(handlerInput, track, "REPLACE_ALL", `Next track: ${track.title}`);
        } catch (err) {
            return handlerInput.responseBuilder.speak("Sorry, couldn't skip to the next track.").getResponse();
        }
    },
    async playPrevious(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = userQueues.get(userId);
        if (!userQueue || !userQueue.tracks || userQueue.index <= 0) {
            return handlerInput.responseBuilder
                .speak("You are at the beginning of the playlist.")
                .getResponse();
        }
        userQueue.index -= 1;
        const track = userQueue.tracks[userQueue.index];
        try {
            track.url = await getStreamUrlForVideoId(track.videoId);
            emitState(userId, 'PLAYING', 0);
            return this.playTrack(handlerInput, track, "REPLACE_ALL", `Previous track: ${track.title}`);
        } catch (err) {
            return handlerInput.responseBuilder.speak("Sorry, couldn't play the previous track.").getResponse();
        }
    },
    async playTrack(handlerInput, track, playBehavior = "REPLACE_ALL", speakText = null, offsetMs = 0) {
        const { responseBuilder } = handlerInput;
        if (speakText) {
            responseBuilder.speak(speakText);
        }

        let audioUrl;
        if (useProxyMode) {
            const offsetSec = Math.floor(offsetMs / 1000);
            audioUrl = `https://broadside-drank-excusably.ngrok-free.dev/stream/${track.videoId}?offset=${offsetSec}&t=${Date.now()}`;
        } else {
            audioUrl = track.url || await getStreamUrlForVideoId(track.videoId);
        }

        console.log(`playTrack: mode=${useProxyMode ? 'PROXY' : 'DIRECT'}, audioUrl=${audioUrl}, offset=${offsetMs}ms`);

        return responseBuilder
            .withShouldEndSession(true)
            .addAudioPlayerPlayDirective(
                playBehavior,
                audioUrl,
                track.videoId,
                useProxyMode ? 0 : offsetMs,
                null
            )
            .getResponse();
    },
    async stop(handlerInput, message = 'Stopped') {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        emitState(userId, 'PAUSED');
        return handlerInput.responseBuilder
            .speak(message)
            .addAudioPlayerStopDirective()
            .getResponse();
    },
    async seek(handlerInput, direction, durationStr) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = userQueues.get(userId);
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
            emitState(userId, 'PLAYING', newOffset);
            return handlerInput.responseBuilder
                .addAudioPlayerPlayDirective("REPLACE_ALL", track.url, track.videoId, newOffset, null)
                .getResponse();
        } catch (err) {
            console.error('Seek failed:', err.message);
            return handlerInput.responseBuilder.speak("Sorry, I couldn't seek.").getResponse();
        }
    },
    async startOver(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = userQueues.get(userId);
        if (!userQueue || !userQueue.tracks || !userQueue.tracks[userQueue.index]) {
            return handlerInput.responseBuilder.speak("Nothing is currently playing.").getResponse();
        }
        const track = userQueue.tracks[userQueue.index];
        try {
            track.url = await getStreamUrlForVideoId(track.videoId);
            emitState(userId, 'PLAYING', 0);
            return handlerInput.responseBuilder
                .addAudioPlayerPlayDirective("REPLACE_ALL", track.url, track.videoId, 0, null)
                .getResponse();
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
    handle(handlerInput) {
        return controller.stop(handlerInput, 'Playback stopped. Have a great day!');
    }
};

const ResumeIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent';
    },
    handle(handlerInput) {
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const userQueue = userQueues.get(userId);
        if (userQueue && userQueue.tracks && userQueue.tracks[userQueue.index]) {
            const track = userQueue.tracks[userQueue.index];
            emitState(userId, 'PLAYING');
            return controller.playTrack(handlerInput, track, "REPLACE_ALL", `Resuming ${track.title}`);
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
        const userQueue = userQueues.get(userId);
        if (userQueue && userQueue.tracks && userQueue.index < userQueue.tracks.length - 1) {
            const nextTrack = userQueue.tracks[userQueue.index + 1];
            try {
                const streamUrl = await getStreamUrlForVideoId(nextTrack.videoId);
                return handlerInput.responseBuilder
                    .addAudioPlayerPlayDirective("ENQUEUE", streamUrl, nextTrack.videoId, 0, userQueue.tracks[userQueue.index].videoId)
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
    handle(handlerInput) {
        const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
        const userId = Alexa.getUserId(handlerInput.requestEnvelope);
        const request = handlerInput.requestEnvelope.request;
        const token = request.token;
        const offsetMs = request.offsetInMilliseconds || (handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.AudioPlayer ? handlerInput.requestEnvelope.context.AudioPlayer.offsetInMilliseconds : 0);

        console.log(`AudioPlayer Event: ${requestType}, token: ${token}, offset: ${offsetMs}ms`);

        if (requestType === 'AudioPlayer.PlaybackStarted') {
            const userQueue = userQueues.get(userId);
            if (userQueue && token) {
                const idx = userQueue.tracks.findIndex(t => t.videoId === token);
                if (idx !== -1) userQueue.index = idx;
            }
            emitState(userId, 'PLAYING', offsetMs);
        } else if (requestType === 'AudioPlayer.PlaybackStopped' || requestType === 'AudioPlayer.PlaybackFinished' || requestType === 'AudioPlayer.PlaybackFailed') {
            emitState(userId, 'PAUSED', offsetMs);
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