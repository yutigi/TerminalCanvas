/* The browser transport preserves the renderer API without exposing desktop IPC commands. */
(function (root) {
    'use strict';
    if (root.terminalCanvas || root.__TAURI__ || !['http:', 'https:'].includes(root.location?.protocol)) return;
    const listeners = new Set(), buffered = [];
    let socket, initial, resolveInitial, rejectInitial, sequence = 0, role = 'view', disconnected = false;
    const deliver = event => {
        if (!listeners.size) buffered.push(event);
        else for (const listener of listeners) listener(event);
    };
    const fail = message => {
        if (disconnected) return;
        disconnected = true;
        rejectInitial?.(new Error(message));
        deliver({ type: 'remote-disconnected', message });
    };
    const initialize = () => {
        if (initial) return initial;
        initial = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
        const url = new URL('/ws', root.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new root.WebSocket(url.href);
        socket.onmessage = message => {
            let event;
            try { event = JSON.parse(message.data); } catch { fail('Invalid server response. Reload to reconnect.'); socket.close(); return; }
            if (event.type === 'remote-initialize') {
                role = event.role;
                resolveInitial(event);
            } else deliver(event);
        };
        socket.onclose = () => fail('Browser connection closed. Reload to reconnect or enter a new token.');
        socket.onerror = () => fail('Browser connection failed. Only one controller can connect; use a viewer token for another window.');
        return initial;
    };
    const error = message => ({ error: message });
    root.terminalCanvas = Object.freeze({
        remote: true,
        get role() { return role; },
        assetPrefix: '/images/',
        async invoke(action, payload) {
            try {
                if (action === 'initialize') return await initialize();
                // Browser clipboard access requires permission and a secure context (loopback qualifies).
                if (action === 'clipboard-read') return { text: await root.navigator.clipboard.readText() };
                if (action === 'clipboard-write') {
                    if (typeof payload !== 'string' || payload.length > 1048576) return error('Selection exceeds 1 MB.');
                    await root.navigator.clipboard.writeText(payload); return { ok: true };
                }
                return error('Use the desktop app to edit the workspace or start and stop terminals.');
            } catch (failure) { return error(String(failure.message || failure)); }
        },
        input(id, data) {
            if (role !== 'control' || disconnected || socket?.readyState !== root.WebSocket.OPEN) return;
            if (typeof data !== 'string') return;
            if (data.length > 1048576) { deliver({ type: 'error', id, message: 'Paste exceeds 1 MB.' }); return; }
            for (let start = 0; start < data.length;) {
                let end = Math.min(start + 65536, data.length);
                const last = data.charCodeAt(end - 1);
                if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
                // A stalled browser must not queue an unbounded stream of shell input.
                if (socket.bufferedAmount > 2 * 1024 * 1024) {
                    fail('Browser input queue is full. Reload to reconnect.'); socket.close(); return;
                }
                socket.send(JSON.stringify({ action: 'input', id, data: data.slice(start, end), seq: sequence++ }));
                start = end;
            }
        },
        resize() {}, // The desktop owns PTY dimensions.
        acknowledge() {}, // Only desktop rendering acknowledges PTY backpressure.
        onEvent(callback) {
            listeners.add(callback);
            for (const event of buffered.splice(0)) callback(event);
            return () => listeners.delete(callback);
        }
    });
})(window);
