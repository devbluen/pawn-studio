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
console.log(`\n${n} tests passed`);
