const fs = require('fs');
const { execSync } = require('child_process');

const credsFile = fs.readFileSync('/Users/abhinav/.aws/credentials', 'utf8');
const accessKey = (credsFile.match(/aws_access_key_id\s*=\s*(.*)/) || [])[1].trim();
const secretKey = (credsFile.match(/aws_secret_access_key\s*=\s*(.*)/) || [])[1].trim();

const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
    AWS_DEFAULT_REGION: 'us-east-1'
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
    const zipPath = '/Users/abhinav/.gemini/antigravity/scratch/youtube-music-alexa-skill/lambda.zip';
    const skillId = 'amzn1.ask.skill.7f421724-a09e-4fe3-a417-08b963ca4bd1';
    const roleArn = 'arn:aws:iam::027677879594:role/service-role/youtube-music-alexa-skill-role-lhuxrgai';

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
        const manifestPath = '/Users/abhinav/.gemini/antigravity/scratch/youtube-music-alexa-skill/skill-package/skill.json';
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
