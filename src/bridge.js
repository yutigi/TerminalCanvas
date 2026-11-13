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
    // The host accepts at most this many UTF-16 units in one input message.
    const INPUT_UNITS = 65536;
    // Longer input, such as a large paste, goes in numbered pieces the host joins in order. A
    // piece never ends inside a surrogate pair, because each one crosses IPC as text on its own.
    const pieces = data => {
        if (typeof data !== 'string' || data.length <= INPUT_UNITS) return [data];
        const result = [];
        for (let start = 0; start < data.length;) {
            let end = Math.min(start + INPUT_UNITS, data.length);
            const last = data.charCodeAt(end - 1);
            if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
            result.push(data.slice(start, end));
            start = end;
        }
        return result;
    };
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
            for (const piece of pieces(data)) {
                const seq = sequences.get(id) || 0;
                sequences.set(id, seq + 1);
                core.invoke('input', { id, data: piece, seq }).catch(report(id));
            }
        },
        resize(id, cols, rows) { core.invoke('resize', { id, cols, rows }).catch(report(id)); },
        acknowledge(id, amount) { core.invoke('ack', { id, amount }).catch(() => {}); },
        onEvent(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        }
    });
})(window);
