const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareNative } = require('../scripts/rebuild.cjs');

function harness(options = {}) {
    const events = [];
    return {
        events,
        options: {
            platform: 'win32', fromSource: false,
            verify() { events.push('verify'); },
            async rebuild() { events.push('rebuild'); },
            log() {},
            ...options
        }
    };
}

test('Windows setup accepts a working native binary without requiring a compiler', async () => {
    const { options, events } = harness();
    await prepareNative(options);
    assert.deepEqual(events, ['verify']);
});

test('an incompatible Windows binary is rebuilt and checked again', async () => {
    let checks = 0;
    const { options, events } = harness({ verify() {
        events.push('verify');
        if (++checks === 1) throw new Error('Native binary is incompatible with Electron.');
    } });
    await prepareNative(options);
    assert.deepEqual(events, ['verify', 'rebuild', 'verify']);
});

test('explicit source builds and other platforms compile before verifying', async () => {
    for (const overrides of [{ fromSource: true }, { platform: 'linux' }, { platform: 'darwin' }]) {
        const { options, events } = harness(overrides);
        await prepareNative(options);
        assert.deepEqual(events, ['rebuild', 'verify']);
    }
});

test('compiler failures and unusable rebuilt binaries fail setup', async () => {
    const compilation = harness({ fromSource: true, async rebuild() { throw new Error('MSB8040'); } });
    await assert.rejects(prepareNative(compilation.options), /MSB8040/);
    const verification = harness({ fromSource: true, verify() { throw new Error('PTY did not run'); } });
    await assert.rejects(prepareNative(verification.options), /PTY did not run/);
});
