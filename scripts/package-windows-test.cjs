/* Reviewable test tooling, never a release build or normal user-data launcher. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = 'x86_64-pc-windows-msvc';

function imports(bytes) {
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'The Windows binary must be x64');
    const count = bytes.readUInt16LE(pe + 6), optional = pe + 24;
    assert.equal(bytes.readUInt16LE(optional), 0x20b);
    const sectionStart = optional + bytes.readUInt16LE(pe + 20);
    const offset = rva => {
        for (let index = 0; index < count; index++) {
            const section = sectionStart + index * 40;
            const start = bytes.readUInt32LE(section + 12), length = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
            if (rva >= start && rva < start + length) return bytes.readUInt32LE(section + 20) + rva - start;
        }
        throw new Error('PE directory is outside its sections');
    };
    const result = [], rva = bytes.readUInt32LE(optional + 120);
    if (!rva) return result;
    for (let descriptor = offset(rva); bytes.readUInt32LE(descriptor + 12); descriptor += 20) {
        const name = offset(bytes.readUInt32LE(descriptor + 12));
        result.push(bytes.toString('ascii', name, bytes.indexOf(0, name)));
    }
    assert.ok(!result.some(name => /^(?:vcruntime|msvcp|ucrtbased)/i.test(name)), 'The Windows binary must not depend on the MSVC redistributable or debug runtime');
    return result;
}

function main() {
    assert.equal(process.platform, 'win32');
    const argument = process.argv.indexOf('--pwsh-home');
    assert.ok(argument >= 0, 'Pass the official installed PowerShell 7 directory');
    const pwsh = path.resolve(process.argv[argument + 1]);
    assert.ok(fs.existsSync(path.join(pwsh, 'pwsh.exe')));
    const output = path.join(root, '.cache/windows11-e2e-kit'); fs.mkdirSync(output);
    execFileSync('cargo', ['build', '--locked', '--target', target, '-p', 'tc-hook', '-p', 'terminal-canvas',
        '--features', 'terminal-canvas/e2e', '--config', `target.${target}.rustflags=["-C","target-feature=+crt-static"]`],
        { cwd: root, stdio: 'inherit' });
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root, encoding: 'utf8' }));
    const manifest = { testOnly: true, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        node: process.version, binaries: {} };
    for (const name of ['terminal-canvas.exe', 'tc-hook.exe']) {
        const source = path.join(metadata.target_directory, target, 'debug', name), bytes = fs.readFileSync(source);
        const destination = path.join(output, 'target/debug', name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
        manifest.binaries[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), imports: imports(bytes) };
    }
    for (const name of ['tests/e2e', 'tests/baseline/support.cjs', 'tests/fixtures/powershell-test-isolation.ps1',
        'tests/visual/probe.js', 'tests/visual/arrow-paint.cjs', 'tests/golden/renderer.json']) {
        fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true });
        fs.cpSync(path.join(root, name), path.join(output, name), { recursive: true });
    }
    fs.mkdirSync(path.join(output, 'node_modules'), { recursive: true });
    fs.cpSync(path.dirname(require.resolve('playwright-core/package.json')), path.join(output, 'node_modules/playwright-core'), { recursive: true });
    const nodeDirectory = path.join(output, 'tools/node'); fs.mkdirSync(nodeDirectory, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(nodeDirectory, 'node.exe'));
    manifest.nodeImports = imports(fs.readFileSync(process.execPath));
    const license = path.join(path.dirname(process.execPath), 'LICENSE');
    assert.ok(fs.existsSync(license), 'Retain the official Node license'); fs.copyFileSync(license, path.join(nodeDirectory, 'LICENSE'));
    fs.cpSync(pwsh, path.join(output, 'tools/pwsh'), { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/manual/run-windows11-e2e.ps1'), path.join(output, 'Run-Checks.ps1'));
    fs.writeFileSync(path.join(output, 'TEST-ONLY.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'README.txt'), 'TEST ONLY: run the normal installer/portable checks first.\nExtract to a short writable folder, then run Run-Checks.ps1 in Windows PowerShell.\nAll app profiles and generated CLI stand-ins stay inside this kit\'s .cache. No provider service is called.\nThis is an instrumented debug test runtime, not the shipping app.\n');
    console.log(output);
}
if (require.main === module) main();
module.exports = { imports };
