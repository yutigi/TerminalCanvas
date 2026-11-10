/* Prepare files only. Launch an e2e build separately; this script never starts the app. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

assert.notEqual(process.platform, 'win32', 'Use the Windows native E2E restoration test on Windows.');
const root = path.resolve(__dirname, '../..');
const folder = path.join(root, '.cache/native-cli-check');
const tools = path.join(folder, 'tools');
const project = path.join(folder, 'project ไทย 工作 🚀');
const profile = path.join(root, '.cache/tauri-restoration-profile');
assert.ok(!fs.existsSync(profile), 'Close all test apps and archive the existing restoration test profile first.');
assert.ok(!fs.existsSync(folder), 'Archive the existing native CLI test directory before a new run.');
fs.mkdirSync(tools, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(profile);
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const log = path.join(folder, 'invocations.jsonl');
const shellLog = path.join(folder, 'shells.tsv');
const fake = path.join(__dirname, 'fake-session-cli.cjs');
for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(tools, provider), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(fake)} ${quote(log)} ${quote(provider)} "$@"\n`, { mode: 0o700 });
}
const controlledPath = tools + ':/usr/bin:/bin:/usr/sbin:/sbin';
const shell = path.join(tools, 'bash');
fs.writeFileSync(shell, `#!/bin/bash
export PATH=${quote(controlledPath)}
for provider in claude codex; do
    [ "$(type -P "$provider")" = ${quote(tools)}/"$provider" ] || exit 96
done
printf '%s\\t%s\\n' "$$" "$PWD" >> ${quote(shellLog)}
export PS1='tc-native-check$ '
exec /bin/bash --noprofile --norc -i
`, { mode: 0o700 });
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/golden/renderer.json')));
const board = structuredClone(fixture.workspace);
board.name = 'Native controlled session check';
board.camera = { x: 32, y: 32, z: 0.8 };
board.cards = ['claude', 'codex'].map((provider, index) => ({
    ...fixture.cards[provider], id: 'native-' + provider, title: 'Native ' + provider,
    cwd: project, x: index * 700, y: 0,
}));
fs.writeFileSync(path.join(profile, 'workspace.terminalcanvas'), JSON.stringify(board, null, 2));
const settings = { profile, folder, tools, shell, project, controlledPath, log, shellLog };
fs.writeFileSync(path.join(folder, 'setup.json'), JSON.stringify(settings, null, 2) + '\n');
console.log(JSON.stringify(settings, null, 2));
