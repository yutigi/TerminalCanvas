/* Prove desktop startup once before retrying the full suite ten times. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { launch } = require('./harness.cjs');

async function main() {
    const host = await launch({ clean: true });
    try {
        await host.page.waitForFunction(() => typeof ready !== 'undefined' && ready);
        const state = await host.state();
        assert.equal(path.resolve(state.profile), path.resolve(host.profile), 'The native host must use the isolated test profile');
        assert.deepEqual(host.errors, [], 'The renderer must initialize without errors');
    } finally { await host.dispose(); }
    console.log('WebView2 preflight passed: CDP, renderer initialization, isolated profile, and normal shutdown.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
