class FAACClient {
    /**
     * Create a FAAC client instance
     * @param {number} port - WebSocket server port
     * @param {object} options - Configuration options
     */
    constructor(port = 8080, options = {}) {
        this.port = port;
        this.url = `ws://localhost:${port}`;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
        this.reconnectDelay = options.reconnectDelay || 3000;
        this.debug = options.debug || false;
        this.handlers = {
            message: options.onMessage || null,
            open: options.onOpen || null,
            close: options.onClose || null,
            error: options.onError || null
        };
        this.messageQueue = [];
        this.isConnected = false;
    }

    /**
     * Connect to the WebSocket server
     */
    connect() {
        if (this.ws) {
            this._log('Already connected or connecting');
            return;
        }

        this._log(`Connecting to ${this.url}`);
        this.ws = new WebSocket(this.url);

        this.ws.onopen = (event) => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this._log('Connected to FAAC server');
            this._processQueue();
            if (this.handlers.open) {
                this.handlers.open(event);
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this._log('Received:', data);
                if (this.handlers.message) {
                    this.handlers.message(data);
                }
            } catch (e) {
                this._log('Error parsing message:', e);
            }
        };

        this.ws.onclose = (event) => {
            this.isConnected = false;
            this._log(`Disconnected (code: ${event.code}, reason: ${event.reason})`);
            if (this.handlers.close) {
                this.handlers.close(event);
            }
            this._attemptReconnect();
        };

        this.ws.onerror = (error) => {
            this._log('WebSocket error:', error);
            if (this.handlers.error) {
                this.handlers.error(error);
            }
        };
    }

    /**
     * Send a message to the server
     * @param {object} data - Data to send
     */
    send(data) {
        if (!this.isConnected) {
            this._log('Queueing message (not connected)');
            this.messageQueue.push(data);
            return;
        }

        try {
            const message = JSON.stringify(data);
            this.ws.send(message);
            this._log('Sent:', data);
        } catch (e) {
            this._log('Error sending message:', e);
        }
    }

    /**
     * Disconnect from the server
     */
    disconnect() {
        if (this.ws) {
            this._log('Disconnecting...');
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
        }
    }

    /**
     * Register an event handler
     * @param {string} event - Event name ('message', 'open', 'close', 'error')
     * @param {function} handler - Handler function
     */
    on(event, handler) {
        if (this.handlers.hasOwnProperty(event)) {
            this.handlers[event] = handler;
        } else {
            this._log(`Unknown event type: ${event}`);
        }
    }

    /**
     * Attempt to reconnect if connection is lost
     * @private
     */
    _attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this._log('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        this._log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect();
        }, this.reconnectDelay);
    }

    /**
     * Process queued messages
     * @private
     */
    _processQueue() {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            this.send(message);
        }
    }

    /**
     * Log debug messages
     * @private
     */
    _log(...args) {
        if (this.debug) {
            console.log('[FAAC Client]', ...args);
        }
    }
}

window.FAACClient = FAACClient

// Example usage:
/*
// Create client instance
const faac = new FAACClient(8080, {
    debug: true,
    maxReconnectAttempts: 3,
    onMessage: (data) => {
        console.log('Custom message handler:', data);
        // Handle different message types
        if (data.type === 'completion') {
            console.log('Completion suggestions:', data.suggestions);
        }
    },
    onOpen: () => {
        console.log('Connection established!');
        // Send initial message
        faac.send({
            type: 'handshake',
            client: 'userscript',
            version: '1.0'
        });
    }
});

// Connect to server
faac.connect();

// Send a message later
setTimeout(() => {
    faac.send({
        type: 'request',
        content: 'Get me some completions'
    });
}, 2000);

// Add additional handlers
faac.on('error', (err) => {
    console.error('Connection error:', err);
});
*/