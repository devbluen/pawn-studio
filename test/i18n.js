/**
 * Translation checks:
 *  - every t('...') message in src/ has a pt-br translation with the same placeholders;
 *  - no unused keys in the bundle (warning only);
 *  - every %key% in package.json exists in package.nls.json and package.nls.pt-br.json;
 *  - no Portuguese left in the source code.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.ts$/.test(e.name) ? [p] : [];
    });
}

// t('...') with a single-quoted literal as first argument (handles \' escapes)
const T_RE = /\bt\(\s*'((?:[^'\\\n]|\\.)*)'/g;
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
const placeholders = (s) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

const messages = new Map(); // message -> first location
const bad = [];
for (const file of walk(SRC)) {
    if (path.basename(file) === 'i18n.ts') continue; // the helper itself (its docs contain an example)
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = T_RE.exec(src))) {
        const msg = unescape(m[1]);
        const line = src.slice(0, m.index).split('\n').length;
        if (!messages.has(msg)) messages.set(msg, `${path.relative(ROOT, file)}:${line}`);
    }
    // t(`...`) / t("...") / t(variable) are not extractable — flag them
    const other = src.match(/\bt\(\s*[`"]/g);
    if (other) bad.push(`${path.relative(ROOT, file)}: t() must use a single-quoted literal (${other.length}x)`);
}

const bundlePath = path.join(ROOT, 'l10n', 'bundle.l10n.pt-br.json');
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

let n = 0;
const check = (name, fn) => {
    fn();
    n++;
    console.log('  ok -', name);
};

check(`${messages.size} messages use t() with a literal`, () => assert.deepStrictEqual(bad, []));

check('every message has a pt-br translation', () => {
    const missing = [...messages].filter(([m]) => !(m in bundle)).map(([m, loc]) => `${loc}  ${JSON.stringify(m)}`);
    assert.deepStrictEqual(missing, [], `missing translations:\n${missing.join('\n')}`);
});

check('placeholders match between English and pt-br', () => {
    const wrong = [...messages.keys()].filter((m) => m in bundle && placeholders(m) !== placeholders(bundle[m]));
    assert.deepStrictEqual(wrong.map((m) => `${JSON.stringify(m)} → ${JSON.stringify(bundle[m])}`), []);
});

check('translations are not just copies of the English text (sanity)', () => {
    const same = [...messages.keys()].filter((m) => bundle[m] === m && /[a-z]{4,}\s+[a-z]{4,}/i.test(m));
    // a few technical strings may legitimately stay the same
    assert.ok(same.length <= 10, `too many untranslated:\n${same.join('\n')}`);
});

const unused = Object.keys(bundle).filter((k) => !messages.has(k));
if (unused.length) console.log(`  (warning) ${unused.length} unused key(s) in the bundle: ${unused.slice(0, 5).map((k) => JSON.stringify(k)).join(", ")}`);

check('package.json %keys% exist in both nls files', () => {
    const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const keys = [...new Set([...pkg.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]))];
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
    const pt = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.pt-br.json'), 'utf8'));
    const missing = keys.filter((k) => !(k in en) || !(k in pt));
    assert.deepStrictEqual(missing, []);
    assert.ok(keys.length > 50);
});

check('no Portuguese left in the source code', () => {
    const PT = /[ãõçáéíóúâêôà]|\b(não|arquivo|compilação|pacote|servidor|jogador|você|também|então)\b/i;
    const hits = [];
    for (const file of walk(SRC)) {
        fs.readFileSync(file, 'utf8')
            .split('\n')
            .forEach((l, i) => PT.test(l) && hits.push(`${path.relative(ROOT, file)}:${i + 1}  ${l.trim().slice(0, 100)}`));
    }
    assert.deepStrictEqual(hits, []);
});

console.log(`\n${n} translation checks passed`);
