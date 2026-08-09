const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AWS = require('./lambda/node_modules/aws-sdk');

// Parse credentials from ~/.aws/credentials
const credsFile = fs.readFileSync('/Users/abhinav/.aws/credentials', 'utf8');
const accessKey = (credsFile.match(/aws_access_key_id\s*=\s*(.*)/) || [])[1].trim();
const secretKey = (credsFile.match(/aws_secret_access_key\s*=\s*(.*)/) || [])[1].trim();

AWS.config.update({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    region: 'us-east-1'
});

const lambda = new AWS.Lambda();
const iam = new AWS.IAM();

const FUNCTION_NAME = 'youtube-music-alexa-skill';
const SKILL_ID = 'amzn1.ask.skill.7f421724-a09e-4fe3-a417-08b963ca4bd1';
const ROLE_NAME = 'youtube_alexa_skill_lambda_role';

const ASSUME_ROLE_POLICY = {
    Version: '2012-10-17',
    Statement: [
        {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole'
        }
    ]
};

async function main() {
    console.log('--- Step 1: Setting up IAM Role ---');
    let roleArn;
    try {
        const getRoleRes = await iam.getRole({ RoleName: ROLE_NAME }).promise();
        roleArn = getRoleRes.Role.Arn;
        console.log('Using existing IAM Role:', roleArn);
    } catch (err) {
        if (err.code === 'NoSuchEntity') {
            console.log('Creating IAM Role:', ROLE_NAME);
            const createRoleRes = await iam.createRole({
                RoleName: ROLE_NAME,
                AssumeRolePolicyDocument: JSON.stringify(ASSUME_ROLE_POLICY)
            }).promise();
            roleArn = createRoleRes.Role.Arn;
            await iam.attachRolePolicy({
                RoleName: ROLE_NAME,
                PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
            }).promise();
            console.log('Created IAM Role:', roleArn);
            // Wait 10 seconds for IAM role propagation
            console.log('Waiting 10s for IAM role propagation...');
            await new Promise(r => setTimeout(r, 10000));
        } else {
            throw err;
        }
    }

    console.log('\n--- Step 2: Reading Zip Package ---');
    const zipPath = path.join(__dirname, 'lambda.zip');
    const zipBuffer = fs.readFileSync(zipPath);

    console.log('\n--- Step 3: Deploying Lambda Function ---');
    let functionArn;
    try {
        const getFuncRes = await lambda.getFunction({ FunctionName: FUNCTION_NAME }).promise();
        functionArn = getFuncRes.Configuration.FunctionArn;
        console.log('Function exists. Updating code for:', functionArn);
        await lambda.updateFunctionCode({
            FunctionName: FUNCTION_NAME,
            ZipFile: zipBuffer
        }).promise();
    } catch (err) {
        if (err.code === 'ResourceNotFoundException') {
            console.log('Creating new Lambda function:', FUNCTION_NAME);
            const createFuncRes = await lambda.createFunction({
                FunctionName: FUNCTION_NAME,
                Runtime: 'nodejs18.x',
                Role: roleArn,
                Handler: 'index.handler',
                Code: { ZipFile: zipBuffer },
                Timeout: 30,
                MemorySize: 256,
                Description: 'Alexa Skill Backend for YouTube Music'
            }).promise();
            functionArn = createFuncRes.FunctionArn;
            console.log('Created Lambda function:', functionArn);
        } else {
            throw err;
        }
    }

    console.log('\n--- Step 4: Adding Alexa Skills Kit Trigger Permission ---');
    try {
        await lambda.addPermission({
            FunctionName: FUNCTION_NAME,
            StatementId: 'alexa-skills-kit-trigger',
            Action: 'lambda:InvokeFunction',
            Principal: 'alexa-appkit.amazon.com',
            EventSourceToken: SKILL_ID
        }).promise();
        console.log('Added Alexa Skills Kit permission to Lambda function');
    } catch (err) {
        if (err.code === 'ResourceConflictException') {
            console.log('Permission alexa-skills-kit-trigger already exists');
        } else {
            console.warn('Permission warning:', err.message);
        }
    }

    console.log('\n--- Step 5: Updating skill-package/skill.json with Endpoint ---');
    const manifestPath = path.join(__dirname, 'skill-package', 'skill.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    manifest.manifest.apis = {
        custom: {
            endpoint: {
                uri: functionArn
            },
            interfaces: [
                { type: 'AUDIO_PLAYER' }
            ]
        }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('Updated skill.json with Lambda ARN:', functionArn);

    console.log('\n--- Step 6: Running ask deploy to link endpoint ---');
    try {
        const deployOutput = execSync('ask deploy', { cwd: __dirname, encoding: 'utf8' });
        console.log(deployOutput);
    } catch (deployErr) {
        console.log('ask deploy output:', deployErr.stdout || deployErr.message);
    }

    console.log('\n=== AWS LAMBDA & ALEXA SKILL DEPLOYMENT COMPLETE ===');
    console.log('Lambda ARN:', functionArn);
}

main().catch(err => {
    console.error('\nDeployment Error:', err);
    process.exit(1);
});
