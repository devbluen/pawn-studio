// Package manager end to end, offline: a fake GitHub serves source and release zips built here.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PackageManager } = require('../out/packages/manager');

/** Minimal zip writer (stored entries). files = { 'dir/name': content } */
function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content);
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        parts.push(local, nameBuf, data);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(data.length, 20);
        c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(nameBuf.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, end]);
}

/** A fake GitHub with one repository: source files (with pawn.json) + release assets. */
function fakeGitHub(repo) {
    const sha = 'a'.repeat(40);
    const asset = (name) => ({ name, browser_download_url: `mem://${name}`, url: '', size: repo.assets[name].length });
    const release = { tag_name: 'v1.0.0', name: 'v1.0.0', draft: false, prerelease: false, published_at: '', assets: Object.keys(repo.assets).map(asset) };
    const downloads = [];
    return {
        downloads,
        api: async (p) => (/\/tags/.test(p) ? [{ name: 'v1.0.0', commit: { sha } }] : {}),
        repo: async () => ({ default_branch: 'main' }),
        commitSha: async () => sha,
        releaseByTag: async () => release,
        latestRelease: async () => release,
        downloadSource: async () => zip(Object.fromEntries(Object.entries(repo.source).map(([k, v]) => [`repo-main/${k}`, v]))),
        download: async (url) => {
            const name = url.replace('mem://', '');
            downloads.push(name);
            return repo.assets[name];
        },
    };
}

function project(kind, target) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-pkg-'));
    fs.mkdirSync(path.join(root, 'gamemodes'));
    if (kind === 'samp') {
        fs.writeFileSync(path.join(root, 'samp-server.exe'), '');
        fs.writeFileSync(path.join(root, 'server.cfg'), 'gamemode0 main 1\n');
    } else if (kind === 'openmp') {
        fs.writeFileSync(path.join(root, 'omp-server.exe'), '');
        fs.writeFileSync(path.join(root, 'config.json'), '{}');
    }
    fs.writeFileSync(path.join(root, 'pawn.json'), JSON.stringify({ name: 'test', ...(target ? { target } : {}) }));
    const exe = kind === 'samp' ? 'samp-server.exe' : 'omp-server.exe';
    const server = kind ? { dir: root, kind, executable: path.join(root, exe), configFile: path.join(root, kind === 'samp' ? 'server.cfg' : 'config.json') } : undefined;
    return { root, server };
}

async function install(repo, kind, target) {
    const { root, server } = project(kind, target);
    const gh = fakeGitHub(repo);
    const log = [];
    const pm = new PackageManager(gh, { root, server, skipTransitive: [], log: (m) => log.push(m) });
    const entry = await pm.add('someone/thing');
    const exists = (p) => fs.existsSync(path.join(root, p));
    const cfg = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
    return { root, entry, log: log.join('\n'), downloads: gh.downloads, exists, cfg };
}

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('one file per system with plugins/ and components/ inside (SA-MP gets the plugin, open.mp the component)', async () => {
    const both = zip({ 'plugins/thing.dll': 'P', 'components/thing.dll': 'C', 'include/thing.inc': '// inc' });
    const repo = { source: { 'pawn.json': JSON.stringify({ plugins: { windows: 'thing-*-windows-x86.zip' } }), 'src/main.cpp': '' }, assets: { 'thing-1.0.0-windows-x86.zip': both } };
    let r = await install(repo, 'samp', { os: 'windows' });
    assert.ok(r.exists('plugins/thing.dll') && !r.exists('components/thing.dll'), r.log);
    assert.match(r.cfg('server.cfg'), /^plugins thing$/m);
    assert.ok(r.entry.includePaths.some((p) => p.endsWith('.resources/include')), 'include from the release');
    assert.ok(!r.exists('.pawn-studio/dependencies/thing/src'), 'source not kept when the release brings everything');
    r = await install(repo, 'openmp', { os: 'windows' });
    assert.ok(r.exists('components/thing.dll') && !r.exists('plugins/thing.dll'), r.log);
});

t('separate files: "plugins" for SA-MP and "components" for open.mp', async () => {
    const repo = {
        source: { 'pawn.json': JSON.stringify({ supports: ['samp', 'openmp'], plugins: { windows: 'thing-*-win32.zip' }, components: { windows: 'thing-omp-*-win32.zip' } }) },
        // the component file comes first and the plugin pattern matches it too: it must still not be taken as the plugin
        assets: { 'thing-omp-1.0.0-win32.zip': zip({ 'thing.dll': 'C' }), 'thing-1.0.0-win32.zip': zip({ 'thing.dll': 'P' }) },
    };
    let r = await install(repo, 'samp', { os: 'windows' });
    assert.deepStrictEqual(r.downloads, ['thing-1.0.0-win32.zip']);
    assert.ok(r.exists('plugins/thing.dll'));
    r = await install(repo, 'openmp', { os: 'windows' });
    assert.deepStrictEqual(r.downloads, ['thing-omp-1.0.0-win32.zip'], 'only the component file');
    assert.ok(r.exists('components/thing.dll') && !r.exists('plugins/thing.dll'), r.log);
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'components/thing.dll'), 'utf8'), 'C');
});

t('systems, architectures and variants: the project "target" picks the file', async () => {
    const repo = {
        source: { 'pawn.json': JSON.stringify({ plugins: { windows: 'thing-win32.zip', 'windows-x64': 'thing-win64.zip', linux: 'thing-linux.zip', 'linux-x86-dynamic': 'thing-linux-dynssl.zip' } }) },
        assets: {
            'thing-win32.zip': zip({ 'thing.dll': 'w32' }),
            'thing-win64.zip': zip({ 'thing.dll': 'w64' }),
            'thing-linux.zip': zip({ 'thing.so': 'static' }),
            'thing-linux-dynssl.zip': zip({ 'thing.so': 'dynamic' }),
        },
    };
    const pick = async (target) => (await install(repo, 'samp', target)).downloads[0];
    assert.strictEqual(await pick({ os: 'windows' }), 'thing-win32.zip');
    assert.strictEqual(await pick({ os: 'windows', arch: 'x64' }), 'thing-win64.zip');
    assert.strictEqual(await pick({ os: 'linux' }), 'thing-linux.zip');
    assert.strictEqual(await pick({ os: 'linux', variant: 'dynamic' }), 'thing-linux-dynssl.zip');
    // a variant the author did not publish falls back to the default build of that system
    assert.strictEqual(await pick({ os: 'linux', variant: 'musl' }), 'thing-linux.zip');
    // the server here is Windows: the Linux file is for another machine, the log says what its server.cfg needs
    let r = await install(repo, 'samp', { os: 'linux' });
    assert.ok(r.exists('plugins/thing.so') && !/thing/.test(r.cfg('server.cfg')), r.log);
    assert.match(r.log, /plugins thing\.so/);
    // test on Windows, host on Linux: both files, server.cfg for the Windows server
    r = await install(repo, 'samp', { os: ['windows', 'linux'] });
    assert.ok(r.exists('plugins/thing.dll') && r.exists('plugins/thing.so'), r.log);
    assert.match(r.cfg('server.cfg'), /^plugins thing$/m);
    assert.deepStrictEqual(r.downloads.sort(), ['thing-linux.zip', 'thing-win32.zip']);
});

t('automatic detection by file name (no pawn.json): arch and variant', async () => {
    const repo = {
        source: { 'thing.inc': '' },
        assets: { 'thing-2.0-win32.zip': zip({ 'thing.dll': 'a' }), 'thing-2.0-win64.zip': zip({ 'thing.dll': 'b' }), 'thing-2.0-linux.tar.gz.zip': zip({}), 'thing-2.0-linux-x86.zip': zip({ 'thing.so': 's' }), 'thing-2.0-linux-x86-dynssl.zip': zip({ 'thing.so': 'd' }) },
    };
    const pick = async (target) => (await install(repo, 'samp', target)).downloads[0];
    assert.strictEqual(await pick({ os: 'windows' }), 'thing-2.0-win32.zip');
    assert.strictEqual(await pick({ os: 'windows', arch: 'x64' }), 'thing-2.0-win64.zip');
    assert.strictEqual(await pick({ os: 'linux', variant: 'dynamic' }), 'thing-2.0-linux-x86-dynssl.zip');
});

t('"supports": open.mp-only package on SA-MP is refused, flat files are components on open.mp', async () => {
    const repo = { source: { 'pawn.json': JSON.stringify({ supports: 'openmp', plugins: { windows: 'thing-*.zip' } }), 'thing.inc': '' }, assets: { 'thing-1.0.zip': zip({ 'thing.dll': 'C' }) } };
    let r = await install(repo, 'samp', { os: 'windows' });
    assert.ok(!r.exists('plugins/thing.dll') && !r.exists('components/thing.dll'));
    assert.match(r.log, /open\.mp only/);
    r = await install(repo, 'openmp', { os: 'windows' });
    assert.ok(r.exists('components/thing.dll'), r.log);
});

t('"include" per server', async () => {
    const repo = { source: { 'pawn.json': JSON.stringify({ plugins: false, include: { samp: 'include/samp', openmp: 'include/omp' } }), 'include/samp/thing.inc': '', 'include/omp/thing.inc': '' }, assets: {} };
    let r = await install(repo, 'samp');
    assert.deepStrictEqual(r.entry.includePaths, ['.pawn-studio/dependencies/thing/include/samp']);
    r = await install(repo, 'openmp');
    assert.deepStrictEqual(r.entry.includePaths, ['.pawn-studio/dependencies/thing/include/omp']);
});

t('packages installed in dependencies/ by older versions move to .pawn-studio/dependencies/', async () => {
    const { root, server } = project('samp');
    fs.mkdirSync(path.join(root, 'dependencies/thing/include'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dependencies/thing/include/thing.inc'), '');
    fs.mkdirSync(path.join(root, 'dependencies/sampctl-pkg'), { recursive: true }); // not ours: stays
    fs.writeFileSync(path.join(root, 'pawn-lock.json'), JSON.stringify({ lockVersion: 2, packages: { 'someone/thing': { owner: 'someone', repo: 'thing', requirement: '^1', ref: 'v1.0.0', refType: 'tag', dir: 'dependencies/thing', includePaths: ['dependencies/thing/include'], plugins: [], files: [], dependencies: [], direct: true, installedAt: '' } } }));
    const log = [];
    const pm = new PackageManager(fakeGitHub({ source: {}, assets: {} }), { root, server, skipTransitive: [], log: (m) => log.push(m) });
    const e = pm.lock().packages['someone/thing'];
    assert.strictEqual(e.dir, '.pawn-studio/dependencies/thing');
    assert.deepStrictEqual(e.includePaths, ['.pawn-studio/dependencies/thing/include']);
    assert.ok(fs.existsSync(path.join(root, '.pawn-studio/dependencies/thing/include/thing.inc')));
    assert.ok(fs.existsSync(path.join(root, '.pawn-studio/.gitignore')));
    assert.ok(fs.existsSync(path.join(root, 'dependencies/sampctl-pkg')), 'folders that are not in the lock stay');
    assert.match(fs.readFileSync(path.join(root, 'pawn-lock.json'), 'utf8'), /\.pawn-studio\/dependencies\/thing/);
    assert.match(log.join('\n'), /moved from dependencies\//i);
});

t('archive with one folder per server (samp/… and open.mp/…, like Pawn.Json)', async () => {
    const layout = {
        'samp/plugins/PawnJson.dll': 'P', 'samp/pawno/include/PawnJson.inc': '// samp',
        'open.mp/components/PawnJson.dll': 'C', 'open.mp/qawno/include/PawnJson.inc': '// omp',
        'README.md': '',
    };
    const repo = { source: { 'PawnJson.inc': '', 'src/main.cpp': '' }, assets: { 'PawnJson-1.0.0-windows-x86.zip': zip(layout), 'PawnJson-1.0.0-linux-x86.zip': zip({}) } };
    let r = await install(repo, 'samp', { os: 'windows' });
    assert.ok(r.exists('plugins/PawnJson.dll') && !r.exists('components/PawnJson.dll'), r.log);
    assert.match(r.cfg('server.cfg'), /^plugins PawnJson$/m);
    assert.deepStrictEqual(r.entry.includePaths, ['.pawn-studio/dependencies/thing/.resources/samp/pawno/include'], 'only the SA-MP include');
    r = await install(repo, 'openmp', { os: 'windows' });
    assert.ok(r.exists('components/PawnJson.dll') && !r.exists('plugins/PawnJson.dll'), r.log);
    assert.deepStrictEqual(r.entry.includePaths, ['.pawn-studio/dependencies/thing/.resources/open.mp/qawno/include'], 'only the open.mp include');
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'components/PawnJson.dll'), 'utf8'), 'C');
});

t('"layout" declares where each file is inside the archive', async () => {
    const files = {
        'PawnJson-1.0.0/bin/legacy/PawnJson.dll': 'P',
        'PawnJson-1.0.0/bin/omp/PawnJson.dll': 'C',
        'PawnJson-1.0.0/bin/omp/extra.dll': 'X',
        'PawnJson-1.0.0/inc/samp/PawnJson.inc': '',
        'PawnJson-1.0.0/inc/omp/PawnJson.inc': '',
        'PawnJson-1.0.0/libs/libjson.dll': 'L',
    };
    const manifest = {
        plugins: { windows: 'PawnJson-*.zip' },
        layout: {
            samp: { plugins: 'bin/legacy', include: 'inc/samp' },
            openmp: { components: 'bin/omp/PawnJson.dll', include: 'inc/omp' },
            all: { libraries: 'libs/*.dll' },
        },
    };
    const repo = { source: { 'pawn.json': JSON.stringify(manifest) }, assets: { 'PawnJson-1.0.0.zip': zip(files) } };
    let r = await install(repo, 'samp', { os: 'windows' });
    assert.ok(r.exists('plugins/PawnJson.dll') && !r.exists('components/PawnJson.dll') && r.exists('libjson.dll'), r.log);
    assert.deepStrictEqual(r.entry.includePaths, ['.pawn-studio/dependencies/thing/.resources/PawnJson-1.0.0/inc/samp'], 'the top folder of the archive is looked through');
    r = await install(repo, 'openmp', { os: 'windows' });
    assert.ok(r.exists('components/PawnJson.dll') && !r.exists('components/extra.dll') && !r.exists('plugins/PawnJson.dll'), 'only the declared component: ' + r.log);
    assert.deepStrictEqual(r.entry.includePaths, ['.pawn-studio/dependencies/thing/.resources/PawnJson-1.0.0/inc/omp']);
    // a path that is not in the archive is reported
    repo.source['pawn.json'] = JSON.stringify({ ...manifest, layout: { samp: { plugins: 'nope/plugins' } } });
    r = await install(repo, 'samp', { os: 'windows' });
    assert.match(r.log, /"layout": nope\/plugins/);
});

(async () => {
    let n = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            n++;
            console.log('  ok -', name);
        } catch (e) {
            console.error('  not ok -', name, '\n', e.message);
            process.exitCode = 1;
        }
    }
    console.log(`${n} package manager checks passed`);
})();
