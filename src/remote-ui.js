/* Desktop-only controls. Browser pages have no commands to start, stop, rotate, or reveal tokens. */
(function (root) {
    'use strict';
    const bridge = root.terminalCanvas;
    if (!bridge || bridge.remote || !root.__TAURI__?.core) return;
    const button = document.querySelector('#remote-settings');
    const dialog = document.createElement('dialog');
    dialog.id = 'remote-dialog';
    dialog.innerHTML = `<h2>Browser access</h2>
        <p class="dialog-description">Connect a browser on this computer to running terminals. The desktop controls the workspace and terminal sizes. LAN/VPN access is planned.</p>
        <label class="field-label" for="remote-port">Port (0 chooses an available port)</label>
        <input id="remote-port" type="number" min="0" max="65535" value="0">
        <p id="remote-state" class="info-copy" role="status">Off</p>
        <div id="remote-credentials" hidden>
            <label class="field-label" for="remote-control-token">Controller token · permits shell input</label>
            <input id="remote-control-token" readonly spellcheck="false" autocomplete="off">
            <label class="field-label" for="remote-view-token">Viewer token · read only</label>
            <input id="remote-view-token" readonly spellcheck="false" autocomplete="off">
            <p class="field-hint">Keep these tokens private. Tokens stay in memory; sessions expire after 12 hours. Stopping access disconnects everyone.</p>
        </div>
        <p id="remote-error" class="form-error" role="alert"></p>
        <div class="dialog-footer">
            <button class="button" id="remote-rotate">Rotate tokens</button>
            <button class="button" id="remote-revoke">Revoke sessions</button>
            <button class="button primary" id="remote-start-stop">Start</button>
            <button class="button" id="remote-done">Done</button>
        </div>`;
    document.body.append(dialog);
    const find = selector => dialog.querySelector(selector);
    let state = { running: false, clients: 0 }, busy = false;
    const render = update => {
        state = { ...state, ...update };
        button.textContent = state.running ? `Browser access · ${state.clients} connected` : 'Browser access · Off';
        button.classList.toggle('remote-running', state.running);
        document.querySelector('#remote-address').hidden = !state.running;
        document.querySelector('#remote-address').textContent = state.running ? state.url : '';
        find('#remote-state').textContent = state.running ? `${state.url} · ${state.clients} connected` : 'Off · no browser server listening';
        find('#remote-credentials').hidden = !state.running;
        find('#remote-port').disabled = state.running || busy;
        find('#remote-start-stop').textContent = state.running ? 'Stop access' : 'Start';
        find('#remote-start-stop').disabled = busy;
        for (const id of ['#remote-rotate', '#remote-revoke']) find(id).disabled = !state.running || busy;
        find('#remote-control-token').value = state.running ? state.controlToken || '' : '';
        find('#remote-view-token').value = state.running ? state.viewToken || '' : '';
        if (!state.running) { delete state.controlToken; delete state.viewToken; }
    };
    const call = async (action, payload) => {
        if (busy) return;
        busy = true; render({}); find('#remote-error').textContent = '';
        try {
            const result = await bridge.invoke(action, payload);
            if (result?.error) throw new Error(result.error);
            render(result);
        } catch (failure) { find('#remote-error').textContent = failure.message; }
        finally { busy = false; render({}); }
    };
    button.hidden = false;
    button.onclick = async () => { await call('remote-status'); dialog.showModal(); };
    find('#remote-done').onclick = () => {
        dialog.close(); find('#remote-control-token').value = ''; find('#remote-view-token').value = '';
    };
    find('#remote-start-stop').onclick = () => call(state.running ? 'remote-stop' : 'remote-start', { port: Number(find('#remote-port').value) });
    find('#remote-rotate').onclick = () => call('remote-rotate');
    find('#remote-revoke').onclick = () => call('remote-revoke');
    bridge.onEvent(event => { if (event.type === 'remote-status') render(event); });
})(window);
