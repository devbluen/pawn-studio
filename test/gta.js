/**
 * Asset readers against a real GTA San Andreas installation (skipped when none is found).
 *   node test/gta.js [gta folder]
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findGtaDir, GtaInstall } = require('../out/gta/install');
const { parseDff } = require('../out/gta/dff');

const dir = findGtaDir(process.argv[2]);
if (!dir) {
    console.log('GTA San Andreas not found — real-asset checks skipped');
    process.exit(0);
}
const gta = new GtaInstall(dir);
let n = 0;
const t = (name, fn) => {
    fn();
    n++;
    console.log('  ok -', name);
};
console.log('GTA:', dir);

t('object catalog (GTA + SA-MP)', () => {
    const objs = gta.objects();
    assert.ok(objs.length > 14000, `only ${objs.length} objects`);
    const bin = objs.find((o) => o.id === 1337);
    assert.strictEqual(bin.model.toLowerCase(), 'binnt07_la');
    if (objs.some((o) => o.archive === 'samp')) assert.ok(objs.find((o) => o.id === 18749), 'SA-MP objects (SAMP.ide)');
});

t('models: a sample of objects parses with geometry and textures', () => {
    const objs = gta.objects();
    let checked = 0;
    for (let i = 0; i < objs.length; i += 97) {
        const o = objs[i];
        const m = gta.loadModel(o.model, o.txd);
        if (!m) continue;
        assert.ok(m.model.meshes.length > 0, `${o.id} ${o.model}: no meshes`);
        for (const mesh of m.model.meshes) {
            const nv = mesh.positions.length / 3;
            for (const g of mesh.groups) assert.ok(g.indices.every((x) => x < nv), `${o.model}: index out of range`);
        }
        checked++;
    }
    assert.ok(checked > 100, `only ${checked} models checked`);
    const bin = gta.loadModel('BinNt07_LA', 'LABins01_LA');
    assert.ok(Object.keys(bin.textures).length >= 1, 'bin textures');
    assert.ok(bin.model.meshes[0].groups.length === 2, 'bin has 2 materials (triangle layout v1,v0,mat,v2)');
});

t('sprites decode to PNG', () => {
    const libs = gta.sprites();
    assert.ok(libs.length > 20);
    const beat = libs.find((l) => l.name === 'ld_beat');
    assert.ok(beat && beat.textures.some((x) => x.name === 'chit'));
    const png = gta.spritePng('ld_beat', 'chit');
    assert.ok(png.startsWith('data:image/png;base64,'));
    assert.ok(Buffer.from(png.split(',')[1], 'base64').length > 100);
});

t('animations: libraries, unit quaternions', () => {
    const libs = gta.animationLibraries();
    assert.ok(libs.length > 100);
    assert.ok(libs.find((l) => l.name === 'PED').animations.length > 200);
    const walk = gta.animation('PED', 'WALK_civi');
    assert.ok(walk.duration > 0.5 && walk.bones.length > 20);
    for (const b of walk.bones) for (const f of b.frames) assert.ok(Math.abs(Math.hypot(...f.rot) - 1) < 0.02, `${b.name}: non-unit quaternion`);
});

t('ped skinning: bone x inverseBind = the skinned atomic frame (viewer relies on it)', () => {
    const ped = gta.loadModel('male01', 'male01').model;
    assert.ok(ped.hanim && ped.hanim.length === 32, 'HAnim hierarchy');
    const mesh = ped.meshes[0];
    assert.ok(mesh.skin, 'skin plugin');
    const mul = (a, b) => {
        const r = new Array(16).fill(0);
        for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k];
        return r;
    };
    const world = [];
    const W = (i) => world[i] || (world[i] = ped.frames[i].parent >= 0 ? mul(W(ped.frames[i].parent), ped.frames[i].matrix) : ped.frames[i].matrix);
    const expected = W(mesh.frame);
    ped.hanim.forEach((node, i) => {
        const fi = ped.frames.findIndex((f) => f.boneId === node.id);
        const got = mul(W(fi), mesh.skin.inverseBind[i]);
        for (let k = 0; k < 16; k++) assert.ok(Math.abs(got[k] - expected[k]) < 0.01, `bone ${node.id}`);
    });
});

t('sounds and skins', () => {
    const s = gta.sounds();
    assert.ok(s.length > 1000);
    assert.strictEqual(s.find((x) => x.id === 1139).name, 'SOUND_CHECKPOINT_RED');
    assert.ok(gta.skins().find((x) => x.id === 7 && x.model.toLowerCase() === 'male01'));
});

t('map placements and the radar map image', () => {
  const pl = gta.placements();
  assert.ok(pl.length > 40000, `only ${pl.length} placements`);
  assert.ok(pl.some((p) => p.isLod) && pl.every((p) => Math.abs(p.x) < 3100 && Math.abs(p.y) < 3100), 'LODs flagged, positions inside the map');
  const bins = pl.filter((p) => p.id === 1337);
  assert.ok(bins.length > 5 && bins.every((p) => p.interior < 256), 'binary IPL interior masked');
  const png = Buffer.from(gta.mapPng().split(',')[1], 'base64');
  assert.strictEqual(png.readUInt32BE(16), 1536, 'map is 12 x 128 px wide');
});

t('sound effects: banks and PlayerPlaySound audio', () => {
  const sfx = gta.sfx();
  assert.ok(sfx, 'audio/CONFIG + audio/SFX');
  const banks = sfx.banks();
  assert.ok(banks.length > 700 && banks.reduce((a, b) => a + b.sounds, 0) > 50000);
  for (const id of [1139, 1052, 1083, 1130]) {
    const parts = gta.soundParts(id);
    assert.ok(parts.length, `${id} has sounds`);
    for (const p of parts) {
      const s = sfx.sound(p.bank, p.sound);
      assert.ok(s.rate >= 8000 && s.rate <= 48000 && s.pcm.length > 100, `${id}: ${p.bank}:${p.sound}`);
    }
  }
  assert.strictEqual(gta.sounds().find((s) => s.id === 1139).kind, 'play');
});

t('attachment editor: catalog and raw models (skin, vehicle with vehicle.txd, SA-MP object)', () => {
  const rows = gta.catalog();
  assert.ok(rows.filter((x) => x[3] === 's').length > 250 && rows.filter((x) => x[3] === 'v').length === 212);
  assert.deepStrictEqual(rows.find((x) => x[0] === 411).slice(1, 4), ['infernus', 'INFERNU', 'v']);
  const skin = gta.rawModel(7);
  assert.strictEqual(skin.kind, 'skin');
  assert.ok(skin.dff.length > 1000 && skin.textures.length >= 1);
  const car = gta.rawModel(411);
  assert.strictEqual(car.kind, 'vehicle');
  assert.ok(car.textures.some((x) => /^vehicle/i.test(x.name)), 'shared textures from models/generic/vehicle.txd');
  if (gta.objects().some((o) => o.id === 18645)) {
    const helmet = gta.rawModel(18645);
    assert.strictEqual(helmet.kind, 'object');
    assert.ok(helmet.textures.length >= 1 && helmet.textures.length < 8, 'only the textures the model uses');
  }
});

t('object positions: Idlewood gas pumps with their rotation', () => {
  const { objectRotation } = require('../out/gta/ipl');
  const pumps = gta.placements().filter((p) => p.id === 1676 && Math.abs(p.x - 1941.6563) < 0.01);
  assert.strictEqual(pumps.length, 4);
  assert.deepStrictEqual(objectRotation(pumps[0].rot), [0, 0, -90]);
});

t('a modloader skin replaces the one in gta3.img (attachment editor)', () => {
  const os = require('os');
  const { GtaInstall } = require('../out/gta/install');
  const { ImgArchive } = require('../out/gta/img');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-game-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'modloader/MySkin'), { recursive: true });
  fs.copyFileSync(path.join(gta.dir, 'data/peds.ide'), path.join(tmp, 'data/peds.ide'));
  const img = ImgArchive.open(path.join(gta.dir, 'models/gta3.img'));
  fs.writeFileSync(path.join(tmp, 'modloader/MySkin/male01.dff'), img.read('male01.dff'));
  fs.writeFileSync(path.join(tmp, 'modloader/MySkin/male01.txd'), img.read('male01.txd'));
  const fake = new GtaInstall(tmp);
  const r = fake.rawModel(7);
  assert.ok(r, 'skin 7 found without any IMG archive');
  assert.match(r.origin, /^modloader/);
  assert.ok(r.textures.length >= 1);
});

void fs;
void parseDff;
console.log(`\n${n} GTA asset checks passed`);
