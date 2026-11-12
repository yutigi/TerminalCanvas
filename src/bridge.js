/* The desktop bridge: window.terminalCanvas on top of the Tauri host IPC. */
(function (root) {
    'use strict';
    const core = root.__TAURI__ && root.__TAURI__.core;
    if (root.terminalCanvas || !core) return;
    const listeners = new Set();
    const deliver = event => listeners.forEach(listener => listener(event));
    // IPC calls can arrive out of order, so each terminal's input is numbered and the host
    // writes it in that order.
    const sequences = new Map();
    // Rejected calls become { error } results, so renderer.js handles them as before.
    const settle = promise => promise.catch(error => ({ error: String(error && error.message || error) }));
    const report = id => error => deliver({ type: 'error', id, message: String(error && error.message || error) });
    root.terminalCanvas = Object.freeze({
        // Windows serves custom schemes as http://<scheme>.localhost.
        assetPrefix: root.location.protocol.startsWith('http') ? 'http://tc-asset.localhost/images/' : 'tc-asset://images/',
        invoke(action, payload) {
            if (typeof action !== 'string') return Promise.resolve({ error: 'Unsupported desktop command.' });
            if (action === 'initialize') {
                const events = new core.Channel();
                events.onmessage = deliver;
                sequences.clear();
                return settle(core.invoke('initialize', { events }));
            }
            if (action === 'import-image') {
                const bytes = payload && payload.bytes;
                if (!(bytes instanceof Uint8Array)) return Promise.resolve({ error: 'Invalid image data.' });
                return settle(core.invoke('import_image', bytes));
            }
            return settle(core.invoke(action.replaceAll('-', '_'), payload === undefined ? {} : { payload }));
        },
        input(id, data) {
            const seq = sequences.get(id) || 0;
            sequences.set(id, seq + 1);
            core.invoke('input', { id, data, seq }).catch(report(id));
        },
        resize(id, cols, rows) { core.invoke('resize', { id, cols, rows }).catch(report(id)); },
        acknowledge(id, amount) { core.invoke('ack', { id, amount }).catch(() => {}); },
        onEvent(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        }
    });
})(window);
