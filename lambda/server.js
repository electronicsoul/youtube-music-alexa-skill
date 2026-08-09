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
