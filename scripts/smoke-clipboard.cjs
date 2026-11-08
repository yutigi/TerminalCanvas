const assert = require('node:assert/strict');
const { clipboard, ClipboardItem } = require('electron');

// Native keyboard events exercise Chromium defaults, xterm, preload IPC, and the OS clipboard together.
exports.run = async ({ win, terminals, createCard, hasOutputLine, capture }) => {
    const savedClipboard = await clipboard.read();
    // Materialize OS-backed items before the tests replace the system clipboard.
    const snapshot = await Promise.all(savedClipboard.map(async item => new ClipboardItem(Object.fromEntries(
        await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    const originalWrite = terminals.write;
    const originalEmit = terminals.emit;
    const inputs = [];
    let output = '', fixtureMode = false;
    const nativeModifiers = process.platform === 'darwin' ? ['meta'] : ['control'];
    const card = createCard({ title: 'Clipboard shortcuts' });
    const evaluate = script => win.webContents.executeJavaScript(script);
    const waitFor = async (check, description, timeout = 5000) => {
        const deadline = Date.now() + timeout;
        while (!await check()) {
            if (Date.now() > deadline) throw new Error(`Clipboard smoke timed out: ${description}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    const key = async (keyCode, modifiers = ['control']) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await evaluate('true');
        // Clipboard reads cross IPC twice; wait for them and any accidental duplicate native paste.
        await new Promise(resolve => setTimeout(resolve, 100));
    };
    const write = text => evaluate(`new Promise(resolve => sessions.get(${JSON.stringify(card.id)}).terminal.write(${JSON.stringify(text)}, resolve))`);
    const terminal = `sessions.get(${JSON.stringify(card.id)}).terminal`;
    try {
        win.focus(); win.webContents.focus();
        terminals.emit = event => {
            if (event.id === card.id && event.type === 'data') {
                output += event.data;
                // Focus/resize can make ConPTY repaint the shell over synthetic xterm fixtures.
                if (fixtureMode) { terminals.acknowledge(card.id, event.data.length); return; }
            }
            originalEmit(event);
        };
        await evaluate(`loadWorkspace(${JSON.stringify({ version: 1, name: 'Clipboard smoke workspace', camera: { x: 30, y: 30, z: 1 }, cards: [card] })}); start(workspace.cards[0])`);
        const ready = `clipboard-ready-${Date.now()}`;
        originalWrite.call(terminals, card.id, `echo ${ready}\r`);
        await waitFor(() => hasOutputLine(output, ready), 'real shell ready');
        // Capture PTY-bound bytes without executing the multiline fixtures as shell commands.
        terminals.write = (id, data) => inputs.push({ id, data });
        for (const focus of [false, true]) {
            fixtureMode = true;
            await evaluate(`setFocus(${focus ? JSON.stringify(card.id) : 'null'}); ${terminal}.reset(); ${terminal}.focus()`);
            await write('\x1b[2J\x1b[HSelected terminal text\r\nSecond line');
            // Force shell output after installing the fixture: it must be captured without repainting it.
            const noise = `clipboard-fixture-noise-${Date.now()}`;
            originalWrite.call(terminals, card.id, `echo ${noise}\r`);
            await waitFor(() => hasOutputLine(output, noise), 'shell output isolated from copy fixture');
            const clipboardModifiers = [['control'], ['control', 'shift'], ...(process.platform === 'darwin' ? [['meta']] : [])];
            for (const modifiers of clipboardModifiers) {
                inputs.length = 0;
                await clipboard.writeText('old clipboard');
                await evaluate(`${terminal}.select(0, 0, 22); ${terminal}.focus()`);
                await key('C', modifiers);
                assert.equal(await clipboard.readText(), 'Selected terminal text');
                assert.deepEqual(inputs, [], 'copy must not send an interrupt to the PTY');
            }
            await evaluate(`${terminal}.clearSelection()`);
            await key('C', ['control', 'shift']);
            assert.equal(await clipboard.readText(), 'Selected terminal text', 'empty explicit copy leaves clipboard intact');
            assert.deepEqual(inputs, []);
            await key('C');
            assert.deepEqual(inputs.map(input => input.data), ['\x03'], 'selection-free Ctrl+C sends exactly one interrupt');
            for (const bracketed of [false, true]) {
                await write(`\x1b[?2004${bracketed ? 'h' : 'l'}`);
                for (const modifiers of clipboardModifiers) {
                    for (const selection of [false, true]) {
                        inputs.length = 0;
                        await clipboard.writeText('first\r\nsecond\nthird');
                        await evaluate(selection ? `${terminal}.select(0, 0, 8)` : `${terminal}.clearSelection()`);
                        await key('V', modifiers);
                        const expected = bracketed ? '\x1b[200~first\rsecond\rthird\x1b[201~' : 'first\rsecond\rthird';
                        assert.deepEqual(inputs, [{ id: card.id, data: expected }], 'multiline paste must reach xterm exactly once');
                    }
                }
            }
            // Native input editing must remain available even while a terminal stays selected.
            await evaluate(`document.querySelector('#search').value = 'outside terminal'; document.querySelector('#search').focus(); document.querySelector('#search').select()`);
            await key('C', nativeModifiers);
            assert.equal(await clipboard.readText(), 'outside terminal');
            await clipboard.writeText('native paste');
            inputs.length = 0;
            await key('V', nativeModifiers);
            assert.equal(await evaluate("document.querySelector('#search').value"), 'native paste');
            assert.deepEqual(inputs, []);
            // Reconnect the real PTY for the process interruption check in this view.
            fixtureMode = false;
            terminals.write = originalWrite;
            await evaluate(`${terminal}.clearSelection(); ${terminal}.focus()`);
            const started = `clipboard-blocking-${Date.now()}`;
            originalWrite.call(terminals, card.id, process.platform === 'win32'
                ? `echo ${started}; Start-Sleep -Seconds 30\r`
                : `echo ${started}; sleep 30\r`);
            await waitFor(() => hasOutputLine(output, started), 'blocking command started');
            await key('C');
            const resumed = `clipboard-resumed-${Date.now()}`;
            originalWrite.call(terminals, card.id, `echo ${resumed}\r`);
            await waitFor(() => hasOutputLine(output, resumed), 'shell responds after Ctrl+C');
            terminals.write = (id, data) => inputs.push({ id, data });
        }
        await evaluate("document.querySelector('#help').click()");
        await capture();
        await evaluate("document.querySelector('#info-dialog').close()");
        console.log('Clipboard smoke passed: canvas/Focus copy, empty selections, single multiline/bracketed paste, native text fields, real command interrupt.');
    } finally {
        terminals.write = originalWrite;
        terminals.emit = originalEmit;
        terminals.stopAll();
        if (snapshot.length) await clipboard.write(snapshot);
        else clipboard.clear();
    }
};
