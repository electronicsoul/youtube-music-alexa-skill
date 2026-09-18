const fs = require('fs');
const path = require('path');

function loadEnv() {
    const candidates = [
        path.join(__dirname, '..', '.env'),
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', '.env.local'),
        path.join(process.cwd(), '.env'),
        path.join(process.cwd(), '.env.local')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                const content = fs.readFileSync(p, 'utf8');
                const lines = content.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)?$/);
                    if (match) {
                        const key = match[1];
                        if (process.env[key] === undefined) {
                            let value = (match[2] || '').trim();
                            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                                value = value.slice(1, -1);
                            }
                            process.env[key] = value;
                        }
                    }
                }
            } catch (e) {}
        }
    }
}

loadEnv();

module.exports = { loadEnv };
