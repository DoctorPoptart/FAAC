// client.js
const WebSocket = require('ws');

const FAAC_PORT = 8080;
const FAAC_URL = `ws://localhost:${FAAC_PORT}`;

function sendPlaceholderCompletion(ws) {
    const placeholder = {
        type: 'completion',
        timestamp: Date.now(),
        suggestions: [
            {
                text: 'console.log("Hello from FAAC!");',
                insertText: 'console.log("Hello from FAAC!");',
                detail: 'Sample suggestion'
            }
        ]
    };
    ws.send(JSON.stringify(placeholder), (err) => {
        if (err) console.error('Error sending placeholder:', err);
        else console.log('✓ Placeholder completion sent');
    });
}

function startClient() {
    console.log(`Connecting to FAAC server at ${FAAC_URL}…`);
    const ws = new WebSocket(FAAC_URL);

    ws.on('open', () => {
        console.log('Connected to FAAC server.');
        // Send placeholder after a short delay
        setTimeout(() => sendPlaceholderCompletion(ws), 500);
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            console.log('Received from server:', msg);
            setTimeout(() => sendPlaceholderCompletion(ws), 500);
        } catch (e) {
            console.log('Received raw:', data.toString());
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Connection closed (code=${code}, reason=${reason})`);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
}

startClient();