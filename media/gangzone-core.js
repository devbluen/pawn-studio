// GangZone Creator core: shapes, the rectangles SA-MP can actually draw, code generation and import.
// No DOM here (the tests load this module directly).
//
// SA-MP / open.mp gang zones are axis-aligned rectangles only. Circles and polygons are drawn as
// horizontal strips that do not overlap (overlapping strips would stack their transparency).
// The streamer plugin areas (CreateDynamicCircle / Rectangle / Polygon) follow the exact shape.

export const GANGZONE_LIMIT = 1024;
export const MAX_STRIPS = 128;

/** zone = { name, shape: 'rect'|'circle'|'poly', color: 'RRGGBB', alpha: 0..255, rect, circle, poly, strips } */
export function makeZone(shape, data, name, color = 'FF0000', alpha = 0x88) {
    const z = { name, shape, color, alpha, strips: 16 };
    if (shape === 'rect') z.rect = normRect(data);
    else if (shape === 'circle') z.circle = { x: data.x, y: data.y, r: Math.abs(data.r) };
    else z.poly = data.map(([x, y]) => [x, y]);
    return z;
}

export function normRect(r) {
    return { x1: Math.min(r.x1, r.x2), y1: Math.min(r.y1, r.y2), x2: Math.max(r.x1, r.x2), y2: Math.max(r.y1, r.y2) };
}

export function bounds(z) {
    if (z.shape === 'rect') return { ...z.rect };
    if (z.shape === 'circle') return { x1: z.circle.x - z.circle.r, y1: z.circle.y - z.circle.r, x2: z.circle.x + z.circle.r, y2: z.circle.y + z.circle.r };
    const xs = z.poly.map((p) => p[0]);
    const ys = z.poly.map((p) => p[1]);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

export function stripCount(z) {
    return Math.max(1, Math.min(MAX_STRIPS, Math.round(z.strips || 16)));
}

/** x ranges where the horizontal line y crosses the polygon (even-odd rule). */
function polyRanges(poly, y) {
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        if (ay <= y !== by <= y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) out.push([xs[i], xs[i + 1]]);
    return out;
}

/** The rectangles GangZoneCreate gets for a zone: [minx, miny, maxx, maxy][] */
export function gangRects(z) {
    if (z.shape === 'rect') {
        const r = normRect(z.rect);
        return r.x2 - r.x1 > 0 && r.y2 - r.y1 > 0 ? [[r.x1, r.y1, r.x2, r.y2]] : [];
    }
    const n = stripCount(z);
    const out = [];
    if (z.shape === 'circle') {
        const { x, y, r } = z.circle;
        if (r <= 0) return out;
        const h = (2 * r) / n;
        for (let k = 0; k < n; k++) {
            const y0 = y - r + k * h;
            const ym = y0 + h / 2;
            const half = Math.sqrt(Math.max(0, r * r - (ym - y) ** 2));
            if (half > 0) out.push([x - half, y0, x + half, y0 + h]);
        }
        return out;
    }
    if (z.poly.length < 3) return out;
    const b = bounds(z);
    const h = (b.y2 - b.y1) / n;
    if (h <= 0) return out;
    for (let k = 0; k < n; k++) {
        const y0 = b.y1 + k * h;
        for (const [xa, xb] of polyRanges(z.poly, y0 + h / 2)) out.push([xa, y0, xb, y0 + h]);
    }
    return out;
}

export function contains(z, x, y) {
    if (z.shape === 'rect') {
        const r = normRect(z.rect);
        return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
    }
    if (z.shape === 'circle') return (x - z.circle.x) ** 2 + (y - z.circle.y) ** 2 <= z.circle.r ** 2;
    return polyRanges(z.poly, y).some(([a, b]) => x >= a && x <= b);
}

/** Polygon area sign tells the drawing direction; streamer does not care, but self-crossing does. */
export function selfIntersects(poly) {
    const n = poly.length;
    const cross = (a, b, c, d) => {
        const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (cross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
    return false;
}

export function moveZone(z, dx, dy) {
    if (z.shape === 'rect') z.rect = { x1: z.rect.x1 + dx, y1: z.rect.y1 + dy, x2: z.rect.x2 + dx, y2: z.rect.y2 + dy };
    else if (z.shape === 'circle') z.circle = { ...z.circle, x: z.circle.x + dx, y: z.circle.y + dy };
    else z.poly = z.poly.map(([x, y]) => [x + dx, y + dy]);
}

// ───────────────────────── code ─────────────────────────

export const num = (v) => (Math.round(v * 100) / 100).toFixed(2);
const hex = (z) => `0x${z.color.toUpperCase()}${Math.max(0, Math.min(255, Math.round(z.alpha))).toString(16).toUpperCase().padStart(2, '0')}`;

/** A valid, unique Pawn identifier part for every zone. */
export function identifiers(zones) {
    const used = new Set();
    return zones.map((z, i) => {
        let id = String(z.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
        if (!id) id = `Zone${i + 1}`;
        if (/^\d/.test(id)) id = '_' + id;
        let u = id;
        for (let k = 2; used.has(u.toLowerCase()); k++) u = `${id}${k}`;
        used.add(u.toLowerCase());
        return u;
    });
}

/**
 * @param {object[]} zones
 * @param {{ gangzones?: boolean, streamer?: boolean, show?: 'player'|'all', callbacks?: boolean, labels?: object }} o
 */
export function generate(zones, o = {}) {
    const opt = { gangzones: true, streamer: false, show: 'player', callbacks: true, ...o };
    const T = { header: 'GangZone Creator', create: 'call in OnGameModeInit', show: 'call in OnPlayerSpawn (or OnPlayerConnect)', showAll: 'call after Zones_Create', enter: 'the player entered', ...(o.labels || {}) };
    if (!zones.length) return '';
    const ids = identifiers(zones);
    const rects = zones.map((z) => (opt.gangzones ? gangRects(z) : []));
    const total = rects.reduce((a, r) => a + r.length, 0);
    const L = [];
    L.push(`// ${T.header} — ${zones.length} zone(s)${opt.gangzones ? `, ${total} GangZoneCreate` : ''}`);
    // re-import data: the exact shapes, so the editor can open this code again
    zones.forEach((z, i) => {
        const head = `// zone: ${ids[i]} ${z.shape}`;
        if (z.shape === 'rect') L.push(`${head} ${num(z.rect.x1)} ${num(z.rect.y1)} ${num(z.rect.x2)} ${num(z.rect.y2)} ${hex(z)}`);
        else if (z.shape === 'circle') L.push(`${head} ${num(z.circle.x)} ${num(z.circle.y)} ${num(z.circle.r)} ${hex(z)} ${stripCount(z)}`);
        else {
            L.push(`${head} ${hex(z)} ${stripCount(z)}`);
            for (let k = 0; k < z.poly.length; k += 8) L.push(`// zone+ ${z.poly.slice(k, k + 8).map(([x, y]) => `${num(x)},${num(y)}`).join(' ')}`);
        }
    });
    if (opt.gangzones) {
        zones.forEach((z, i) => L.push(z.shape === 'rect' ? `new gz_${ids[i]};` : `new gz_${ids[i]}[${Math.max(1, rects[i].length)}];`));
    }
    if (opt.streamer) {
        L.push(`new ${ids.map((id) => `area_${id}`).join(', ')};`);
        zones.forEach((z, i) => {
            if (z.shape !== 'poly') return;
            const pts = z.poly.map(([x, y]) => `${num(x)}, ${num(y)}`);
            L.push(`new Float:area_${ids[i]}_points[] = {`);
            for (let k = 0; k < pts.length; k += 4) L.push(`    ${pts.slice(k, k + 4).join(', ')}${k + 4 < pts.length ? ',' : ''}`);
            L.push('};');
        });
    }
    L.push('');
    L.push(`stock Zones_Create() // ${T.create}`);
    L.push('{');
    if (opt.gangzones) {
        zones.forEach((z, i) => {
            if (z.shape === 'rect') {
                const r = rects[i][0] ?? [0, 0, 0, 0];
                L.push(`    gz_${ids[i]} = GangZoneCreate(${r.map(num).join(', ')});`);
            } else rects[i].forEach((r, k) => L.push(`    gz_${ids[i]}[${k}] = GangZoneCreate(${r.map(num).join(', ')});`));
        });
    }
    if (opt.streamer) {
        zones.forEach((z, i) => {
            const v = `area_${ids[i]}`;
            if (z.shape === 'rect') L.push(`    ${v} = CreateDynamicRectangle(${[z.rect.x1, z.rect.y1, z.rect.x2, z.rect.y2].map(num).join(', ')});`);
            else if (z.shape === 'circle') L.push(`    ${v} = CreateDynamicCircle(${num(z.circle.x)}, ${num(z.circle.y)}, ${num(z.circle.r)});`);
            else L.push(`    ${v} = CreateDynamicPolygon(${v}_points);`);
        });
    }
    L.push('}');
    if (opt.gangzones) {
        const all = opt.show === 'all';
        const call = (fn, target, z) => (all ? `GangZone${fn}ForAll(${target}${z ? `, ${hex(z)}` : ''})` : `GangZone${fn}ForPlayer(playerid, ${target}${z ? `, ${hex(z)}` : ''})`);
        const block = (name, fn, withColor) => {
            L.push('');
            L.push(`stock ${name}${all ? '()' : '(playerid)'}${fn === 'Show' ? ` // ${all ? T.showAll : T.show}` : ''}`);
            L.push('{');
            zones.forEach((z, i) => {
                const c = withColor ? z : null;
                if (z.shape === 'rect') L.push(`    ${call(fn, `gz_${ids[i]}`, c)};`);
                else L.push(`    for (new i; i < sizeof gz_${ids[i]}; i++) ${call(fn, `gz_${ids[i]}[i]`, c)};`);
            });
            L.push('}');
        };
        block(all ? 'Zones_ShowForAll' : 'Zones_Show', 'Show', true);
        block(all ? 'Zones_HideForAll' : 'Zones_Hide', 'Hide', false);
    }
    if (opt.streamer && opt.callbacks) {
        for (const [cb, label] of [['OnPlayerEnterDynamicArea', T.enter], ['OnPlayerLeaveDynamicArea', T.leave ?? 'the player left']]) {
            L.push('');
            L.push(`public ${cb}(playerid, areaid)`);
            L.push('{');
            zones.forEach((z, i) => {
                L.push(`    ${i ? 'else if' : 'if'} (areaid == area_${ids[i]})`);
                L.push('    {');
                L.push(`        // ${label}: ${z.name || ids[i]}`);
                L.push('    }');
            });
            L.push('    return 1;');
            L.push('}');
        }
    }
    return L.join('\n') + '\n';
}

// ───────────────────────── import ─────────────────────────

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const SEP = String.raw`\s*,\s*`;

/** Zones from Pawn code: the editor's own "// zone:" lines, or plain GangZoneCreate / CreateDynamic* calls. */
export function parseZones(text) {
    const zones = [];
    const metaRe = /^\s*\/\/\s*zone:\s*(\w+)\s+(rect|circle|poly)\s+(.*)$/gm;
    const lines = text.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
        metaRe.lastIndex = 0;
        const m = metaRe.exec(lines[li]);
        if (!m) continue;
        const [, name, shape, rest] = m;
        const parts = rest.trim().split(/\s+/);
        const colorOf = (s) => {
            const c = /^0x([0-9a-f]{6})([0-9a-f]{2})$/i.exec(s || '');
            return c ? { color: c[1].toUpperCase(), alpha: parseInt(c[2], 16) } : { color: 'FF0000', alpha: 0x88 };
        };
        if (shape === 'rect') {
            const [x1, y1, x2, y2] = parts.slice(0, 4).map(Number);
            const c = colorOf(parts[4]);
            zones.push(makeZone('rect', { x1, y1, x2, y2 }, name, c.color, c.alpha));
        } else if (shape === 'circle') {
            const [x, y, r] = parts.slice(0, 3).map(Number);
            const c = colorOf(parts[3]);
            const z = makeZone('circle', { x, y, r }, name, c.color, c.alpha);
            if (+parts[4]) z.strips = +parts[4];
            zones.push(z);
        } else {
            const c = colorOf(parts[0]);
            const pts = [];
            while (li + 1 < lines.length && /^\s*\/\/\s*zone\+/.test(lines[li + 1])) {
                li++;
                for (const pr of lines[li].replace(/^\s*\/\/\s*zone\+/, '').trim().split(/\s+/)) {
                    const [x, y] = pr.split(',').map(Number);
                    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
                }
            }
            if (pts.length >= 3) {
                const z = makeZone('poly', pts, name, c.color, c.alpha);
                if (+parts[1]) z.strips = +parts[1];
                zones.push(z);
            }
        }
    }
    if (zones.length) return zones;

    // plain calls: name = GangZoneCreate(minx, miny, maxx, maxy) …
    const byVar = new Map();
    const varName = (lhs) => (lhs || '').replace(/\[.*$/, '').trim();
    const nice = (v, i) => (v ? v.replace(/^(g_?)?(gz|zone|gangzone|area)_?/i, '') || v : `Zone${i + 1}`);
    const add = (v, z) => {
        zones.push(z);
        if (v) byVar.set(v, z);
    };
    const callRe = (fn, n) => new RegExp(String.raw`(?:([\w\[\]]+)\s*=\s*)?\b${fn}\s*\(\s*${Array(n).fill(NUM).join(SEP)}`, 'g');
    for (const m of text.matchAll(callRe('GangZoneCreate', 4))) {
        const [x1, y1, x2, y2] = m.slice(2, 6).map(Number);
        add(varName(m[1]), makeZone('rect', { x1, y1, x2, y2 }, nice(varName(m[1]), zones.length)));
    }
    const sameRect = (r) => zones.find((z) => z.shape === 'rect' && Math.abs(z.rect.x1 - r.x1) < 0.01 && Math.abs(z.rect.y1 - r.y1) < 0.01 && Math.abs(z.rect.x2 - r.x2) < 0.01 && Math.abs(z.rect.y2 - r.y2) < 0.01);
    for (const m of text.matchAll(callRe('CreateDynamicRectangle', 4))) {
        const [x1, y1, x2, y2] = m.slice(2, 6).map(Number);
        const r = normRect({ x1, y1, x2, y2 });
        if (!sameRect(r)) add(varName(m[1]), makeZone('rect', r, nice(varName(m[1]), zones.length)));
    }
    for (const m of text.matchAll(callRe('CreateDynamicCircle', 3))) {
        const [x, y, r] = m.slice(2, 5).map(Number);
        add(varName(m[1]), makeZone('circle', { x, y, r }, nice(varName(m[1]), zones.length)));
    }
    for (const m of text.matchAll(callRe('CreateDynamicCylinder', 5))) {
        const [x, y, , , r] = m.slice(2, 7).map(Number);
        add(varName(m[1]), makeZone('circle', { x, y, r }, nice(varName(m[1]), zones.length)));
    }
    for (const m of text.matchAll(/(?:([\w\[\]]+)\s*=\s*)?\bCreateDynamicPolygon\s*\(\s*(\w+)/g)) {
        const arr = new RegExp(String.raw`Float\s*:\s*${m[2]}\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}`).exec(text);
        if (!arr) continue;
        const v = arr[1].split(',').map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
        const pts = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
        if (pts.length >= 3) add(varName(m[1]), makeZone('poly', pts, nice(varName(m[1]) || m[2], zones.length)));
    }
    // colors from GangZoneShowForPlayer(playerid, zone, 0xRRGGBBAA) / GangZoneShowForAll(zone, 0x…)
    for (const m of text.matchAll(/GangZoneShowFor(?:Player\s*\(\s*\w+\s*,|All\s*\()\s*(\w+)(?:\[[^\]]*\])?\s*,\s*0x([0-9a-f]{6})([0-9a-f]{2})/gi)) {
        const z = byVar.get(m[1]);
        if (z) {
            z.color = m[2].toUpperCase();
            z.alpha = parseInt(m[3], 16);
        }
    }
    return zones;
}
