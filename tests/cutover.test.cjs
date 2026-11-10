const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('cutover has only pinned development packages and no legacy runtime entry or install hook', () => {
    const manifest = require('../package.json');
    assert.equal(manifest.main, undefined);
    assert.equal(manifest.dependencies, undefined);
    for (const script of ['postinstall', 'dev', 'rebuild']) assert.equal(manifest.scripts[script], undefined);
    assert.match(manifest.scripts.start, /^cargo /);
    assert.deepEqual(Object.keys(manifest.devDependencies).sort(), ['@xterm/addon-fit', '@xterm/xterm', 'playwright-core']);
    for (const version of Object.values(manifest.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
    const lock = require('../package-lock.json');
    assert.equal(Object.keys(lock.packages).length, 4);
    assert.ok(Object.values(lock.packages).every(entry => !entry.hasInstallScript));
});

test('the runtime frontend excludes Node host/oracle code and obtains its CSP from Tauri', () => {
    const config = require('../src-tauri/tauri.conf.json');
    const frontend = path.resolve(root, 'src-tauri', config.build.frontendDist);
    assert.equal(frontend, path.join(root, 'src'));
    for (const name of fs.readdirSync(frontend, { recursive: true })) {
        assert.ok(!name.endsWith('.cjs'), `Runtime CommonJS host file: ${name}`);
        if (name.endsWith('.js')) {
            const source = fs.readFileSync(path.join(frontend, name), 'utf8');
            assert.doesNotMatch(source, /require\(\s*['"](?:electron|node-pty)['"]/);
            assert.ok(!source.includes('tests/reference/node-host'), `Oracle leaked into runtime: ${name}`);
        }
    }
    const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /http-equiv=["']Content-Security-Policy/i);
    assert.ok(!html.includes('node_modules'));
    assert.equal(config.app.security.csp['script-src'], "'self'");
    assert.ok(!JSON.stringify(config.app.security.csp).includes('unsafe-eval'));
    const capability = require('../src-tauri/capabilities/main.json');
    assert.deepEqual(capability.windows, ['main']);
    assert.equal(capability.local, true);
    assert.equal(capability.remote, undefined);
    assert.ok(capability.permissions.every(permission => permission.startsWith('allow-')));
});
