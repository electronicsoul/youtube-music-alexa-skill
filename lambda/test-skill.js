const { handler } = require('./index.js');

const samplePlaySongRequest = {
    version: '1.0',
    session: {
        new: false,
        sessionId: 'amzn1.echo-api.session.test',
        application: { applicationId: 'amzn1.ask.skill.test' },
        user: { userId: 'amzn1.ask.account.test' }
    },
    context: {
        System: {
            application: { applicationId: 'amzn1.ask.skill.test' },
            user: { userId: 'amzn1.ask.account.test' }
        }
    },
    request: {
        type: 'IntentRequest',
        requestId: 'amzn1.echo-api.request.test',
        timestamp: new Date().toISOString(),
        locale: 'en-US',
        intent: {
            name: 'PlaySongIntent',
            confirmationStatus: 'NONE',
            slots: {
                songQuery: {
                    name: 'songQuery',
                    value: 'Starboy The Weeknd',
                    confirmationStatus: 'NONE'
                }
            }
        }
    }
};

console.log('--- Testing Alexa Skill Handler with songQuery: "Starboy The Weeknd" ---');
handler(samplePlaySongRequest, null, (err, response) => {
    if (err) {
        console.error('Skill Execution Error:', err);
        process.exit(1);
    }
    console.log('\n--- Alexa Skill Response Payload ---');
    console.log(JSON.stringify(response, null, 2));
});
