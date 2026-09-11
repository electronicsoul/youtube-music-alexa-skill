#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { updateEndpoint } = require('../update-endpoint.js');

const PROJECT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PROJECT_DIR, 'bin');
const LOG_DIR = path.join(PROJECT_DIR, 'logs');
const isWin = process.platform === 'win32';

if (!fs.existsSync(BIN_DIR)) {
    try { fs.mkdirSync(BIN_DIR, { recursive: true }); } catch (e) {}
}
if (!fs.existsSync(LOG_DIR)) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
}

const tunnelLogPath = path.join(LOG_DIR, 'tunnel.log');
const useNgrok = process.argv.includes('--ngrok') || process.argv.includes('-n');

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        console.log(`[Download] Fetching ${path.basename(dest)}...`);
        const file = fs.createWriteStream(dest);
        const req = https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;
            res.on('data', (chunk) => {
                downloaded += chunk.length;
                if (total > 0 && process.stdout.isTTY) {
                    const pct = Math.round((downloaded / total) * 100);
                    process.stdout.write(`\r[Download] ${pct}% (${Math.round(downloaded / (1024 * 1024))}MB / ${Math.round(total / (1024 * 1024))}MB) `);
                }
            });
            res.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    if (process.stdout.isTTY) process.stdout.write('\n');
                    console.log(`✔ [Download Complete] Saved to ${dest}`);
                    resolve();
                });
            });
        });
        req.on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

function findCommand(cmd) {
    const checkCmd = isWin ? `where ${cmd}` : `which ${cmd}`;
    try {
        const out = execSync(checkCmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        return out.split('\n')[0].trim();
    } catch (e) {
        return null;
    }
}

function killPort(port) {
    try {
        if (isWin) {
            const out = execSync(`netstat -aon | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const lines = out.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') {
                    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (e) {}
                }
            }
        } else {
            execSync(`fuser -k ${port}/tcp 2>/dev/null || lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
        }
    } catch (e) {}
}

async function ensureYtDlp() {
    if (isWin) {
        const localYtDlp = path.join(BIN_DIR, 'yt-dlp.exe');
        if (!findCommand('yt-dlp') && !fs.existsSync(localYtDlp)) {
            console.log('[yt-dlp] yt-dlp.exe not found. Auto-downloading standalone binary for Windows...');
            const downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
            try {
                await downloadFile(downloadUrl, localYtDlp);
            } catch (err) {
                console.error('❌ Failed to download yt-dlp:', err.message);
            }
        }
    }
}

function getNgrokUrlFromApi() {
    return new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json && json.tunnels && json.tunnels.length > 0) {
                        const httpsTunnel = json.tunnels.find(t => t.public_url && t.public_url.startsWith('https://')) || json.tunnels[0];
                        if (httpsTunnel && httpsTunnel.public_url) {
                            return resolve(httpsTunnel.public_url.replace(/\/+$/, ''));
                        }
                    }
                } catch (e) {}
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
    });
}

let serverProcess = null;
let tunnelProcess = null;

function cleanup() {
    if (tunnelProcess) {
        try { tunnelProcess.kill('SIGTERM'); } catch (e) {}
    }
    if (serverProcess) {
        try { serverProcess.kill('SIGTERM'); } catch (e) {}
    }
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

async function main() {
    console.log('==================================================');
    console.log('  Starting YouTube Music Alexa Skill');
    console.log('==================================================');

    killPort(3000);
    await ensureYtDlp();

    // Start Node.js Express server in background, piping output
    const serverScript = path.join(PROJECT_DIR, 'lambda', 'server.js');
    serverProcess = spawn(process.execPath, [serverScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
    });

    serverProcess.stdout.on('data', (d) => {
        const text = d.toString();
        // Print important server logs (Alexa requests, playback, errors)
        process.stdout.write(text);
    });

    serverProcess.stderr.on('data', (d) => {
        const text = d.toString();
        if (!text.includes('ExperimentalWarning')) {
            process.stderr.write(text);
        }
    });

    serverProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`❌ Local server stopped unexpectedly with code ${code}`);
            cleanup();
        }
    });

    // Wait a brief moment for server to listen
    await new Promise(r => setTimeout(r, 1200));

    let detectedUrl = null;

    if (useNgrok) {
        // Check if ngrok is already running
        const existingUrl = await getNgrokUrlFromApi();
        if (existingUrl) {
            detectedUrl = existingUrl;
        } else {
            let binPath = findCommand('ngrok');
            let spawnArgs = ['http', '3000'];

            if (!binPath) {
                const localBin = path.join(BIN_DIR, isWin ? 'ngrok.exe' : 'ngrok');
                if (fs.existsSync(localBin)) {
                    binPath = localBin;
                } else {
                    binPath = isWin ? 'npx.cmd' : 'npx';
                    spawnArgs = ['ngrok', 'http', '3000'];
                }
            }

            console.log('Starting ngrok tunnel on port 3000...');
            const logStream = fs.createWriteStream(tunnelLogPath, { flags: 'w' });

            tunnelProcess = spawn(binPath, spawnArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: isWin
            });

            tunnelProcess.stdout.on('data', d => logStream.write(d.toString()));
            tunnelProcess.stderr.on('data', (d) => {
                const text = d.toString();
                logStream.write(text);
                if (text.includes('ERR_') || text.includes('error') || text.includes('Error')) {
                    console.error('⚠️  [ngrok Error]:', text.trim());
                }
            });

            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 500));
                detectedUrl = await getNgrokUrlFromApi();
                if (detectedUrl) break;
            }
        }
    } else {
        // Cloudflare Tunnel
        let binPath = findCommand('cloudflared');
        const localBin = path.join(BIN_DIR, isWin ? 'cloudflared.exe' : 'cloudflared');

        if (!binPath && fs.existsSync(localBin)) {
            binPath = localBin;
        }

        if (!binPath && isWin) {
            console.log('[Cloudflare] cloudflared not found. Auto-downloading standalone binary for Windows...');
            const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
            try {
                await downloadFile(downloadUrl, localBin);
                binPath = localBin;
            } catch (err) {
                console.error('❌ Failed to download cloudflared:', err.message);
            }
        }

        if (!binPath) {
            console.error('❌ Error: cloudflared not found and could not be downloaded.');
            console.error('   Please install cloudflared or run with --ngrok');
            cleanup();
        }

        console.log('Starting fresh cloudflared tunnel on port 3000...');
        const logStream = fs.createWriteStream(tunnelLogPath, { flags: 'w' });

        tunnelProcess = spawn(binPath, ['tunnel', '--protocol', 'http2', '--url', 'http://localhost:3000'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: isWin
        });

        const handleData = (chunk) => {
            const text = chunk.toString();
            logStream.write(text);
            if (!detectedUrl) {
                const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i);
                if (match) detectedUrl = match[0];
            }
        };

        tunnelProcess.stdout.on('data', handleData);
        tunnelProcess.stderr.on('data', handleData);

        // Wait up to 25 seconds for cloudflared URL
        for (let i = 0; i < 50; i++) {
            if (detectedUrl) break;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    if (detectedUrl) {
        console.log('\n==================================================');
        console.log('🎉 SUCCESS! Your Alexa Skill HTTPS Endpoint is Live:');
        console.log(`👉 ${detectedUrl}`);
        console.log('==================================================\n');
        console.log('📡 Auto-deploying endpoint to Alexa skill...');
        await updateEndpoint(detectedUrl);
        console.log('Local Server: http://localhost:3000');
        console.log('Live Dashboard: http://localhost:3000/dashboard\n');
    } else {
        console.error('\n❌ Tunnel failed to start or did not return a valid HTTPS URL.');
        if (fs.existsSync(tunnelLogPath)) {
            console.error('Log details:');
            const lines = fs.readFileSync(tunnelLogPath, 'utf8').trim().split('\n');
            console.error(lines.slice(-10).join('\n'));
        }
    }
}

main();
