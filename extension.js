const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');

let server = null;
let clients = new Set();
let typingTimeout = null;
let statusBarItem = null;
let lastRequestPosition = null;
let lastRequestTimestamp = null;
let previewDecoration = null;
let activePreview = null;
let cursorDisposable = null;
let previewTimeout = null;
let previewActive = false;

function activate(context) {
    console.log('FAAC extension is now active!');
    
    // Set initial context
    vscode.commands.executeCommand('setContext', 'suggestionPreviewVisible', false);
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('faac.startServer', startWebSocketServer),
        vscode.commands.registerCommand('faac.stopServer', stopWebSocketServer),
        vscode.commands.registerCommand('faac.restartServer', () => {
            stopWebSocketServer();
            setTimeout(startWebSocketServer, 1000);
        }),
        vscode.commands.registerCommand('faac.handleTab', () => {
            if (previewActive) {
                insertSuggestion();
                return;
            }
            // Fall back to default tab behavior
            vscode.commands.executeCommand('tab');
        })
    );
    
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(plug) FAAC: Disconnected";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    // Event listeners
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(handleTextChange),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor === vscode.window.activeTextEditor) {
                handleTextChange(null);
            }
        })
    );
    
    // Start server automatically if enabled
    const config = vscode.workspace.getConfiguration('faac');
    if (config.get('autoStartServer', true)) {
        setTimeout(startWebSocketServer, 1000);
    }
}

function insertSuggestion() {
    if (!activePreview || !previewActive) return;
    
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    editor.edit(editBuilder => {
        editBuilder.insert(activePreview.position, activePreview.suggestion.insertText);
    }).then(() => {
        const newPos = activePreview.position.translate(
            0, 
            activePreview.suggestion.insertText.length
        );
        editor.selection = new vscode.Selection(newPos, newPos);
        clearSuggestionPreview();
    });
}

function startWebSocketServer() {
    if (server) {
        vscode.window.showWarningMessage('FAAC server is already running');
        return;
    }
    
    const config = vscode.workspace.getConfiguration('faac');
    const port = config.get('port', 8080);
    
    try {
        server = http.createServer();
        server.on('close', () => console.log('FAAC WebSocket server closed'));
        
        server.on('upgrade', (request, socket, head) => {
            const key = request.headers['sec-websocket-key'];
            const acceptKey = generateAcceptKey(key);
            const responseHeaders = [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${acceptKey}`,
                '\r\n'
            ].join('\r\n');
            socket.write(responseHeaders);
            
            clients.add(socket);
            updateStatusBar('Connected', clients.size);
            console.log(`Client connected. Total clients: ${clients.size}`);
            
            socket.on('data', (buffer) => {
                try {
                    const message = parseWebSocketFrame(buffer);
                    if (message) {
                        const data = JSON.parse(message);
                        handleServerMessage(data);
                    }
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            });
            
            socket.on('close', () => {
                clients.delete(socket);
                updateStatusBar(clients.size > 0 ? 'Connected' : 'Listening', clients.size);
                console.log(`Client disconnected. Total clients: ${clients.size}`);
            });
            
            socket.on('error', (error) => {
                console.error('WebSocket client error:', error);
                clients.delete(socket);
                updateStatusBar(clients.size > 0 ? 'Connected' : 'Listening', clients.size);
            });
        });
        
        server.listen(port, () => {
            updateStatusBar('Listening', 0);
            vscode.window.showInformationMessage(`FAAC WebSocket server started on port ${port}`);
        });
        
        server.on('error', (error) => {
            console.error('Server error:', error);
            if (error.code === 'EADDRINUSE') {
                vscode.window.showErrorMessage(`Port ${port} already in use.`);
            } else {
                vscode.window.showErrorMessage(`FAAC server error: ${error.message}`);
            }
            updateStatusBar('Server Error', 0);
            server = null;
        });
        
    } catch (error) {
        console.error('Failed to start server:', error);
        vscode.window.showErrorMessage(`Failed to start FAAC server: ${error.message}`);
        updateStatusBar('Failed', 0);
        server = null;
    }
}

function generateAcceptKey(key) {
    const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    return crypto.createHash('sha1').update(key + MAGIC).digest('base64');
}

function parseWebSocketFrame(buffer) {
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;
    if (opcode === 0x8) return null; // Close frame
    if (opcode !== 0x1) return null; // Only text
    
    let len = buffer[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
        len = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (len === 127) {
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
    }
    
    const masked = Boolean(buffer[1] & 0x80);
    let mask;
    if (masked) {
        mask = buffer.slice(offset, offset + 4);
        offset += 4;
    }
    
    const payload = buffer.slice(offset, offset + len);
    if (masked) {
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
        }
    }
    
    return payload.toString('utf8');
}

function createWebSocketFrame(data) {
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length;
    let frame;
    
    if (len < 126) {
        frame = Buffer.allocUnsafe(2 + len);
        frame[0] = 0x81;
        frame[1] = len;
        payload.copy(frame, 2);
    } else if (len < 65536) {
        frame = Buffer.allocUnsafe(4 + len);
        frame[0] = 0x81;
        frame[1] = 126;
        frame.writeUInt16BE(len, 2);
        payload.copy(frame, 4);
    } else {
        frame = Buffer.allocUnsafe(10 + len);
        frame[0] = 0x81;
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(len), 2);
        payload.copy(frame, 10);
    }
    
    return frame;
}

function stopWebSocketServer() {
    if (!server) return;
    for (const client of clients) {
        try { client.destroy(); } catch {}
    }
    clients.clear();
    const srv = server;
    server = null;
    srv.close((err) => {
        if (err) console.error('Error closing server:', err);
        else console.log('Server closed');
        updateStatusBar('Stopped', 0);
        vscode.window.showInformationMessage('FAAC server stopped');
    });
    setTimeout(() => {
        if (srv.listening && srv.closeAllConnections) {
            try { srv.closeAllConnections(); } catch {}
        }
    }, 5000);
}

function updateStatusBar(status, clientCount = 0) {
    const icons = {
        'Connected': '$(check)',
        'Listening': '$(radio-tower)',
        'Error': '$(alert)',
        'Server Error': '$(alert)',
        'Failed': '$(alert)',
        'Stopped': '$(circle-slash)'
    };
    const icon = icons[status] || '$(plug)';
    const info = clientCount > 0 ? ` (${clientCount} client${clientCount>1?'s':''})` : '';
    statusBarItem.text = `${icon} FAAC: ${status}${info}`;
}

function handleTextChange(event) {
    const config = vscode.workspace.getConfiguration('faac');
    if (!config.get('enableAutoTrigger', true)) return;
    
    const delay = config.get('typingDelay', 500);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(sendCurrentContext, delay);
}

function sendCurrentContext() {
    const config = vscode.workspace.getConfiguration('faac');
    const debug = config.get('enableDebugLogging', false);
    
    if (clients.size === 0 || !vscode.window.activeTextEditor) return;
    
    const editor = vscode.window.activeTextEditor;
    const doc = editor.document;
    const pos = editor.selection.active;
    
    // Check if file extension is allowed
    const allowedExtensions = config.get('allowedFileExtensions', ['*']);
    const fileExt = doc.fileName.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes('*') && !allowedExtensions.includes(`.${fileExt}`)) {
        if (debug) console.log(`FAAC: Skipping ${doc.fileName} - extension not allowed`);
        return;
    }
    
    lastRequestPosition = { line: pos.line, character: pos.character };
    lastRequestTimestamp = Date.now();

    let text = doc.getText();
    const maxLen = config.get('maxDocumentLength', 10000);
    const sendFull = config.get('sendFullDocument', false);
    
    if (!sendFull && text.length > maxLen) {
        const contextLines = config.get('contextLines', 50);
        const start = Math.max(0, pos.line - contextLines);
        const end = Math.min(doc.lineCount, pos.line + contextLines);
        text = doc.getText(new vscode.Range(start, 0, end, 0));
    }

    // Insert cursor marker if enabled
    if (config.get('enableCursorMarker', true)) {
        const cursorMarker = config.get('cursorMarker', '[CURSOR HERE]');
        const lines = text.split('\n');
        const cursorLine = lines[pos.line];
        lines[pos.line] = cursorLine.slice(0, pos.character) + cursorMarker + cursorLine.slice(pos.character);
        text = lines.join('\n');
    }

    // Add prompt prefix/suffix
    const promptPrefix = config.get('promptPrefix', 'Complete the following code. The cursor is at the marked position:');
    const promptSuffix = config.get('promptSuffix', 'Provide a relevant code completion for the cursor position:');
    text = `${promptPrefix}\n\n${text}\n\n${promptSuffix}`;

    const contextData = {
        type: 'context',
        text,
        cursor: { line: pos.line, character: pos.character },
        language: doc.languageId,
        filename: doc.fileName,
        timestamp: lastRequestTimestamp,
        requestId: crypto.randomUUID()
    };

    if (debug) console.log('FAAC: Sending context', contextData);

    const frame = createWebSocketFrame(JSON.stringify(contextData));
    const dead = [];
    for (const client of clients) {
        try { client.write(frame); }
        catch { dead.push(client); }
    }
    dead.forEach(dc => clients.delete(dc));
    if (dead.length) updateStatusBar(clients.size>0?'Connected':'Listening', clients.size);
}

function handleServerMessage(data) {
    const config = vscode.workspace.getConfiguration('faac');
    const debug = config.get('enableDebugLogging', false);
    
    if (debug) console.log('FAAC: Received message', data);
    
    if (data.type !== 'completion' || !data.suggestions || data.suggestions.length === 0) {
        return;
    }

    // Discard if cursor moved
    if (!vscode.window.activeTextEditor || !lastRequestPosition) return;
    const cp = vscode.window.activeTextEditor.selection.active;
    if (cp.line !== lastRequestPosition.line || cp.character !== lastRequestPosition.character) {
        if (debug) console.log('FAAC: Discarding suggestion - cursor moved');
        return;
    }

    // Discard old
    if (data.timestamp && lastRequestTimestamp) {
        if (Math.abs(data.timestamp - lastRequestTimestamp) > 10000) {
            if (debug) console.log('FAAC: Discarding suggestion - stale response');
            return;
        }
    }

    // Take only the first suggestion
    const suggestion = data.suggestions[0];
    const previewSuggestion = {
        text: suggestion.text || suggestion,
        insertText: suggestion.insertText || suggestion.text || suggestion,
        detail: suggestion.detail || 'AI Suggestion'
    };

    if (debug) console.log('FAAC: Showing suggestion', previewSuggestion);
    
    // Show preview
    showSuggestionPreview(previewSuggestion);
}

function showSuggestionPreview(suggestion) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Clear any existing preview
    clearSuggestionPreview();

    // Create decoration type if it doesn't exist
    if (!previewDecoration) {
        previewDecoration = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: suggestion.insertText,
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                margin: '0 0 0 0.2em', // Reduced from 1em to 0.2em
                fontStyle: 'italic'
            },
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
    }

    // Set the active preview
    activePreview = {
        suggestion: suggestion,
        position: editor.selection.active
    };
    previewActive = true;
    vscode.commands.executeCommand('setContext', 'suggestionPreviewVisible', true);

    // Apply decoration
    const range = new vscode.Range(
        editor.selection.active,
        editor.selection.active
    );
    editor.setDecorations(previewDecoration, [{
        range: range,
        renderOptions: {
            after: {
                contentText: suggestion.insertText,
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                margin: '0 0 0 0.2em', // Reduced from 1em to 0.2em
                fontStyle: 'italic'
            }
        }
    }]);

    // Clean up any existing listeners
    if (cursorDisposable) cursorDisposable.dispose();
    if (previewTimeout) clearTimeout(previewTimeout);

    // Clear preview if cursor moves
    cursorDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
        clearSuggestionPreview();
    });

    // Auto-clear after timeout
    const timeout = vscode.workspace.getConfiguration('faac').get('previewTimeout', 5000);
    previewTimeout = setTimeout(() => {
        clearSuggestionPreview();
    }, timeout);
}

function clearSuggestionPreview() {
    if (previewDecoration && vscode.window.activeTextEditor) {
        vscode.window.activeTextEditor.setDecorations(previewDecoration, []);
    }
    activePreview = null;
    previewActive = false;
    vscode.commands.executeCommand('setContext', 'suggestionPreviewVisible', false);
    if (cursorDisposable) {
        cursorDisposable.dispose();
        cursorDisposable = null;
    }
    if (previewTimeout) {
        clearTimeout(previewTimeout);
        previewTimeout = null;
    }
}


function deactivate() {
    console.log('FAAC extension deactivating...');
    clearSuggestionPreview();
    if (typingTimeout) clearTimeout(typingTimeout);
    stopWebSocketServer();
    if (statusBarItem) statusBarItem.dispose();
    console.log('FAAC extension deactivated');
}

module.exports = {
    activate,
    deactivate
};