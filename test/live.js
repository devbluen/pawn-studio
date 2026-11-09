/**
 * Integration test against the real GitHub (needs internet).
 *   npm run test:live          (set GH_TOKEN to avoid the 60 req/h limit)
 * Creates a fake SA-MP server in a temp folder, installs crashdetect + streamer + mysql (none of them
 * has a Pawn Studio pawn.json — everything is auto-detected), checks plugins/server.cfg/pawn.json/lock,
 * checks for updates, installs from the lock again and removes.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitHub } = require('../out/packages/github');
const { PackageManager } = require('../out/packages/manager');
const { findServer, readServerPlugins } = require('../out/packages/manifest');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-live-'));
    fs.mkdirSync(path.join(dir, 'gamemodes'));
    fs.writeFileSync(path.join(dir, 'server.cfg'), 'echo Executing Server Config...\nrcon_password test\nport 7777\ngamemode0 main 1\n');
    const gh = new GitHub(async () => process.env.GH_TOKEN);
    const server = findServer(dir);
    const pm = new PackageManager(gh, { root: dir, server, log: (m) => console.log('   ' + m) });

    console.log('• installing crashdetect');
    const cd = await pm.add('AmyrAhmady/samp-plugin-crashdetect');
    console.log('• installing streamer (exact version)');
    const st = await pm.add('samp-incognito/samp-streamer-plugin', { requirement: '2.9.5' });
    console.log('• installing mysql');
    const my = await pm.add('pBlueG/SA-MP-MySQL');

    const plugins = readServerPlugins(server);
    console.log('  server.cfg plugins:', plugins.join(' '));
    console.log('  pawn.json:', JSON.stringify(pm.manifest().dependencies));
    console.log('  include dirs:', pm.includeDirs().map((p) => path.relative(dir, p)).join(', '));
    assert.ok(cd.ref && st.ref && my.ref, 'versions resolved');
    const deps = pm.manifest().dependencies;
    assert.strictEqual(Object.keys(deps).length, 3);
    assert.ok(/^\^/.test(deps['AmyrAhmady/samp-plugin-crashdetect']), 'caret range written by default');
    assert.strictEqual(deps['samp-incognito/samp-streamer-plugin'], '2.9.5');
    assert.ok(/2\.9\.5/.test(st.ref), 'exact version installed');
    assert.ok(cd.commit && cd.commit.length === 40, 'commit locked for tags too');
    assert.ok(pm.includeDirs().some((p) => fs.readdirSync(p).some((f) => /streamer\.inc$/i.test(f))), 'streamer.inc present');
    if (process.platform === 'win32') {
        assert.ok(plugins.some((p) => /streamer/i.test(p)), 'streamer plugin registered');
        assert.ok(fs.readdirSync(path.join(dir, 'plugins')).some((f) => /streamer.*\.dll$/i.test(f)), 'streamer.dll copied');
        assert.ok(plugins.some((p) => /crashdetect/i.test(p)) && plugins.some((p) => /mysql/i.test(p)), 'crashdetect + mysql registered');
        assert.ok(fs.existsSync(path.join(dir, 'libmariadb.dll')), 'mysql runtime library next to the server');
        assert.ok(!plugins.some((p) => /libmariadb|log-core/i.test(p)), 'runtime libraries are not registered as plugins');
        assert.ok(pm.includeDirs().some((p) => fs.existsSync(path.join(p, 'a_mysql.inc'))), 'a_mysql.inc from the release');
    }

    console.log('• checking for updates');
    const upd = await pm.checkUpdates();
    for (const u of upd.values()) console.log(`  ${u.key}: ${u.state} ${u.current} → wanted ${u.wanted ?? '-'} · latest ${u.latest ?? '-'}`);
    assert.strictEqual(upd.get('samp-incognito/samp-streamer-plugin').state, 'major', 'exact 2.9.5 with newer releases → major');

    console.log('• reinstalling from the lock (dependencies/ deleted)');
    const lockedCommit = pm.lock().packages['amyrahmady/samp-plugin-crashdetect'].commit;
    fs.rmSync(path.join(dir, 'dependencies'), { recursive: true, force: true });
    await pm.installAll();
    assert.strictEqual(pm.lock().packages['amyrahmady/samp-plugin-crashdetect'].commit, lockedCommit, 'same commit after reinstall');
    assert.ok(pm.includeDirs().some((p) => fs.readdirSync(p).some((f) => /streamer\.inc$/i.test(f))), 'streamer.inc back');

    console.log('• updating streamer to the latest (rewrites pawn.json)');
    const changed = await pm.update(['samp-incognito/samp-streamer-plugin'], { toLatest: true });
    console.log('  ' + changed.join('; '));
    assert.ok(/^\^/.test(pm.manifest().dependencies['samp-incognito/samp-streamer-plugin']), 'requirement became ^latest');

    console.log('• removing streamer');
    await pm.remove('samp-incognito/samp-streamer-plugin');
    assert.ok(!readServerPlugins(server).some((p) => /streamer/i.test(p)), 'plugin removed from server.cfg');
    assert.ok(!Object.keys(pm.lock().packages).includes('samp-incognito/samp-streamer-plugin'), 'removed from the lock');
    console.log('\nlive test OK —', dir);
})().catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
});
