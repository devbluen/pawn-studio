const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { IncludeGraph, pathKey, stripComments, analyzeSource } = require('../out/includeGraph');
const { parseOutput, findCompiler, autoIncludeDirs, buildArgs } = require('../out/compiler');

const F = path.join(__dirname, 'fixture');
const p = (...s) => path.join(F, ...s);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok -', name); };

const g = new IncludeGraph([p('pawno', 'include')]);
const pwns = ['gamemodes/main.pwn', 'modules/core.pwn', 'modules/player/player.pwn', 'modules/orphan.pwn',
  'modules/directive.pwn', 'filterscripts/admin.pwn', 'filterscripts/simple.pwn'].map((f) => p(f));
const { roots, closures } = g.findRoots(pwns);
const owners = (f) => roots.filter((r) => closures.get(pathKey(r)).has(pathKey(f))).map((r) => path.basename(r)).sort();

t('comments are ignored', () => {
  const s = stripComments('a // x "y"\n/* b\nc */ d "e // f" \'/\'');
  assert.strictEqual(s, 'a \n\n d "e // f" \'/\'');
});
t('include with <>, "" and no delimiter', () => {
  const r = analyzeSource('#include <a_samp>\n  #tryinclude "x/y"\n#include ..\\mod\\z\n// #include <no>');
  assert.deepStrictEqual(r.includes.map((i) => i.style + ':' + i.name), ['angle:a_samp', 'quote:x/y', 'bare:..\\mod\\z']);
});
t('roots = main.pwn, admin.pwn, simple.pwn (ALS hook modules and orphans are not)', () => {
  assert.deepStrictEqual(roots.map((r) => path.relative(F, r).split(path.sep).join('/')).sort(),
    ['filterscripts/admin.pwn', 'filterscripts/simple.pwn', 'gamemodes/main.pwn']);
});
t('nested include relative to the including file (3 levels)', () => {
  assert.deepStrictEqual(owners(p('include', 'utils.inc')), ['main.pwn']);
  assert.deepStrictEqual(owners(p('modules', 'player', 'player.pwn')), ['main.pwn']);
});
t('commented include is not in the graph', () => {
  const cl = closures.get(pathKey(p('gamemodes', 'main.pwn')));
  assert.ok(![...cl.values()].some((v) => /commented/.test(v)));
});
t('include shared by GM and FS = ambiguous', () => {
  assert.deepStrictEqual(owners(p('modules', 'shared.inc')), ['admin.pwn', 'main.pwn']);
});
t('system include (<a_samp>) resolved via include folder', () => {
  assert.deepStrictEqual(owners(p('pawno', 'include', 'a_samp.inc')), ['admin.pwn', 'main.pwn', 'simple.pwn']);
});
t('orphan module belongs to nobody', () => assert.deepStrictEqual(owners(p('modules', 'orphan.pwn')), []));
t('gamemode/filterscript classification', () => {
  assert.strictEqual(g.kind(p('gamemodes', 'main.pwn')), 'gamemode');
  assert.strictEqual(g.kind(p('filterscripts', 'admin.pwn')), 'filterscript');
  assert.strictEqual(g.kind(p('filterscripts', 'simple.pwn')), 'filterscript');
});
t('@entry directive', () => assert.strictEqual(g.info(p('modules', 'directive.pwn')).directive, '../filterscripts/admin.pwn'));

t('pawncc output parser', () => {
  const out = [
    'Pawn compiler 3.10.10\t\t\tCopyright (c) 1997-2006, ITB CompuPhase',
    'C:\\srv\\gamemodes\\main.pwn(12) : error 017: undefined symbol "foo"',
    '..\\modules\\core.pwn(10 -- 14) : warning 203: symbol is never used: "a"',
    'main.pwn(1) : fatal error 100: cannot read from file: "y_hooks"',
    '',
    'Compilation aborted.',
    '2 Errors.',
  ].join('\r\n');
  const d = parseOutput(out, path.join(path.sep, 'srv', 'gamemodes'));
  assert.strictEqual(d.length, 3);
  assert.deepStrictEqual(d.map((x) => [x.severity, x.code, x.line, x.endLine]),
    [['error', '017', 12, 12], ['warning', '203', 10, 14], ['fatal', '100', 1, 1]]);
  assert.strictEqual(d[2].message, 'cannot read from file: "y_hooks"');
  assert.strictEqual(path.basename(d[1].file), 'core.pwn');
  assert.ok(d[1].file.includes('modules'));
});
t('automatic include folders', () => {
  const fakeCompiler = p('pawno', process.platform === 'win32' ? 'pawncc.exe' : 'pawncc');
  assert.deepStrictEqual(autoIncludeDirs(fakeCompiler, p('gamemodes', 'main.pwn')), [p('pawno', 'include'), p('include')]);
});
t('pawncc arguments', () => {
  const a = buildArgs({ compiler: 'x', entry: p('gamemodes', 'main.pwn'), output: p('gamemodes', 'main.amx'),
    includeDirs: [p('pawno', 'include') + path.sep], args: ['-;+', '-d3'] });
  assert.deepStrictEqual(a, [p('gamemodes', 'main.pwn'), '-i' + p('pawno', 'include'), '-;+', '-d3', '-o' + p('gamemodes', 'main.amx')]);
});
t('missing compiler', () => assert.strictEqual(findCompiler(p('nao_existe.exe'), []), undefined));

// ───────────────────────── packages ─────────────────────────
const { parsePackageInput, parseRequirement, satisfies, resolveTag, refSatisfies, caretFor, compareVersions, latestTag } = require('../out/packages/deps');
t('package names', () => {
  assert.deepStrictEqual(parsePackageInput('pawn-lang/YSI-Includes'), { name: { owner: 'pawn-lang', repo: 'YSI-Includes' }, requirement: undefined });
  assert.deepStrictEqual(parsePackageInput('samp-incognito/samp-streamer-plugin@^2.9'), { name: { owner: 'samp-incognito', repo: 'samp-streamer-plugin' }, requirement: '^2.9' });
  assert.deepStrictEqual(parsePackageInput('https://github.com/user/repo.git').name, { owner: 'user', repo: 'repo' });
  assert.strictEqual(parsePackageInput('https://github.com/user/repo/tree/dev').requirement, 'branch:dev');
  assert.strictEqual(parsePackageInput('https://github.com/user/repo/releases/tag/v1.0').requirement, 'tag:v1.0');
  assert.strictEqual(parsePackageInput('nada'), undefined);
  assert.strictEqual(parsePackageInput('user/repo@commit:zz'), undefined);
});
t('version requirements', () => {
  assert.deepStrictEqual(parseRequirement('latest'), { kind: 'latest' });
  assert.deepStrictEqual(parseRequirement('*'), { kind: 'latest' });
  assert.deepStrictEqual(parseRequirement('branch:dev'), { kind: 'branch', branch: 'dev' });
  assert.deepStrictEqual(parseRequirement('commit:a1b2c3d'), { kind: 'commit', commit: 'a1b2c3d' });
  assert.deepStrictEqual(parseRequirement('tag:r1-final'), { kind: 'tag', tag: 'r1-final' });
  assert.strictEqual(parseRequirement('^2.9.6').kind, 'range');
  assert.strictEqual(parseRequirement('v2.9.6').exact, 'v2.9.6');
  assert.strictEqual(parseRequirement('^2.9.6').exact, undefined);
  assert.strictEqual(parseRequirement('banana'), undefined);
});
t('ranges', () => {
  assert.ok(satisfies('v2.9.6', '^2.9.6'));
  assert.ok(satisfies('v2.10.0', '^2.9.6'));
  assert.ok(!satisfies('v3.0.0', '^2.9.6'));
  assert.ok(!satisfies('v2.9.5', '^2.9.6'));
  assert.ok(satisfies('0.2.9', '^0.2.3') && !satisfies('0.3.0', '^0.2.3'));
  assert.ok(satisfies('2.9.9', '~2.9.6') && !satisfies('2.10.0', '~2.9.6'));
  assert.ok(satisfies('5.10.0006', '5.x') && satisfies('v5.1', '5'));
  assert.ok(satisfies('1.5', '>=1.2 <2') && !satisfies('2.0', '>=1.2 <2'));
  assert.ok(satisfies('3.1', '^1 || ^3'));
  assert.ok(satisfies('1.3', '1.2 - 1.4') && !satisfies('1.5', '1.2 - 1.4'));
  assert.ok(!satisfies('v3.0-rc1', '^2.0 || >=3.0'), 'pre-release excluded by default');
  assert.ok(satisfies('v3.0.0-rc1', '>=3.0.0-rc0'));
  assert.ok(satisfies('v2.9.6', '2.9.6'));
});
t('resolving tags', () => {
  const tags = ['v2.8.0', 'v2.9.4', 'v2.9.6', 'v3.0.0-beta', 'nightly'];
  assert.strictEqual(resolveTag(tags, parseRequirement('^2.8')), 'v2.9.6');
  assert.strictEqual(resolveTag(tags, parseRequirement('~2.9.4')), 'v2.9.6');
  assert.strictEqual(resolveTag(tags, parseRequirement('2.9.4')), 'v2.9.4');
  assert.strictEqual(resolveTag(tags, parseRequirement('latest')), 'v2.9.6');
  assert.strictEqual(resolveTag(tags, parseRequirement('tag:nightly')), 'nightly');
  assert.strictEqual(resolveTag(tags, parseRequirement('^4')), undefined);
  assert.ok(refSatisfies({ type: 'tag', ref: 'v2.9.4' }, parseRequirement('^2.9')));
  assert.ok(!refSatisfies({ type: 'tag', ref: 'v2.9.4' }, parseRequirement('branch:master')));
  assert.ok(refSatisfies({ type: 'commit', ref: 'abc', commit: 'abcdef123' }, parseRequirement('commit:abcdef')));
  assert.strictEqual(caretFor('v2.9.6'), '^2.9.6');
  assert.strictEqual(caretFor('nightly'), 'nightly');
  // SA-MP style tags (mysql: R41-4)
  const my = ['R39-6', 'R40-1', 'R41-2', 'R41-4'];
  assert.strictEqual(latestTag(my), 'R41-4');
  assert.strictEqual(caretFor('R41-4'), '^R41-4');
  assert.strictEqual(resolveTag(my, parseRequirement('^R41-2')), 'R41-4');
  assert.strictEqual(resolveTag(my, parseRequirement('R40-1')), 'R40-1');
  assert.ok(refSatisfies({ type: 'tag', ref: 'R41-4' }, parseRequirement('^R41-4')));
});
t('version comparison', () => {
  assert.ok(compareVersions('v2.9.6', 'v2.9.5') > 0);
  assert.ok(compareVersions('2.10', '2.9.9') > 0);
  assert.ok(compareVersions('1.0', '1.0-beta') > 0);
  assert.strictEqual(latestTag(['v1.0', 'v1.2-rc1', 'v1.1', 'nightly']), 'v1.1');
  assert.strictEqual(latestTag(['main']), undefined);
});

const { pickAsset, classifyBinaries, detectIncludeDirs } = require('../out/packages/detect');
t('release asset detection', () => {
  const A = (...names) => names.map((name) => ({ name }));
  // crashdetect style
  const cd = A('crashdetect-4.22-linux.tar.gz', 'crashdetect-4.22-win32.zip', 'crashdetect-4.22-win32-pdb.zip');
  assert.strictEqual(pickAsset(cd, 'windows').name, 'crashdetect-4.22-win32.zip');
  assert.strictEqual(pickAsset(cd, 'linux').name, 'crashdetect-4.22-linux.tar.gz');
  // streamer style: one neutral archive with both builds
  const st = A('samp-streamer-plugin-2.9.6.zip', 'Source code.zip');
  assert.strictEqual(pickAsset(st, 'windows').name, 'samp-streamer-plugin-2.9.6.zip');
  // bare binaries, 32-bit preferred
  const bin = A('plugin.so', 'plugin.dll', 'plugin-x64.dll');
  assert.strictEqual(pickAsset(bin, 'windows').name, 'plugin.dll');
  assert.strictEqual(pickAsset(bin, 'linux').name, 'plugin.so');
  // explicit glob from the package's pawn.json, and opting out
  assert.strictEqual(pickAsset(cd, 'windows', { windows: '*-win32-pdb.zip' }).name, 'crashdetect-4.22-win32-pdb.zip');
  assert.strictEqual(pickAsset(cd, 'windows', false), undefined);
  assert.strictEqual(pickAsset(A('docs.pdf'), 'windows'), undefined);
});
t('binary layout inside an asset', () => {
  const r = 'R';
  const f = (...p) => p.map((x) => path.join(r, x));
  // mysql style: plugins/ folder + runtime libraries at the root
  let l = classifyBinaries(r, f('plugins/mysql.dll', 'libmariadb.dll', 'log-core.dll', 'pawno/include/a_mysql.inc', 'plugins/mysql.so'), 'windows');
  assert.deepStrictEqual(l.plugins.map((x) => path.basename(x)), ['mysql.dll']);
  assert.deepStrictEqual(l.libraries.map((x) => path.basename(x)).sort(), ['libmariadb.dll', 'log-core.dll']);
  // flat archive: every binary is a plugin; x64 duplicates dropped
  l = classifyBinaries(r, f('crashdetect.dll', 'x64/crashdetect.dll'), 'windows');
  assert.deepStrictEqual(l.plugins, f('crashdetect.dll'));
  // open.mp components
  l = classifyBinaries(r, f('components/pawn-memory.dll', 'plugins/x.dll'), 'windows');
  assert.deepStrictEqual(l.components, f('components/pawn-memory.dll'));
  assert.deepStrictEqual(l.plugins, f('plugins/x.dll'));
});
t('binary layout: one library shipped as plugin and as open.mp component (audio-cast)', () => {
  const r = 'R';
  const f = (...p) => p.map((x) => path.join(r, x));
  const files = f('plugins/audio-cast.dll', 'components/audio-cast.dll', 'include/audio-cast.inc', 'tools/audio-cast-check.exe');
  // the two files have the same name but are not two builds of one plugin: both survive without a server
  let l = classifyBinaries(r, files, 'windows');
  assert.deepStrictEqual(l.plugins, f('plugins/audio-cast.dll'));
  assert.deepStrictEqual(l.components, f('components/audio-cast.dll'));
  // SA-MP server: the plugin, the component is left out
  l = classifyBinaries(r, files, 'windows', 'samp');
  assert.deepStrictEqual(l.plugins, f('plugins/audio-cast.dll'));
  assert.deepStrictEqual(l.components, []);
  assert.deepStrictEqual(l.skipped, f('components/audio-cast.dll'));
  // open.mp server: the component, not the legacy plugin too
  l = classifyBinaries(r, files, 'windows', 'openmp');
  assert.deepStrictEqual(l.plugins, []);
  assert.deepStrictEqual(l.components, f('components/audio-cast.dll'));
  assert.deepStrictEqual(l.skipped, f('plugins/audio-cast.dll'));
});

t('include folder detection', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-det-'));
  const mk = (rel) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), ''); };
  mk('a/pawno/include/lib.inc'); mk('a/test/x.inc');
  assert.deepStrictEqual(detectIncludeDirs(path.join(tmp, 'a')), ['pawno/include']);
  mk('b/lib.inc'); mk('b/include/other.inc');
  assert.deepStrictEqual(detectIncludeDirs(path.join(tmp, 'b')), ['']);
  mk('c/src/x.cpp');
  assert.deepStrictEqual(detectIncludeDirs(path.join(tmp, 'c')), ['']);
  mk('d/custom/lib.inc');
  assert.deepStrictEqual(detectIncludeDirs(path.join(tmp, 'd'), 'custom'), ['custom']);
  assert.deepStrictEqual(detectIncludeDirs(path.join(tmp, 'd'), ['custom', 'missing']), ['custom']);
});

const { readManifest, writeManifest, ManifestError } = require('../out/packages/manifest');
t('pawn.json format', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-man-'));
  writeManifest(tmp, { name: 'gm', dependencies: { 'b/zed': '^1', 'A/lib': 'latest' }, devDependencies: {} });
  const m = readManifest(tmp);
  assert.deepStrictEqual(Object.keys(m.dependencies), ['A/lib', 'b/zed'], 'sorted');
  assert.strictEqual(m.devDependencies, undefined, 'empty devDependencies dropped');
  fs.writeFileSync(path.join(tmp, 'pawn.json'), '{"dependencies":["user/repo:1.0"]}');
  assert.throws(() => readManifest(tmp), (e) => e instanceof ManifestError && e.problem === 'array-dependencies');
  fs.writeFileSync(path.join(tmp, 'pawn.json'), '{ broken');
  assert.throws(() => readManifest(tmp), (e) => e.problem === 'invalid-json');
});

const { readArchive, stripCommonRoot, extractTo } = require('../out/packages/archive');
t('zip and tar.gz (created by the system tar)', () => {
  const cp = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-arch-'));
  fs.mkdirSync(path.join(tmp, 'pkg-1.0', 'include'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg-1.0', 'include', 'x.inc'), 'native X();');
  fs.writeFileSync(path.join(tmp, 'pkg-1.0', 'pawn.json'), '{"include":"include"}');
  let tested = 0;
  for (const [name, flags] of [['a.tar.gz', '-czf'], ['a.zip', '-acf']]) {
    try { cp.execFileSync('tar', [flags, name, 'pkg-1.0'], { cwd: tmp, stdio: 'ignore' }); } catch { continue; }
    const entries = stripCommonRoot(readArchive(fs.readFileSync(path.join(tmp, name))));
    const out = path.join(tmp, 'out-' + name);
    extractTo(entries, out);
    assert.strictEqual(fs.readFileSync(path.join(out, 'include', 'x.inc'), 'utf8'), 'native X();', name);
    tested++;
  }
  assert.ok(tested >= 1, 'no format could be tested');
});
t('extraction blocks paths outside the folder (zip slip)', () => {
  assert.throws(() => extractTo([{ name: '../evil.txt', isDir: false, data: () => Buffer.from('x') }], path.join(require('os').tmpdir(), 'pawn-slip')));
});

const { setServerPlugin, readServerPlugins, pluginConfigName } = require('../out/packages/manifest');
t('plugins in server.cfg and config.json', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-cfg-'));
  const samp = { dir: tmp, kind: 'samp', configFile: path.join(tmp, 'server.cfg') };
  fs.writeFileSync(samp.configFile, 'rcon_password x\nplugins crashdetect\nport 7777\n');
  setServerPlugin(samp, 'streamer', true);
  assert.deepStrictEqual(readServerPlugins(samp), ['crashdetect', 'streamer']);
  setServerPlugin(samp, 'crashdetect.dll', false);
  assert.deepStrictEqual(readServerPlugins(samp), ['streamer']);
  assert.ok(fs.readFileSync(samp.configFile, 'utf8').includes('port 7777'));
  const omp = { dir: tmp, kind: 'openmp', configFile: path.join(tmp, 'config.json') };
  fs.writeFileSync(omp.configFile, JSON.stringify({ pawn: { main_scripts: ['main 1'] } }));
  setServerPlugin(omp, 'mysql', true);
  assert.deepStrictEqual(readServerPlugins(omp), ['mysql']);
  assert.strictEqual(pluginConfigName('plugins/streamer.dll', 'samp', 'windows'), 'streamer');
  assert.strictEqual(pluginConfigName('plugins/streamer.so', 'samp', 'linux'), 'streamer.so');
});

// ───────────────────────── crashdetect ─────────────────────────
const { LogParser, parseFrame } = require('../out/debug/crashdetect');
t('crashdetect: error with stack, arguments and paths', () => {
  const log = [
    '[12:00:00] Number of vehicle models: 0',
    '[12:00:01] [debug] Run time error 4: "Array index out of bounds"',
    '[12:00:01] [debug]  Attempted to read/write array element at index 10 in array of size 5',
    '[12:00:01] [debug] AMX backtrace:',
    '[12:00:01] [debug] #0 00000a28 in public OnPlayerCommandText (playerid=0, cmdtext[]=@00012345 "/a, b") at C:\\srv\\gamemodes\\main.pwn:25',
    '[12:00:01] [debug] #1 native CallLocalFunction () in samp-server.exe',
    '[12:00:01] [debug] #2 00000b10 in Helper (x=1) at ..\\modules\\core.pwn:7',
    '[12:00:02] Player joined',
  ];
  const p = new LogParser();
  const errs = log.flatMap((l) => p.feed(l));
  assert.strictEqual(errs.length, 1);
  const e = errs[0];
  assert.strictEqual(e.code, 4);
  assert.strictEqual(e.details[0], 'Attempted to read/write array element at index 10 in array of size 5');
  assert.strictEqual(e.frames.length, 3);
  assert.deepStrictEqual([e.frames[0].func, e.frames[0].file, e.frames[0].line], ['OnPlayerCommandText', 'C:\\srv\\gamemodes\\main.pwn', 25]);
  assert.deepStrictEqual(e.frames[0].args, [{ name: 'playerid', value: '0' }, { name: 'cmdtext[]', value: '@00012345 "/a, b"' }]);
  assert.ok(e.frames[1].native);
  assert.strictEqual(e.frames[1].func, 'CallLocalFunction');
  assert.strictEqual(e.frames[2].file, '..\\modules\\core.pwn');
});
t('crashdetect: open.mp format, crash and hang', () => {
  const p = new LogParser();
  const errs = [
    '[2026-01-01T12:00:00+0000] [Info] [debug] Server crashed while executing main.amx',
    '[2026-01-01T12:00:00+0000] [Info] [debug] AMX backtrace:',
    '[2026-01-01T12:00:00+0000] [Info] [debug] #0 00000123 in Loop () at main.pwn:9',
    '[2026-01-01T12:00:00+0000] [Info] [debug] Native backtrace:',
    '[2026-01-01T12:00:00+0000] [Info] [debug] #0 f7a1b3c8 in ?? () from server.exe',
    '[2026-01-01T12:00:00+0000] [Info] [debug] Long callback execution detected (hang or performance issue)',
  ].flatMap((l) => p.feed(l));
  const last = p.flush();
  assert.strictEqual(errs[0].kind, 'crash');
  assert.strictEqual(errs[0].frames.length, 1, 'native frames are excluded');
  assert.strictEqual(last.kind, 'hang');
});
t('script error without crashdetect', () => {
  const p = new LogParser();
  const errs = p.feed('[12:00] Script[gamemodes/main.amx]: Run time error 19: "File or function is not found"');
  assert.strictEqual(errs[0].kind, 'script');
  assert.strictEqual(errs[0].code, 19);
});
t('frame without debug info (-d0)', () => {
  const f = parseFrame(0, '00000a28 in public OnGameModeInit () from main.amx');
  assert.strictEqual(f.func, 'OnGameModeInit');
  assert.strictEqual(f.file, undefined);
});

const { buildRconPacket, parseRconReply } = require('../out/debug/rcon');
t('RCON packet', () => {
  const b = buildRconPacket('127.0.0.1', 7777, 'abc', 'gmx');
  assert.strictEqual(b.toString('latin1', 0, 4), 'SAMP');
  assert.deepStrictEqual([...b.subarray(4, 8)], [127, 0, 0, 1]);
  assert.strictEqual(b.readUInt16LE(8), 7777);
  assert.strictEqual(b.toString('latin1', 10, 11), 'x');
  assert.strictEqual(b.readUInt16LE(11), 3);
  assert.strictEqual(b.toString('latin1', 13, 16), 'abc');
  assert.strictEqual(b.readUInt16LE(16), 3);
  assert.strictEqual(b.toString('latin1', 18, 21), 'gmx');
  const reply = Buffer.concat([b.subarray(0, 11), Buffer.from([5, 0]), Buffer.from('hello')]);
  assert.strictEqual(parseRconReply(reply), 'hello');
});

// ───────────────────────── symbols ─────────────────────────
const { parseSymbols, callContext } = require('../out/language/symbols');
t('symbols: natives, stocks, publics, defines, enums, globals', () => {
  const src = [
    '#define MAX_HOUSES (500)',
    '#define IsValid(%0) ((%0) != -1)',
    '/// <summary>Teleporta o jogador.</summary>',
    'native SetPlayerPos(playerid, Float:x, Float:y, Float:z);',
    'forward OnTimer(playerid);',
    'enum E_HOUSE {',
    '    Float:hX,',
    '    hOwner[MAX_PLAYER_NAME],',
    '    hPrice',
    '}',
    'new gHouses[MAX_HOUSES][E_HOUSE], gCount = 0;',
    'static const VERSION[] = "1.0";',
    'stock Float:GetDistance(Float:a, Float:b) { return a - b; }',
    'public OnTimer(playerid)',
    '{',
    '    new local = 1;',
    '    if (local) { print("x"); }',
    '    return 1;',
    '}',
    'Helper(a, b)',
    '{',
    '    return a + b;',
    '}',
  ].join('\n');
  const syms = parseSymbols(src);
  const by = (n) => syms.find((s) => s.name === n);
  assert.strictEqual(by('MAX_HOUSES').kind, 'define');
  assert.strictEqual(by('IsValid').kind, 'macro');
  assert.strictEqual(by('SetPlayerPos').kind, 'native');
  assert.deepStrictEqual(by('SetPlayerPos').params, ['playerid', 'Float:x', 'Float:y', 'Float:z']);
  assert.strictEqual(by('SetPlayerPos').doc, 'Teleporta o jogador.');
  assert.strictEqual(by('E_HOUSE').kind, 'enum');
  assert.deepStrictEqual(syms.filter((s) => s.kind === 'enumMember').map((s) => s.name), ['hX', 'hOwner', 'hPrice']);
  assert.strictEqual(by('gHouses').kind, 'variable');
  assert.strictEqual(by('gCount').kind, 'variable');
  assert.strictEqual(by('VERSION').kind, 'constant');
  assert.strictEqual(by('GetDistance').kind, 'stock');
  assert.strictEqual(by('GetDistance').tag, 'Float');
  assert.ok(syms.some((s) => s.name === 'OnTimer' && s.kind === 'public' && s.endLine === 18));
  assert.ok(syms.some((s) => s.name === 'OnTimer' && s.kind === 'forward'));
  assert.strictEqual(by('Helper').kind, 'function');
  assert.strictEqual(by('local'), undefined, 'local is not global');
  assert.ok(parseSymbols(src, { locals: true }).some((s) => s.name === 'local'));
});
t('call context for parameter hints', () => {
  assert.deepStrictEqual(callContext('SetPlayerPos(playerid, 1.0, '), { name: 'SetPlayerPos', paramIndex: 2 });
  assert.deepStrictEqual(callContext('format(str, sizeof(str), "%d, %d", '), { name: 'format', paramIndex: 3 });
  assert.deepStrictEqual(callContext('SendClientMessage(playerid, GetColor(a, b), '), { name: 'SendClientMessage', paramIndex: 2 });
  assert.strictEqual(callContext('if (x) '), undefined);
});
const { callSnippet, paramName } = require('../out/language/symbols');
t('autocomplete fills parameters (Tab between them)', () => {
  assert.strictEqual(callSnippet('SetPlayerPos', ['playerid', 'Float:x', 'Float:y', 'Float:z'], 'native'),
    'SetPlayerPos(${1:playerid}, ${2:x}, ${3:y}, ${4:z})');
  // a parameter with a default value is left out in "required" mode
  assert.strictEqual(callSnippet('GetPlayerName', ['playerid', 'name[]', 'len = sizeof name'], 'native'),
    'GetPlayerName(${1:playerid}, ${2:name}$0)');
  assert.strictEqual(callSnippet('GetPlayerName', ['playerid', 'name[]', 'len = sizeof name'], 'native', 'all'),
    'GetPlayerName(${1:playerid}, ${2:name}, ${3:len})');
  // variadic: only the fixed ones
  assert.strictEqual(callSnippet('format', ['output[]', 'len', 'const format[]', '{Float,_}:...'], 'native'),
    'format(${1:output}, ${2:len}, ${3:format}$0)');
  assert.strictEqual(callSnippet('GetTickCount', [], 'native'), 'GetTickCount()');
  assert.strictEqual(callSnippet('Soma', ['a = 0', 'b = 0'], 'stock'), 'Soma($0)');
  assert.strictEqual(callSnippet('IsValid', ['%0'], 'macro'), 'IsValid(${1})');
  assert.strictEqual(callSnippet('X', ['a'], 'stock', 'none'), 'X($0)');
  assert.strictEqual(paramName('const Float:pos[3] = {0.0, 0.0, 0.0}'), 'pos');
  assert.strictEqual(paramName('&Float:x'), 'x');
  assert.strictEqual(paramName('E_TIPOCNH:tipo'), 'tipo');
});

// ───────────────────────── quick analysis ─────────────────────────
const { quickLint, makeContext } = require('../out/language/quickLint');
const LIB = parseSymbols([
  'native SetPlayerPos(playerid, Float:x, Float:y, Float:z);',
  'native SendClientMessage(playerid, color, const message[]);',
  'native format(output[], len, const format[], {Float,_}:...);',
  'stock Soma(a, b = 0) { return a + b; }',
  '#define Loop(%0,%1) for(new %0 = 0; %0 < %1; %0++)',
  '#define Inventario:%0(%1) forward IV_%0(%1); public IV_%0(%1)',
  '#define Dialog:%0(%1) forward dlg_%0(%1); public dlg_%0(%1)',
].join('\n'));
const lint = (src, opts = {}) => {
  const external = new Map();
  for (const s of [...LIB, ...(opts.extra ?? [])]) { if (!external.has(s.name)) external.set(s.name, []); external.get(s.name).push(s); }
  const ctx = makeContext({
    src, own: parseSymbols(src, { locals: true }), external,
    inOtherFiles: (n) => (opts.words ?? []).includes(n),
    includeExists: (name) => ['a_samp', 'modulos/player.pwn'].includes(name),
    semicolonRequired: opts.semicolon ?? true,
  });
  return quickLint(src, ctx);
};
const codes = (issues) => issues.map((i) => `${i.code}@${i.line + 1}`);
t('quick analysis: detects common errors', () => {
  const src = [
    '#include <a_samp>',
    '#include "modulos/naoexiste.pwn"',
    'main()',
    '{',
    '    SetPlayerPos(0, 1.0, 2.0)',          // 5: missing ; and not enough arguments
    '    SetPlayerPoss(0, 1.0, 2.0, 3.0);',   // 6: undefined
    '    SendClientMessage(0, -1, "oi);',     // 7: unterminated string
    '    Soma(1, 2, 3);',                     // 8: too many arguments
    '    if (1) {',                           // 9: unclosed brace
    '}',
  ].join('\n');
  const r = lint(src);
  const c = codes(r);
  for (const want of ['QL-include@2', 'QL-semicolon@5', 'QL-args@5', 'QL-undefined@6', 'QL-string@7', 'QL-args@8', 'QL-brackets@4']) {
    assert.ok(c.includes(want), `missing ${want} in ${c.join(', ')}`);
  }
  assert.ok(r.find((i) => i.code === 'QL-undefined').message.includes('did you mean "SetPlayerPos"'));
});
t('quick analysis: no false positives on real-world patterns', () => {
  const src = [
    'main()',
    '{',
    '    new',                                        // `new` alone
    '        a = 1,',
    '        b[16]',
    '    ;',                                          // `;` alone
    '    format(b, sizeof b, "SELECT * \\',           // multi-line string
    '        FROM x WHERE id = %d", a);',
    '    Loop(i, 10)',                                // loop via macro
    '        SendClientMessage(i, -1, "x");',
    '    IV_Colete(0);',                              // generated by a prefix macro
    '    new r = Soma(1);',                           // parameter with a default value
    '    format(b, 16, "%d %d %d", 1, 2, 3);',        // variadic
    '    OnTimerX(0);',                               // timer declared in the file
    '    if (a > 0 &&',
    '        b[0] == 0)',
    '        return 1;',
    '    return 0;',
    '}',
    'timer OnTimerX[1000](playerid) { }',
    'Inventario:Colete(playerid) { }',
    'Dialog:Login(playerid, response) { }',
  ].join('\n');
  const r = lint(src);
  assert.deepStrictEqual(codes(r), []);
});
t('quick analysis: multi-line string with CRLF', () => {
  const src = 'main()\r\n{\r\n    new q[64];\r\n    format(q, sizeof q, "SELECT * \\\r\n        FROM x WHERE id = %d", 1);\r\n    print(q);\r\n}\r\n';
  const extra = parseSymbols('native print(const s[]);');
  assert.deepStrictEqual(codes(lint(src, { extra })), []);
});
t('quick analysis: static function from another file does not count', () => {
  const extra = parseSymbols('static stock Menu(playerid) { }');
  const r = lint('main()\n{\n    Menu(0, 1);\n}\nstatic stock Menu(playerid, index) { }', { extra });
  assert.deepStrictEqual(codes(r), []);
});
t('quick analysis: without #pragma semicolon, ; is not required', () => {
  assert.deepStrictEqual(codes(lint('main()\n{\n    SetPlayerPos(0, 1.0, 2.0, 3.0)\n}', { semicolon: false })), []);
});
// ───────────────────────── GTA formats (synthetic data) ─────────────────────────
const zlib = require('zlib');
const { encodePng } = require('../out/gta/png');
const { readTextures, listTextures } = require('../out/gta/txd');
const { parseIde } = require('../out/gta/ide');
const { parseIfp } = require('../out/gta/ifp');
const { ImgArchive } = require('../out/gta/img');
const { parseDialogCall, splitArgs } = require('../out/assets/dialogParse');

const rwChunk = (type, payload) => {
  const h = Buffer.alloc(12);
  h.writeUInt32LE(type, 0); h.writeUInt32LE(payload.length, 4); h.writeUInt32LE(0x1803ffff, 8);
  return Buffer.concat([h, payload]);
};
function textureNative(name, raster, d3d, w, h, flags, data) {
  const s = Buffer.alloc(88 + 4 + data.length);
  s.writeUInt32LE(9, 0); // platform D3D9
  s.write(name, 8, 'latin1');
  s.writeUInt32LE(raster, 72); s.writeUInt32LE(d3d, 76);
  s.writeUInt16LE(w, 80); s.writeUInt16LE(h, 82); s[84] = 32; s[85] = 1; s[86] = 4; s[87] = flags;
  s.writeUInt32LE(data.length, 88); data.copy(s, 92);
  return rwChunk(0x15, Buffer.concat([rwChunk(1, s), rwChunk(3, Buffer.alloc(0))]));
}
t('PNG encoder', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128, 1, 2, 3, 4]);
  const png = encodePng(2, 2, rgba);
  assert.strictEqual(png.toString('latin1', 1, 4), 'PNG');
  assert.strictEqual(png.readUInt32BE(16), 2); // width
  const idat = png.indexOf('IDAT');
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.deepStrictEqual([...raw.subarray(1, 9)], [255, 0, 0, 255, 0, 255, 0, 255]);
});
t('TXD: 8888 and DXT1 textures', () => {
  // 2x2 A8R8G8B8 stored as B,G,R,A
  const argb = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 0]);
  // one DXT1 block: c0 = red (0xF800), c1 = blue (0x001F), all pixels index 0 except the first row = 1
  const dxt = Buffer.alloc(8); dxt.writeUInt16LE(0xf800, 0); dxt.writeUInt16LE(0x001f, 2); dxt.writeUInt32LE(0x00000055, 4);
  const dict = rwChunk(0x16, Buffer.concat([
    rwChunk(1, Buffer.from([2, 0, 0, 0])),
    textureNative('argb', 0x0500, 21, 2, 2, 1, argb),
    textureNative('block', 0x0200, 0x31545844, 4, 4, 0, dxt),
  ]));
  assert.deepStrictEqual(listTextures(dict).map((x) => `${x.name} ${x.width}x${x.height} ${x.format}`), ['argb 2x2 8888', 'block 4x4 DXT1']);
  const [a, b] = readTextures(dict);
  assert.deepStrictEqual([...a.rgba.subarray(0, 8)], [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.strictEqual(a.rgba[15], 0, 'alpha kept');
  assert.deepStrictEqual([...b.rgba.subarray(0, 4)], [0, 0, 255, 255], 'first row = color 1 (blue)');
  assert.deepStrictEqual([...b.rgba.subarray(16, 20)], [255, 0, 0, 255], 'second row = color 0 (red)');
});
t('IDE: objects, timed objects and weapons', () => {
  const defs = parseIde('# comment\nobjs\n1337, BinNt07_LA, LABins01_LA, 100, 0\n615, veg_tree3, gta_tree_boak, 1, 299, 0\nend\ntobj\n4212, lanitewin1, nitewin, 700, 12, 20, 6\nend\npeds\n7, male01, male01, CIVMALE\nend\nweap\n355, ak47, ak47, colt45, 1, 80, 0\nend\n', 'LA', 'gta');
  assert.deepStrictEqual(defs.map((d) => `${d.id}:${d.model}:${d.txd}:${d.section}:${d.drawDist}`), ['1337:BinNt07_LA:LABins01_LA:objs:100', '615:veg_tree3:gta_tree_boak:objs:299', '4212:lanitewin1:nitewin:tobj:700', '355:ak47:ak47:weap:1']);
});
t('IFP (ANP3): names, compressed keyframes, root translation', () => {
  const parts = [];
  const head = Buffer.alloc(36); head.write('ANP3', 0, 'latin1'); head.write('ped', 8, 'latin1'); head.writeUInt32LE(1, 32);
  const anim = Buffer.alloc(36); anim.write('WALK_test', 0, 'latin1'); anim.writeUInt32LE(1, 24); anim.writeUInt32LE(32, 28); anim.writeUInt32LE(1, 32);
  const bone = Buffer.alloc(36); bone.write('Root', 0, 'latin1'); bone.writeUInt32LE(4, 24); bone.writeUInt32LE(2, 28); bone.writeInt32LE(0, 32);
  const frames = Buffer.alloc(32);
  frames.writeInt16LE(4096, 6); frames.writeInt16LE(0, 8); // identity, t=0
  frames.writeInt16LE(2896, 16 + 4); frames.writeInt16LE(2896, 16 + 6); frames.writeInt16LE(60, 16 + 8); frames.writeInt16LE(1024, 16 + 10); // 90° Z, t=1s, x=1
  parts.push(head, anim, bone, frames);
  const pkg = parseIfp(Buffer.concat(parts));
  assert.strictEqual(pkg.name, 'ped');
  const a = pkg.animations[0];
  assert.strictEqual(a.name, 'WALK_test');
  assert.strictEqual(a.duration, 1);
  assert.deepStrictEqual(a.bones[0].frames[1].pos, [1, 0, 0]);
  assert.ok(Math.abs(Math.hypot(...a.bones[0].frames[1].rot) - 1) < 0.01);
  assert.strictEqual(parseIfp(Buffer.concat(parts), false).animations[0].bones[0].frames.length, 0, 'names-only mode');
});
t('IMG v2 archive', () => {
  const os = require('os');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-img-')), 'x.img');
  const dir = Buffer.alloc(8 + 32);
  dir.write('VER2', 0, 'latin1'); dir.writeUInt32LE(1, 4);
  dir.writeUInt32LE(1, 8); dir.writeUInt16LE(1, 12); dir.write('hello.dff', 16, 'latin1');
  const body = Buffer.alloc(2048); body.write('payload', 0);
  fs.writeFileSync(f, Buffer.concat([dir, Buffer.alloc(2048 - dir.length), body]));
  const img = ImgArchive.open(f);
  assert.ok(img.has('HELLO.DFF'));
  assert.strictEqual(img.read('hello.dff').toString('latin1', 0, 7), 'payload');
});
t('Dialog Creator reads existing calls', () => {
  assert.deepStrictEqual(splitArgs('a, "x, (y)", f(b, c), d) + 1'), ['a', '"x, (y)"', 'f(b, c)', 'd']);
  const d = parseDialogCall('ShowPlayerDialog(playerid, DIALOG_LOGIN, DIALOG_STYLE_PASSWORD, "{FFFFFF}Login", "Password:\\nAccount: %s", "Enter", "Quit");');
  assert.deepStrictEqual(d, { name: 'DIALOG_LOGIN', style: 'DIALOG_STYLE_PASSWORD', caption: '{FFFFFF}Login', body: 'Password:\nAccount: %s', button1: 'Enter', button2: 'Quit', codeStyle: 'native' });
  assert.strictEqual(parseDialogCall('Dialog_Show(playerid, Menu, DIALOG_STYLE_LIST, "M", "A\\tB", "OK", "");').codeStyle, 'easy');
  assert.strictEqual(parseDialogCall('ShowPlayerDialog(playerid, 1, DIALOG_STYLE_MSGBOX, "x", str, "ok", "")').body, undefined, 'variables are not prefilled');
  assert.strictEqual(parseDialogCall('SendClientMessage(playerid, -1, "x");'), undefined);
});

const { parseTextIpl, parseBinaryIpl } = require('../out/gta/ipl');
t('IPL placements: text inst + binary stream', () => {
  const txt = parseTextIpl('# map\ninst\n1337, BinNt07_LA, 0, 10.5, -20, 3, 0, 0, 0, 1, -1\n700, tree, 13, 1, 2, 3, 0, 0, 0.7071, 0.7071, 0\nend\ncull\n1, 2, 3\nend\n');
  assert.strictEqual(txt.length, 2);
  assert.deepStrictEqual([txt[0].id, txt[0].x, txt[0].y, txt[0].interior], [1337, 10.5, -20, 0]);
  const lods = [];
  parseTextIpl('inst\n1, a, 0, 0, 0, 0, 0, 0, 0, 1, 1\n2, lod, 0, 0, 0, 0, 0, 0, 0, 1, -1\nend\n', [], (i) => lods.push(i));
  assert.deepStrictEqual(lods, [1]);
  const b = Buffer.alloc(76 + 40);
  b.write('bnry', 0, 'latin1'); b.writeInt32LE(1, 4); b.writeInt32LE(76, 28);
  [100.25, 200.5, 10].forEach((v, i) => b.writeFloatLE(v, 76 + i * 4));
  b.writeFloatLE(1, 76 + 24); b.writeInt32LE(3095, 76 + 28); b.writeInt32LE(256 | 3, 76 + 32); b.writeInt32LE(7, 76 + 36);
  const got = [];
  const bin = parseBinaryIpl(b, [], (i) => got.push(i));
  assert.deepStrictEqual([bin[0].id, bin[0].x, bin[0].y, bin[0].interior], [3095, 100.25, 200.5, 3], 'interior keeps the low byte');
  assert.deepStrictEqual(got, [7]);
  assert.strictEqual(parseBinaryIpl(Buffer.from('nope')).length, 0);
});
const { SfxBanks, encodeWav } = require('../out/gta/sfx');
const { SOUND_MAP } = require('../out/gta/soundMap');
t('SFX banks: lookup, header, PCM slices, wav', () => {
  const os = require('os');
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-sfx-'));
  fs.mkdirSync(path.join(g, 'audio/CONFIG'), { recursive: true });
  fs.mkdirSync(path.join(g, 'audio/SFX'));
  const pak = Buffer.alloc(52); pak.write('GENRL', 0, 'latin1');
  fs.writeFileSync(path.join(g, 'audio/CONFIG/PakFiles.dat'), pak);
  // one bank at offset 10 with two sounds of 4 and 6 bytes
  const header = Buffer.alloc(4804);
  header.writeUInt16LE(2, 0);
  header.writeUInt32LE(0, 4); header.writeUInt16LE(22050, 12);
  header.writeUInt32LE(4, 16); header.writeUInt16LE(11025, 24);
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]);
  fs.writeFileSync(path.join(g, 'audio/SFX/GENRL'), Buffer.concat([Buffer.alloc(10), header, pcm]));
  const lk = Buffer.alloc(12); lk[0] = 0; lk.writeUInt32LE(10, 4); lk.writeUInt32LE(4804 + pcm.length, 8);
  fs.writeFileSync(path.join(g, 'audio/CONFIG/BankLkup.dat'), lk);
  const sfx = SfxBanks.open(g);
  assert.deepStrictEqual(sfx.banks(), [{ bank: 0, pak: 'GENRL', sounds: 2 }]);
  const s0 = sfx.sound(0, 0);
  assert.deepStrictEqual([s0.rate, [...s0.pcm]], [22050, [1, 0, 2, 0]]);
  assert.deepStrictEqual([...sfx.sound(0, 1).pcm], [3, 0, 4, 0, 5, 0]);
  assert.strictEqual(sfx.sound(0, 2), undefined);
  const wav = encodeWav(s0);
  assert.strictEqual(wav.toString('latin1', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), 22050);
  assert.strictEqual(wav.length, 44 + 4);
  assert.strictEqual(SfxBanks.open(path.join(g, 'nothing')), undefined);
});
t('sound map: PlayerPlaySound ids -> game bank sounds', () => {
  // checkpoint red = the frontend "part mission complete" pair, pitched up
  assert.deepStrictEqual(SOUND_MAP[1139], [[59, 18, -1, 1.26], [59, 19, 1, 1.26]]);
  assert.strictEqual(SOUND_MAP[1052].length, 2, 'Ammu-Nation buy: left/right pair');
  assert.strictEqual(SOUND_MAP[1010], 'mission', 'basketball needs a mission bank');
  assert.strictEqual(SOUND_MAP[1062], 'track');
  assert.ok(Object.values(SOUND_MAP).filter(Array.isArray).every((a) => a.length > 0));
});

const { findAttachBlock } = require('../out/assets/attachParse');
t('attachment editor: finds the attachment code under the cursor', () => {
  const src = [
    'stock Hat(playerid)',
    '{',
    '    SetPlayerAttachedObject(playerid, 0, 18645, 2, 0.07, 0.0, 0.0, 88.0, 75.0, 0.0);',
    '    // glasses',
    '    SetPlayerAttachedObject(playerid, 1, 19022, 2, 0.09, 0.03, 0.0, 90.0, 90.0, 0.0);',
    '    return 1;',
    '}',
    'new obj = CreateObject(19314, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);',
    'AttachObjectToVehicle(obj, vehicleid, 0.0, -0.4, 0.9, 0.0, 0.0, 0.0);',
  ];
  const p = findAttachBlock(src, 4);
  assert.strictEqual(p.target, 'player');
  assert.strictEqual(p.text.split('\n').length, 3, 'both attachments, comment kept, return left out');
  const v = findAttachBlock(src, 7);
  assert.strictEqual(v.target, 'vehicle');
  assert.ok(v.text.includes('CreateObject(19314') && v.text.includes('AttachObjectToVehicle'));
  assert.strictEqual(findAttachBlock(src, 5), undefined, 'not on attachment code');
  assert.strictEqual(findAttachBlock(src, 0, 'SetPlayerAttachedObject(playerid, 3, 1, 1);').target, 'player', 'selection wins');
});

const { objectRotation } = require('../out/gta/ipl');
t('IPL rotation: quaternion -> CreateObject rotX/rotY/rotZ', () => {
  assert.deepStrictEqual(objectRotation([0, 0, 0, 1]), [0, 0, 0]);
  // RenderWare stores the inverse rotation: +90 about Z in the file is rotZ -90 in CreateObject
  assert.deepStrictEqual(objectRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2]), [0, 0, -90]);
  assert.deepStrictEqual(objectRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]), [90, 0, 0]);
});

const { findZoneBlock } = require('../out/assets/zoneParse');
t('GangZone Creator: finds the gang zone code under the cursor', () => {
  const src = [
    'new Float:pts[] = {0.0, 0.0, 10.0, 0.0, 10.0, 10.0};',
    '',
    'public OnGameModeInit()',
    '{',
    '    gz = GangZoneCreate(-100.0, -50.0, 100.0, 50.0);',
    '    area = CreateDynamicCircle(10.0, 20.0, 30.0);',
    '    poly = CreateDynamicPolygon(pts);',
    '    return 1;',
    '}',
  ];
  const b = findZoneBlock(src, 5);
  assert.ok(b.includes('GangZoneCreate') && b.includes('CreateDynamicCircle') && b.includes('CreateDynamicPolygon'));
  assert.ok(b.includes('Float:pts[] = {0.0'), 'polygon points defined elsewhere come along');
  assert.ok(!b.includes('return 1'));
  assert.strictEqual(findZoneBlock(['main()', '{', '    print("x");', '}'], 2), undefined, 'no gang zone code');
});

// the webview modules are plain ES modules (Node loads them with require(esm))
process.removeAllListeners('warning');
const gz = require('../media/gangzone-core.js');
t('GangZone Creator: circle/polygon strips, code and re-import', () => {
  const circle = gz.makeZone('circle', { x: 0, y: 0, r: 100 }, 'Ballas', 'AA00FF', 0x99);
  circle.strips = 10;
  const strips = gz.gangRects(circle);
  assert.strictEqual(strips.length, 10);
  for (let i = 1; i < strips.length; i++) assert.ok(Math.abs(strips[i][1] - strips[i - 1][3]) < 1e-9, 'strips touch, never overlap');
  assert.ok(strips.every(([x1, y1, x2, y2]) => x1 >= -100 && x2 <= 100 && y1 >= -100 && y2 <= 100));
  const poly = gz.makeZone('poly', [[0, 0], [100, 0], [100, 100], [50, 40], [0, 100]], 'Vagos');
  poly.strips = 8;
  // a concave polygon: the top strips split in two
  assert.ok(gz.gangRects(poly).length > 8);
  assert.ok(gz.contains(poly, 10, 50) && !gz.contains(poly, 50, 80));
  const rect = gz.makeZone('rect', { x1: 2520, y1: -1620, x2: 2400, y2: -1730 }, 'Grove Street', '00FF00');
  const code = gz.generate([rect, circle, poly], { streamer: true, callbacks: true });
  assert.ok(code.includes('gz_Grove_Street = GangZoneCreate(2400.00, -1730.00, 2520.00, -1620.00);'));
  assert.ok(code.includes('area_Ballas = CreateDynamicCircle(0.00, 0.00, 100.00);'));
  assert.ok(code.includes('area_Vagos = CreateDynamicPolygon(area_Vagos_points);'));
  assert.ok(code.includes('GangZoneShowForPlayer(playerid, gz_Ballas[i], 0xAA00FF99)'));
  assert.ok(code.includes('public OnPlayerEnterDynamicArea(playerid, areaid)'));
  assert.ok(code.split('\n').every((l) => l.length < 500), 'old pawncc line limit');
  const back = gz.parseZones(code);
  assert.deepStrictEqual(back.map((z) => [z.name, z.shape, z.strips]), [['Grove_Street', 'rect', 16], ['Ballas', 'circle', 10], ['Vagos', 'poly', 8]]);
  assert.deepStrictEqual(back[2].poly, poly.poly);
  assert.strictEqual(back[1].alpha, 0x99);
  // plain code written by hand
  const plain = gz.parseZones('gz_Test = GangZoneCreate(-100.0, -50.0, 100.0, 50.0);\nGangZoneShowForAll(gz_Test, 0xFF000077);\nnew Float:pts[] = {0.0, 0.0, 10.0, 0.0, 10.0, 10.0};\np = CreateDynamicPolygon(pts);\nc = CreateDynamicCylinder(1.0, 2.0, 0.0, 50.0, 30.0);');
  assert.deepStrictEqual(plain.map((z) => z.shape), ['rect', 'circle', 'poly']);
  assert.strictEqual(plain[0].alpha, 0x77);
  assert.strictEqual(plain[1].circle.r, 30);
});

t('Pawn Studio panel: memory summary from the pawncc output', () => {
  const { parseSizes } = require('../out/compiler');
  const out = 'Pawn compiler 3.10.10\n\nHeader size:           1300 bytes\nCode size:             8440 bytes\nData size:            12852 bytes\nStack/heap size:      16384 bytes; estimated max. usage=39 cells (156 bytes)\nTotal requirements:   38976 bytes\n';
  assert.deepStrictEqual(parseSizes(out), { header: 1300, code: 8440, data: 12852, stackHeap: 16384, stackUsed: 156, total: 38976 });
  const rec = parseSizes(out.replace(/estimated max\. usage=39 cells \(156 bytes\)/, 'estimated max. usage: unknown, due to recursion'));
  assert.strictEqual(rec.stackUsed, undefined);
  assert.strictEqual(parseSizes('1 Error.'), undefined);
});

t('custom models: AddCharModel / AddSimpleModel from artconfig.txt or the gamemode', () => {
  const { parseCustomModels } = require('../out/gta/custom');
  const txt = 'AddCharModel(305, 20001, "lvpdpc2.dff", "lvpdpc2.txd");\n' +
    'AddSimpleModel(-1, 19379, -2000, "wallzzz.dff", "wallzzz.txd");\n' +
    'AddSimpleModelTimed(-1, 19379, -2001, "night/lamp.dff", "night/lamp.txd", 20, 6);\n' +
    'AddCharModel(BASE, newid, dff, txd); // not literal: skipped';
  const list = parseCustomModels(txt, 'C:/srv/models', 'models/artconfig.txt');
  assert.deepStrictEqual(list.map((c) => [c.kind, c.id, c.baseId]), [['skin', 20001, 305], ['object', -2000, 19379], ['object', -2001, 19379]]);
  assert.ok(list[2].dff.replace(/\\/g, '/').endsWith('models/night/lamp.dff'));
});

t('game models: modloader/ wins over the IMG archives', () => {
  const os = require('os');
  const { LooseFolder } = require('../out/gta/install');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-ml-'));
  fs.mkdirSync(path.join(tmp, 'modloader/MySkins/police'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'modloader/.disabled'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'modloader/MySkins/police/lapd1.dff'), 'D');
  fs.writeFileSync(path.join(tmp, 'modloader/MySkins/police/LAPD1.TXD'), 'T');
  fs.writeFileSync(path.join(tmp, 'modloader/.disabled/wmyclot.dff'), 'X');
  const l = new LooseFolder(path.join(tmp, 'modloader'));
  assert.ok(l.has('lapd1.dff') && l.has('lapd1.txd'), 'by file name, any case, any depth');
  assert.strictEqual(l.read('LAPD1.dff').toString(), 'D');
  assert.ok(!l.has('wmyclot.dff'), 'folders starting with "." are disabled mods');
});

console.log(`\n${n} tests passed`);
