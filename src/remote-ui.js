/* Desktop-only controls. Browser pages have no commands to start, stop, rotate, or reveal tokens. */
(function (root) {
    'use strict';
    const bridge = root.terminalCanvas;
    if (!bridge) return;
    const button = document.querySelector('#remote-settings');
    if (bridge.remote) {
        const limits = document.createElement('dialog');
        limits.id = 'remote-limitations';
        limits.setAttribute('aria-labelledby', 'remote-limitations-title');
        limits.innerHTML = `<h2 id="remote-limitations-title">Browser access features</h2>
            <p class="dialog-description">Controllers can edit the workspace and run commands. Viewers can follow the canvas and terminal output.</p>
            <ul class="info-copy"><li>Enter project folder paths on the desktop computer. The native folder picker is available in the desktop app.</li>
            <li>Workspace and image pickers use files on this device. Workspace saves and exports download here.</li>
            <li>Use the desktop app to install app updates, manage browser access, or quit Terminal Canvas.</li>
            <li>Clipboard access follows browser permissions. Terminal rows and columns follow the desktop grid.</li></ul>
            <form method="dialog" class="dialog-footer"><button class="button primary">Done</button></form>`;
        document.body.append(limits);
        button.hidden = false;
        button.textContent = 'Browser access features';
        button.onclick = () => limits.showModal();
        return;
    }
    if (!root.__TAURI__?.core) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'remote-dialog';
    dialog.innerHTML = `<h2>Browser access</h2>
        <p class="dialog-description">Connect a browser to your workspace. Starting access shares the current screens of running terminals and new output.</p>
        <label class="field-label" for="remote-scope">Listen on</label>
        <select id="remote-scope"><option value="local">This computer</option><option value="network">Private network (HTTPS)</option></select>
        <div id="remote-network" hidden>
            <label class="field-label" for="remote-ip">This computer’s private IPv4 address</label>
            <input id="remote-ip" placeholder="192.168.1.20" inputmode="decimal" spellcheck="false" autocomplete="off">
            <p class="field-hint">Allow inbound connections to this port on your private network. Save this certificate and install it as a trusted root on each device before opening the HTTPS address. Restarting the desktop app creates a new certificate.</p>
            <button class="button" id="remote-save-certificate" type="button">Save browser certificate</button>
        </div>
        <label class="field-label" for="remote-port">Port (0 chooses an available port)</label>
        <input id="remote-port" type="number" min="0" max="65535" value="0">
        <p id="remote-state" class="info-copy" role="status">Off</p>
        <div id="remote-credentials" hidden>
            <label class="field-label" for="remote-control-token">Controller token · create and manage terminals, run commands</label>
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
        find('#remote-scope').disabled = state.running || busy;
        find('#remote-ip').disabled = state.running || busy;
        find('#remote-network').hidden = (state.running ? !state.https : find('#remote-scope').value !== 'network');
        find('#remote-save-certificate').disabled = !state.running || !state.https || busy;
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
    find('#remote-scope').onchange = () => render({});
    find('#remote-start-stop').onclick = () => call(state.running ? 'remote-stop' : 'remote-start', {
        port: Number(find('#remote-port').value),
        address: find('#remote-scope').value === 'network' ? find('#remote-ip').value.trim() : null
    });
    find('#remote-save-certificate').onclick = () => call('remote-certificate');
    find('#remote-rotate').onclick = () => call('remote-rotate');
    find('#remote-revoke').onclick = () => call('remote-revoke');
    bridge.onEvent(event => { if (event.type === 'remote-status') render(event); });
})(window);
