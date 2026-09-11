#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PROJECT_DIR = __dirname;
const SKILL_JSON_PATH = path.join(PROJECT_DIR, 'skill-package', 'skill.json');
const SKILL_ID_FILE = path.join(PROJECT_DIR, '.skill_id');
const LAST_DEPLOYED_URL_FILE = path.join(PROJECT_DIR, '.last_deployed_url');
const TUNNEL_URL_FILE = path.join(PROJECT_DIR, '.tunnel_url');
const DEFAULT_SKILL_ID = 'amzn1.ask.skill.7f421724-a09e-4fe3-a417-08b963ca4bd1';

function getAskCliCommand() {
    try {
        execSync('ask --version', { stdio: 'ignore' });
        return 'ask';
    } catch (e) {}

    try {
        execSync('npx --no-install ask-cli --version', { stdio: 'ignore' });
        return 'npx ask-cli';
    } catch (e) {}

    return null;
}

function isAskConfigured() {
    const configPath = path.join(os.homedir(), '.ask', 'cli_config');
    return fs.existsSync(configPath);
}

function getSkillId(askCmd) {
    if (fs.existsSync(SKILL_ID_FILE)) {
        const id = fs.readFileSync(SKILL_ID_FILE, 'utf8').trim();
        if (id) return id;
    }

    if (askCmd && isAskConfigured()) {
        try {
            const out = execSync(`${askCmd} smapi list-skills-for-vendor`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const data = JSON.parse(out);
            if (data && data.skills && data.skills.length > 0) {
                const found = data.skills.find(s => s.nameByLocale && (s.nameByLocale['en-US'] === 'YouTube Music' || Object.values(s.nameByLocale).includes('YouTube Music')));
                if (found && found.skillId) {
                    try { fs.writeFileSync(SKILL_ID_FILE, found.skillId, 'utf8'); } catch (e) {}
                    return found.skillId;
                }
                return data.skills[0].skillId;
            }
        } catch (e) {}
    }

    return DEFAULT_SKILL_ID;
}

async function updateEndpoint(targetUrl, options = {}) {
    const force = options.force || process.argv.includes('--force');
    let url = targetUrl;

    if (!url) {
        // Try reading from .tunnel_url
        if (fs.existsSync(TUNNEL_URL_FILE)) {
            url = fs.readFileSync(TUNNEL_URL_FILE, 'utf8').trim();
        } else if (process.env.TUNNEL_URL) {
            url = process.env.TUNNEL_URL.trim();
        }
    }

    if (!url || !url.startsWith('http')) {
        console.error('❌ Usage: node update-endpoint.js <HTTPS_URL>');
        return { success: false, reason: 'INVALID_URL' };
    }

    // Alexa AudioPlayer strictly requires HTTPS
    url = url.replace(/^http:\/\//, 'https://').replace(/\/+$/, '');

    // Check if URL is unchanged
    if (fs.existsSync(LAST_DEPLOYED_URL_FILE) && !force) {
        const lastUrl = fs.readFileSync(LAST_DEPLOYED_URL_FILE, 'utf8').trim();
        if (lastUrl === url) {
            console.log('==================================================');
            console.log('✔ Endpoint URL is unchanged:');
            console.log(`👉 ${url}`);
            console.log('⚡ Skipping skill update & build loop.');
            console.log('==================================================');
            return { success: true, url, skipped: true };
        }
    }

    const askCmd = getAskCliCommand();
    const configured = isAskConfigured();
    const skillId = getSkillId(askCmd);

    console.log('==================================================');
    console.log('🔄 Updating Alexa Skill Endpoint');
    console.log('==================================================');
    console.log(`Skill ID: ${skillId}`);
    console.log(`New URL:  ${url}`);

    // Update skill-package/skill.json
    if (!fs.existsSync(SKILL_JSON_PATH)) {
        console.error(`❌ Error: ${SKILL_JSON_PATH} not found.`);
        return { success: false, reason: 'MISSING_SKILL_JSON' };
    }

    try {
        const skillData = JSON.parse(fs.readFileSync(SKILL_JSON_PATH, 'utf8'));
        if (!skillData.manifest) skillData.manifest = {};
        if (!skillData.manifest.apis) skillData.manifest.apis = {};
        if (!skillData.manifest.apis.custom) skillData.manifest.apis.custom = {};
        if (!skillData.manifest.apis.custom.endpoint) skillData.manifest.apis.custom.endpoint = {};

        skillData.manifest.apis.custom.endpoint.uri = url;
        skillData.manifest.apis.custom.endpoint.sslCertificateType = 'Wildcard';

        fs.writeFileSync(SKILL_JSON_PATH, JSON.stringify(skillData, null, 2), 'utf8');
        console.log('✔ Updated skill.json locally');
    } catch (err) {
        console.error('❌ Failed to update skill.json:', err.message);
        return { success: false, reason: 'SKILL_JSON_WRITE_ERROR' };
    }

    // Save .tunnel_url for the server
    try {
        fs.writeFileSync(TUNNEL_URL_FILE, url, 'utf8');
    } catch (e) {}

    if (!askCmd || !configured) {
        console.log('\n--------------------------------------------------');
        if (!askCmd) {
            console.log('⚠️  ASK CLI is not installed on this machine.');
        } else {
            console.log('⚠️  ASK CLI is installed, but not logged in (~/.ask/cli_config missing).');
        }
        console.log('👉 To enable 100% AUTOMATIC URL updates at the Alexa Developer Console:');
        console.log('   1. Run: npm install -g ask-cli');
        console.log('   2. Run: ask configure');
        console.log('   (This opens your browser once to log into your Amazon account - takes 1 minute)');
        console.log('--------------------------------------------------');
        console.log('\n👉 Manual fallback for now:');
        console.log(`   1. Open: https://developer.amazon.com/alexa/console/ask`);
        console.log(`   2. YouTube Music -> Endpoints -> HTTPS`);
        console.log(`   3. Default Region: ${url}`);
        console.log(`   4. SSL type: "sub-domain of a domain that has a wildcard certificate..."`);
        console.log(`   5. Click "Save Endpoints"`);
        console.log('==================================================\n');
        return { success: true, url, deployed: false };
    }

    console.log('📡 Deploying updated endpoint to Alexa...');

    try {
        const manifestArg = `file:skill-package/skill.json`;
        const cmd = `${askCmd} smapi update-skill-manifest -s "${skillId}" -g development --manifest "${manifestArg}"`;
        execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        console.error('⚠️  ASK CLI update-skill-manifest error:', (err.stderr || err.message).toString().trim());
        console.log(`👉 You can update manually in Alexa Developer Console: ${url}`);
        return { success: false, url, deployed: false, error: err.message };
    }

    console.log('🏗️  Triggering skill build to apply endpoint changes...');
    const tempModel = path.join(PROJECT_DIR, '.temp_model.json');

    try {
        const modelOutput = execSync(`${askCmd} smapi get-interaction-model -s "${skillId}" -g development -l en-US`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        if (modelOutput && modelOutput.trim().length > 10) {
            fs.writeFileSync(tempModel, modelOutput.trim(), 'utf8');
        }
    } catch (e) {}

    if (fs.existsSync(tempModel) && fs.statSync(tempModel).size > 10) {
        try {
            execSync(`${askCmd} smapi set-interaction-model -s "${skillId}" -g development -l en-US --interaction-model "file:${tempModel}"`, {
                stdio: ['ignore', 'ignore', 'ignore']
            });
            console.log('✔ Skill build queued successfully.');

            // Spinner animation and status polling loop matching Android output
            const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            let spinnerIdx = 0;
            let buildStatus = 'IN_PROGRESS';
            let elapsed = 0;

            while (buildStatus === 'IN_PROGRESS' && elapsed < 60) {
                const frame = spinner[spinnerIdx];
                spinnerIdx = (spinnerIdx + 1) % spinner.length;

                process.stdout.write(`\r⏳ Building Alexa skill model ${frame} [${elapsed}s] `);

                // Poll status every 3 seconds (6 iterations * 0.5s)
                if (elapsed > 0 && elapsed % 3 === 0) {
                    try {
                        const statusOut = execSync(`${askCmd} smapi get-skill-status --skill-id "${skillId}"`, {
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'ignore']
                        });
                        if (statusOut.includes('"FAILED"')) {
                            buildStatus = 'FAILED';
                            break;
                        } else if (statusOut.includes('"SUCCEEDED"') && !statusOut.includes('"IN_PROGRESS"')) {
                            buildStatus = 'SUCCEEDED';
                            break;
                        }
                    } catch (e) {}
                }

                await new Promise(r => setTimeout(r, 500));
                elapsed += 1;
            }

            if (buildStatus === 'SUCCEEDED') {
                process.stdout.write('\r✔ Alexa skill build completed! [SUCCEEDED]          \n');
            } else if (buildStatus === 'FAILED') {
                process.stdout.write('\r❌ Alexa skill build failed. Check Alexa Console.   \n');
            } else {
                process.stdout.write('\rℹ️  Build continuing in background on Alexa servers.  \n');
            }
        } catch (e) {
            console.log('⚠️  Could not trigger build loop.');
        } finally {
            try { fs.unlinkSync(tempModel); } catch (e) {}
        }
    } else {
        console.log('ℹ️  Interaction model build skipped (endpoint update applied directly).');
    }

    // Save last deployed URL
    try {
        fs.writeFileSync(LAST_DEPLOYED_URL_FILE, url, 'utf8');
    } catch (e) {}

    console.log('');
    console.log('==================================================');
    console.log('🎉 Alexa Skill endpoint updated successfully!');
    console.log(`👉 ${url}`);
    console.log('==================================================');
    return { success: true, url, deployed: true };
}

if (require.main === module) {
    const targetUrl = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
    updateEndpoint(targetUrl).then(res => {
        if (!res.success && res.reason === 'INVALID_URL') {
            process.exit(1);
        }
    });
}

module.exports = { updateEndpoint };
