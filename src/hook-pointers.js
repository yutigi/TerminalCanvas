/* Arrow automation controls. Configuration crosses host validation before becoming active. */
'use strict';
const pointerStates = new Map();
let pointerPlatform;
let editingPointer = null;
let pointerCheck = null;
function anyPointerItem(id) { return canvasStates.flatMap(canvas => canvas.board.items).find(item => item.id === id); }
function setHooksPaused(paused) {
    if (canvasStates.some(canvas => !!canvas.board.hooksPaused !== paused)) pointerStates.clear();
    for (const canvas of canvasStates) {
        if (paused) canvas.board.hooksPaused = true; else delete canvas.board.hooksPaused;
    }
}
function pointerCandidate(item) {
    return item?.type === 'line' && item.arrow && findCard(item.start.id) && findCard(item.end.id);
}
function renderPointerControls() {
    if (!workspace) return;
    const item = selection.size === 1 ? findItem(selected) : null;
    const canConfigure = !bridge?.remote && !!pointerCandidate(item);
    $('#pointer-controls').hidden = !canConfigure && !item?.hook;
    $('#pointer-divider').hidden = !canConfigure;
    $('#pointer-configure').hidden = !canConfigure;
    $('#pointer-configure-label').textContent = item?.hook ? 'Edit automation' : 'Add automation';
    $('#pointer-toggle').hidden = !!bridge?.remote || !item?.hook;
    $('#pointer-toggle').textContent = item?.hook?.armed ? 'Disable' : 'Enable';
    $('#pointer-toggle').setAttribute('aria-label', item?.hook?.armed ? 'Disable automation' : 'Enable automation');
    $('#pointer-status').hidden = !item?.hook;
    if (item?.hook) $('#pointer-status').title = $('#pointer-status').textContent = pointerLabel(item);
    $('#pointers-pause').hidden = !!bridge?.remote || !canvasStates.some(canvas => canvas.board.items.some(item => item.hook));
    $('#pointers-pause').textContent = workspace.hooksPaused ? 'Resume automations' : 'Pause automations';
    $('#pointers-pause').setAttribute('aria-pressed', String(!!workspace.hooksPaused));
    $('#pointer-paused').hidden = !workspace.hooksPaused;
}
function pointerState(item) {
    if (!item.hook.armed) return 'disabled';
    if (workspace.hooksPaused) return 'paused';
    return pointerStates.get(item.id)?.state || 'armed';
}
const pointerStateLabels = { disabled: 'Disabled', paused: 'Paused', armed: 'Waiting', queued: 'Queued', firing: 'Delivered', failed: 'Failed' };
function pointerLabel(item) {
    const state = pointerState(item), message = pointerStates.get(item.id)?.message;
    const target = findCard(item.end.id)?.title || 'the target terminal';
    switch (state) {
        case 'paused': return 'Paused across all canvases';
        case 'armed': return `Waiting for ${findCard(item.start.id)?.title || 'the source terminal'}`;
        case 'queued': return item.hook.action === 'prompt' ? `Queued until ${target} finishes (up to 60 seconds)` : message;
        case 'firing': return message;
        case 'failed': return `Failed · ${message}`;
        default: return pointerStateLabels[state];
    }
}
function renderPointerLine(item, view, start, end) {
    view.element.classList.toggle('hook-pointer', !!item.hook);
    const state = item.hook ? pointerState(item) : '';
    view.element.dataset.pointerState = state;
    const trigger = item.hook?.event === 'trigger' && item.hook.name;
    view.label.textContent = trigger ? `${trigger} · ${pointerStateLabels[state]}` : pointerStateLabels[state] || '';
    view.label.setAttribute('x', String((start.x + end.x) / 2));
    view.label.setAttribute('y', String((start.y + end.y) / 2 - 10));
    view.title.textContent = item.hook ? pointerLabel(item) : '';
    view.pulse.setAttribute('d', `M${start.x} ${start.y}L${end.x} ${end.y}`);
}
function pointerEvent(event) {
    const item = anyPointerItem(event.id);
    if (!item?.hook?.armed || workspace.hooksPaused) return;
    const latest = { state: event.state, message: event.message };
    pointerStates.set(item.id, latest);
    const view = itemViews.get(item.id);
    if (view && findItem(item.id) === item) {
        view.element.classList.remove('pointer-flash');
        // Restart the pulse even when two deliveries occur before the previous pulse finishes.
        void view.element.getBoundingClientRect();
        if (event.state === 'firing') view.element.classList.add('pointer-flash');
        renderLine(item);
    }
    renderPointerControls();
    if (event.state === 'firing') setTimeout(() => {
        if (pointerStates.get(item.id) !== latest || anyPointerItem(item.id) !== item) return;
        latest.state = 'armed';
        if (findItem(item.id) === item) renderLine(item);
        renderPointerControls();
    }, 1200);
    if (event.state === 'failed') toast(`Automation failed · ${event.message}`);
}
async function savePointerChange(item, hook, paused) {
    if (bridge?.remote) throw new Error('Configure hook pointers in the desktop app.');
    clearTimeout(autosaveTimer);
    const candidate = cloneData(workspaceSnapshot());
    if (item) {
        const next = candidate.items.find(next => next.id === item.id);
        if (!next) throw new Error('This arrow was removed.');
        if (hook) next.hook = hook; else delete next.hook;
    }
    if (paused !== undefined) { if (paused) candidate.hooksPaused = true; else delete candidate.hooksPaused; }
    await invoke('pointer-configure', { workspace: candidate, ...(paused !== undefined ? { paused } : { id: item.id, hook }) });
    if (item && findItem(item.id) !== item) throw new Error('This arrow was removed.');
    if (item) {
        if (hook) item.hook = hook; else delete item.hook;
        pointerStates.delete(item.id);
    }
    if (paused !== undefined) setHooksPaused(paused);
    renderLines(); renderPointerControls(); changed();
}
function pointerFieldError(field, message) {
    const input = $(`#pointer-${field}`), error = $(`#pointer-${field}-error`);
    error.textContent = message;
    error.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
}
function resetPointerCheck() {
    pointerCheck = null;
    $('#pointer-setup-status').hidden = true;
    $('#pointer-check-setup').disabled = false;
}
const validPointerName = name => /^[A-Za-z0-9_-]{0,64}$/.test(name);
function validatePointerName() {
    if (validPointerName($('#pointer-name').value)) return true;
    pointerFieldError('name', 'Use up to 64 letters, numbers, hyphens or underscores.');
    return false;
}
function pointerTriggerCommand() {
    const name = $('#pointer-name').value;
    const executable = $('#pointer-shell').value === 'powershell' ? '& $env:TC_HOOK' : '"$TC_HOOK"';
    const command = validPointerName(name) ? `${executable} trigger${name ? ` ${name}` : ''}` : '';
    $('#pointer-command').textContent = command;
    $('#pointer-command').hidden = !command;
    $('#pointer-copy').disabled = !command;
    $('#pointer-copy-status').hidden = true;
    return command;
}
function pointerFields() {
    const action = $('#pointer-action').value, event = $('#pointer-event').value;
    const provider = action === 'prompt' ? $('#pointer-provider').value : '';
    $('#pointer-filter-field').hidden = event !== 'exit';
    $('#pointer-name-field').hidden = event !== 'trigger';
    $('#pointer-provider-field').hidden = action !== 'prompt';
    $('#pointer-model-field').hidden = !provider;
    $('#pointer-model').setAttribute('list', provider ? `pointer-${provider}-models` : '');
    $('#pointer-context-field').hidden = action !== 'prompt';
    $('#pointer-text-label').textContent = action === 'prompt' ? 'Prompt' : 'Command';
    const source = findCard(editingPointer.start.id)?.title || 'the source terminal';
    const target = findCard(editingPointer.end.id)?.title || 'the target terminal';
    $('#pointer-event-hint').textContent = {
        stop: `Fires when Claude Code or Codex in ${source} finishes a turn.`,
        exit: `Fires when the AI CLI or terminal process in ${source} exits.`,
        trigger: `Run the command below in ${source} to fire this automation.`
    }[event];
    $('#pointer-action-hint').textContent = {
        prompt: provider
            ? `Starts ${provider === 'claude' ? 'Claude Code' : 'Codex'} with the prompt when ${target} is at an idle PowerShell or Bash prompt.`
            : `Sends the prompt to the running Claude Code or Codex session in ${target}. If the agent is busy, it queues for up to 60 seconds.`,
        shell: `Runs one line in ${target} when its integrated PowerShell or Bash shell is idle.`,
        'new-terminal': `Uses ${target} as a template and runs the command in a fresh terminal. The template can be stopped.`
    }[action];
    pointerFieldError('text', '');
    pointerFieldError('name', '');
    pointerFieldError('model', '');
    pointerTriggerCommand();
    resetPointerCheck();
}
async function checkPointerSetup() {
    const item = editingPointer;
    if (!item || pointerCheck) return;
    const payload = { source: item.start.id, target: item.end.id, event: $('#pointer-event').value, action: $('#pointer-action').value };
    const provider = $('#pointer-provider').value;
    if (payload.action === 'prompt' && provider) payload.provider = provider;
    pointerCheck = payload;
    const status = $('#pointer-setup-status');
    status.textContent = 'Checking terminal setup…';
    status.hidden = false;
    $('#pointer-check-setup').disabled = true;
    try {
        const { source, target } = await invoke('pointer-check', payload);
        if (pointerCheck !== payload) return;
        status.replaceChildren();
        for (const [id, message] of [[item.start.id, source], [item.end.id, target]]) {
            const row = document.createElement('p');
            row.textContent = `${findCard(id)?.title || 'Terminal'} · ${message}`;
            status.append(row);
        }
    } catch (error) {
        if (pointerCheck === payload) status.textContent = error.message;
    } finally {
        if (pointerCheck === payload) {
            pointerCheck = null;
            $('#pointer-check-setup').disabled = false;
        }
    }
}
function openPointerDialog() {
    const item = findItem(selected);
    if (!pointerCandidate(item) || boardBusy() || formBusy || document.querySelector('dialog[open]')) return;
    editingPointer = item;
    const hook = item.hook || { event: 'stop', action: 'prompt', text: '', armed: false, filter: 'any', name: '', context: false };
    $('#pointer-heading').textContent = item.hook ? 'Edit automation' : 'Add automation';
    $('#pointer-description').textContent = `${findCard(item.start.id).title} → ${findCard(item.end.id).title}`;
    for (const key of ['event', 'action', 'text', 'filter', 'name']) $(`#pointer-${key}`).value = hook[key] || (key === 'filter' ? 'any' : '');
    $('#pointer-provider').value = hook.provider || '';
    $('#pointer-model').value = hook.model || '';
    $('#pointer-context').checked = !!hook.context;
    $('#pointer-shell').value = pointerPlatform === 'win32' ? 'powershell' : 'bash';
    $('#pointer-submit').textContent = hook.armed ? 'Save changes' : 'Save & enable';
    $('#pointer-remove').hidden = !item.hook;
    $('#pointer-error').hidden = true;
    pointerFields(); $('#pointer-dialog').showModal();
}
async function commitPointerEdit(item, hook, button) {
    if (!item || formBusy) return;
    formBusy = true;
    const buttons = ['close', 'cancel', 'remove', 'save-disabled', 'submit'].map(id => $(`#pointer-${id}`));
    for (const control of buttons) control.disabled = true;
    const label = button.textContent;
    button.textContent = hook ? 'Saving…' : 'Removing…';
    $('#pointer-error').hidden = true;
    try {
        await savePointerChange(item, hook);
        $('#pointer-dialog').close();
    } catch (error) {
        $('#pointer-error').textContent = error.message;
        $('#pointer-error').hidden = false;
    } finally {
        formBusy = false;
        for (const control of buttons) control.disabled = false;
        button.textContent = label;
    }
}
function installPointerControls() {
    $('#pointer-configure').onclick = openPointerDialog;
    $('#pointer-toggle').onclick = () => run(async () => { const item = findItem(selected); if (item?.hook) await savePointerChange(item, { ...item.hook, armed: !item.hook.armed }); });
    $('#pointers-pause').onclick = () => run(() => savePointerChange(null, null, !workspace.hooksPaused));
    $('#pointer-event').onchange = $('#pointer-action').onchange = pointerFields;
    $('#pointer-provider').onchange = () => {
        $('#pointer-model').value = '';
        pointerFields();
    };
    $('#pointer-model').oninput = () => pointerFieldError('model', '');
    $('#pointer-text').oninput = () => pointerFieldError('text', '');
    $('#pointer-name').oninput = () => {
        pointerFieldError('name', '');
        pointerTriggerCommand();
    };
    $('#pointer-name').onblur = validatePointerName;
    $('#pointer-name').addEventListener('keydown', event => {
        // Enter in the trigger name should neither enable nor disable a rule.
        if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
    });
    $('#pointer-shell').onchange = pointerTriggerCommand;
    $('#pointer-copy').onclick = async () => {
        const command = pointerTriggerCommand(), item = editingPointer;
        if (!command) return;
        const status = $('#pointer-copy-status');
        let message = 'Command copied.';
        try { await invoke('clipboard-write', command); }
        catch (error) { message = error.message; }
        if (editingPointer !== item || $('#pointer-command').textContent !== command) return;
        status.textContent = message;
        status.hidden = false;
    };
    $('#pointer-check-setup').onclick = checkPointerSetup;
    $('#pointer-dialog').addEventListener('cancel', event => { if (formBusy) event.preventDefault(); });
    $('#pointer-dialog').addEventListener('close', () => { editingPointer = null; resetPointerCheck(); });
    $('#pointer-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!editingPointer || formBusy) return;
        const action = $('#pointer-action').value, source = $('#pointer-event').value;
        if (source === 'trigger' && !validatePointerName()) {
            $('#pointer-name').focus();
            return;
        }
        const text = $('#pointer-text').value;
        const isPrompt = action === 'prompt';
        const provider = isPrompt ? $('#pointer-provider').value : '';
        const model = provider ? $('#pointer-model').value.trim() : '';
        if (model && !/^[A-Za-z0-9][A-Za-z0-9_.:/\[\]+-]{0,127}$/.test(model)) {
            pointerFieldError('model', 'Enter a model ID or alias up to 128 characters.');
            $('#pointer-model').focus();
            return;
        }
        // Prompts may contain tabs and newlines. Commands must fit on one line.
        const content = isPrompt ? text.replace(/[\n\t]/g, '') : text;
        if (!text.trim() || text.length > 2000 || /\p{Cc}/u.test(content)) {
            pointerFieldError('text', isPrompt ? 'Enter a prompt up to 2,000 characters using plain text.' : 'Enter a single-line command up to 2,000 characters.');
            $('#pointer-text').focus();
            return;
        }
        const armed = event.submitter === $('#pointer-submit');
        const hook = { event: source, action, text, armed,
            filter: source === 'exit' ? $('#pointer-filter').value : 'any',
            name: source === 'trigger' ? $('#pointer-name').value : '',
            context: isPrompt && !!$('#pointer-context').checked };
        if (provider) hook.provider = provider;
        if (model) hook.model = model;
        void commitPointerEdit(editingPointer, hook, armed ? $('#pointer-submit') : $('#pointer-save-disabled'));
    });
    $('#pointer-remove').onclick = () => commitPointerEdit(editingPointer, null, $('#pointer-remove'));
}
