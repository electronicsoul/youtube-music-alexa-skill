const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
try { require('./lambda/env.js'); } catch (e) {}

const credsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
let accessKey = process.env.AWS_ACCESS_KEY_ID || '';
let secretKey = process.env.AWS_SECRET_ACCESS_KEY || '';

if ((!accessKey || !secretKey) && fs.existsSync(credsPath)) {
    const credsFile = fs.readFileSync(credsPath, 'utf8');
    accessKey = accessKey || ((credsFile.match(/aws_access_key_id\s*=\s*(.*)/) || [])[1] || '').trim();
    secretKey = secretKey || ((credsFile.match(/aws_secret_access_key\s*=\s*(.*)/) || [])[1] || '').trim();
}

const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
    AWS_DEFAULT_REGION: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
};

function runAws(cmd) {
    try {
        console.log(`Running: ${cmd}`);
        const stdout = execSync(cmd, { env, encoding: 'utf8' });
        console.log(stdout);
        return { success: true, stdout };
    } catch (err) {
        console.error('Command Error:', err.stderr || err.message);
        return { success: false, error: err.stderr || err.message };
    }
}

async function main() {
    console.log('=== Step 1: Checking AWS Identity ===');
    runAws('aws sts get-caller-identity');

    console.log('\n=== Step 2: Creating or Updating Lambda Function ===');
    const zipPath = path.join(__dirname, 'lambda.zip');
    const skillId = process.env.ALEXA_SKILL_ID || process.env.SKILL_ID || (fs.existsSync(path.join(__dirname, '.skill_id')) ? fs.readFileSync(path.join(__dirname, '.skill_id'), 'utf8').trim() : '');
    const roleArn = process.env.AWS_ROLE_ARN || '';

    if (!roleArn) {
        console.error('❌ Error: AWS_ROLE_ARN is required to create a Lambda function via CLI');
    }

    let createRes = runAws(`aws lambda create-function --function-name youtube-music-alexa-skill --runtime nodejs18.x --role ${roleArn} --handler index.handler --zip-file fileb://${zipPath} --region us-east-1 --timeout 20 --memory-size 512`);

    if (!createRes.success && createRes.error.includes('ResourceConflictException')) {
        console.log('Function exists. Updating code and configuration...');
        runAws(`aws lambda update-function-code --function-name youtube-music-alexa-skill --zip-file fileb://${zipPath} --region us-east-1`);
        runAws(`aws lambda update-function-configuration --function-name youtube-music-alexa-skill --memory-size 512 --timeout 20 --region us-east-1`);
    }

    console.log('\n=== Step 3: Adding Alexa Skills Kit Trigger Permission ===');
    runAws(`aws lambda add-permission --function-name youtube-music-alexa-skill --statement-id alexa-skills-kit-trigger --action lambda:InvokeFunction --principal alexa-appkit.amazon.com --event-source-token ${skillId} --region us-east-1`);

    console.log('\n=== Step 4: Getting Function ARN ===');
    const getRes = runAws(`aws lambda get-function --function-name youtube-music-alexa-skill --region us-east-1`);
    if (getRes.success) {
        const funcData = JSON.parse(getRes.stdout);
        const arn = funcData.Configuration.FunctionArn;
        console.log('\nSUCCESS! Lambda ARN:', arn);

        // Update skill.json
        const manifestPath = path.join(__dirname, 'skill-package', 'skill.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.manifest.apis = {
            custom: {
                endpoint: { uri: arn },
                interfaces: [{ type: 'AUDIO_PLAYER' }]
            }
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        console.log('\n=== Step 5: Deploying Skill Endpoint with ask deploy ===');
        const askRes = runAws('ask deploy');
        console.log('ask deploy result:', askRes);
    }
}

main().catch(console.error);
