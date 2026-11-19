/* Arrow automation controls. Configuration crosses host validation before becoming active. */
'use strict';
const pointerStates = new Map();
let editingPointer = null;
function anyPointerItem(id) { return canvasStates.flatMap(canvas => canvas.board.items).find(item => item.id === id); }
function setHooksPaused(paused) {
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
    $('#pointer-configure').hidden = !!bridge?.remote || !pointerCandidate(item);
    $('#pointer-toggle').hidden = !!bridge?.remote || !item?.hook;
    $('#pointer-toggle').textContent = item?.hook?.armed ? 'Disarm pointer' : 'Arm pointer';
    $('#pointer-status').hidden = !item?.hook;
    if (item?.hook) $('#pointer-status').textContent = pointerLabel(item);
    $('#pointers-pause').hidden = !!bridge?.remote || !canvasStates.some(canvas => canvas.board.items.some(item => item.hook));
    $('#pointers-pause').textContent = workspace.hooksPaused ? 'Resume hooks' : 'Pause hooks';
    $('#pointers-pause').setAttribute('aria-pressed', String(!!workspace.hooksPaused));
}
function pointerLabel(item) {
    if (workspace.hooksPaused || !item.hook.armed) return 'Idle · disarmed';
    const state = pointerStates.get(item.id);
    return state ? `${state.state} · ${state.message}` : 'Armed · waiting for source event';
}
function renderPointerLine(item, view, start, end) {
    view.element.classList.toggle('hook-pointer', !!item.hook);
    const state = item.hook ? (workspace.hooksPaused || !item.hook.armed ? 'idle' : pointerStates.get(item.id)?.state || 'armed') : '';
    view.element.dataset.pointerState = state;
    view.label.textContent = item.hook ? `${item.hook.event === 'trigger' ? item.hook.name || 'trigger' : item.hook.event} · ${state}` : '';
    view.label.setAttribute('x', String((start.x + end.x) / 2));
    view.label.setAttribute('y', String((start.y + end.y) / 2 - 10));
    view.title.textContent = item.hook ? pointerLabel(item) : '';
    view.pulse.setAttribute('d', `M${start.x} ${start.y}L${end.x} ${end.y}`);
}
function pointerEvent(event) {
    const item = anyPointerItem(event.id);
    if (!item?.hook) return;
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
    if (event.state === 'failed') toast(`Hook pointer: ${event.message}`);
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
function pointerFields() {
    const action = $('#pointer-action').value, event = $('#pointer-event').value;
    $('#pointer-filter-field').hidden = event !== 'exit';
    $('#pointer-name-field').hidden = event !== 'trigger';
    $('#pointer-context-field').hidden = action !== 'prompt';
    $('#pointer-text-label').textContent = action === 'prompt' ? 'Prompt' : 'Command';
    $('#pointer-text').maxLength = 2000;
    $('#pointer-action-hint').textContent = action === 'new-terminal'
        ? 'Open a fresh terminal using the arrow target’s profile, name, project folder and Claude account. Run the command below; the template terminal may be stopped.'
        : action === 'prompt' ? 'The target must run Claude or Codex with trusted lifecycle hooks. Busy targets queue until Stop. Idle targets receive bracketed paste and Enter.'
            : 'The target must be an idle integrated PowerShell or Bash shell. The command is submitted with Enter. Unknown readiness fails.';
}
function openPointerDialog() {
    const item = findItem(selected);
    if (!pointerCandidate(item) || boardBusy()) return;
    editingPointer = item;
    const hook = item.hook || { event: 'stop', action: 'prompt', text: '', armed: false, filter: 'any', name: '', context: false };
    $('#pointer-description').textContent = `${findCard(item.start.id).title} → ${findCard(item.end.id).title}`;
    for (const key of ['event', 'action', 'text', 'filter', 'name']) $(`#pointer-${key}`).value = hook[key] || (key === 'filter' ? 'any' : '');
    $('#pointer-armed').checked = hook.armed;
    $('#pointer-context').checked = hook.context;
    $('#pointer-remove').hidden = !item.hook;
    $('#pointer-error').hidden = true;
    pointerFields(); $('#pointer-dialog').showModal();
}
function installPointerControls() {
    $('#pointer-configure').onclick = openPointerDialog;
    $('#pointer-toggle').onclick = () => run(async () => { const item = findItem(selected); if (item?.hook) await savePointerChange(item, { ...item.hook, armed: !item.hook.armed }); });
    $('#pointers-pause').onclick = () => run(() => savePointerChange(null, null, !workspace.hooksPaused));
    $('#pointer-event').onchange = $('#pointer-action').onchange = pointerFields;
    $('#pointer-form').addEventListener('submit', event => {
        event.preventDefault();
        run(async () => {
            if (formBusy) return;
            formBusy = true; $('#pointer-submit').disabled = true;
            try {
                const action = $('#pointer-action').value, source = $('#pointer-event').value;
                const hook = { event: source, action, text: $('#pointer-text').value, armed: !!$('#pointer-armed').checked,
                    filter: source === 'exit' ? $('#pointer-filter').value : 'any', name: source === 'trigger' ? $('#pointer-name').value : '', context: action === 'prompt' && !!$('#pointer-context').checked };
                await savePointerChange(editingPointer, hook); $('#pointer-dialog').close();
            } catch (error) { $('#pointer-error').textContent = error.message; $('#pointer-error').hidden = false; }
            finally { formBusy = false; $('#pointer-submit').disabled = false; }
        });
    });
    $('#pointer-remove').onclick = () => run(async () => { await savePointerChange(editingPointer, null); $('#pointer-dialog').close(); });
}
