const { initListener } = require('../src/event-listener');

const listener = initListener();

listener.on('event', (res) => {
    const parameters = res['parameters'];
    if (!parameters) return;

    // 252 is typically the Event Code
    const eventCode = parameters[252];
    if (eventCode) {
        // Exclude noisy events like move (typically < 100 or specific numbers) if desired,
        // but for now we log everything.
        console.log(`[Event] Code: ${eventCode} | Params:`, JSON.stringify(parameters, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    }
});

listener.on('request', (req) => {
    const parameters = req['parameters'];
    if (!parameters) return;

    // 253 is typically the Request ID
    const requestId = parameters[253];
    if (requestId) {
        console.log(`[Request] ID: ${requestId} | Params:`, Object.keys(parameters).join(', '));
    }
});

console.log('Listening for packets... ');
console.log('Please go into the game, select your network adapter when prompted, and perform a fishing action (cast, wait for bite, catch, and stop).');
console.log('Note the [Event] Codes that appear during fishing. They should be in the 300-400 range.');
