// GangZone Creator: draw rectangles, circles and polygons on the San Andreas map and get the Pawn code
// (GangZoneCreate strips for the radar, streamer areas for the exact shape).
import { MapView } from './map.js';
import { bounds, contains, GANGZONE_LIMIT, gangRects, generate, makeZone, MAX_STRIPS, moveZone, normRect, num, parseZones, selfIntersects } from './gangzone-core.js';

const vscode = acquireVsCodeApi();
const L = window.L10N;
const fmt = (s, ...a) => s.replace(/\{(\d+)\}/g, (_, i) => a[i]);
const $ = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
};

const PALETTE = ['FF0000', '00FF00', '0080FF', 'FFCC00', 'AA00FF', 'FF7F00', '00FFFF', 'FF00AA', 'FFFFFF', '000000'];
const saved = vscode.getState() ?? {};
const st = {
    zones: saved.zones ?? [],
    sel: saved.sel ?? -1,
    tool: 'select',
    snap: saved.snap ?? 0,
    opts: Object.assign({ gangzones: true, streamer: true, show: 'player', callbacks: false }, saved.opts),
    view: saved.view ?? null,
};
const save = () => vscode.setState({ zones: st.zones, sel: st.sel, snap: st.snap, opts: st.opts, view: map ? { cx: map.cx, cy: map.cy, scale: map.scale } : st.view });

let map = null;
let draft = null; // polygon being drawn: [[x, y], …]
let drag = null;
let hoverW = null;

const css = `
.gz-wrap { display:flex; height:100%; min-height:0; }
.gz-side { width: 360px; min-width: 300px; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px; border-right:1px solid var(--border); }
.gz-right { flex:1; display:flex; flex-direction:column; min-width:0; }
.gz-right .map-box { flex: 1; }
.gz-right .code { height: 34%; overflow:auto; border-radius:0; border-left:0; border-right:0; border-bottom:0; flex-shrink:0; white-space: pre; }
.gz-tools { display:flex; gap:4px; flex-wrap:wrap; }
.gz-tools button { padding: 3px 8px; }
.gz-tools button.active { outline: 2px solid var(--accent); outline-offset: -2px; }
.gz-hint { font-size:.88em; color: var(--muted); line-height:1.4; min-height: 2.6em; }
.gz-sec { display:flex; flex-direction:column; gap:6px; border-top: 1px solid var(--border); padding-top: 8px; }
.gz-sec h3 { margin:0; font-size: .95em; font-weight:600; display:flex; align-items:center; gap:6px; }
.gz-list .item { align-items:center; }
.gz-list .sw, .sw { width: 14px; height: 14px; border-radius: 3px; border: 1px solid #0008; flex:none; }
.gz-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.gz-grid label { display:flex; flex-direction:column; gap:2px; }
.gz-palette { display:flex; gap:4px; flex-wrap:wrap; align-items:center; }
.gz-palette .sw { cursor:pointer; width: 18px; height: 18px; }
.gz-warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size:.9em; }
.gz-side input[type=number] { width: 100%; }
.gz-side textarea { width: 100%; min-height: 90px; }
.gz-check { display:flex; gap:6px; align-items:flex-start; color: var(--vscode-foreground); font-size: .95em; }
.gz-check small { display:block; color: var(--muted); }
.toast { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); background: var(--vscode-notifications-background, #333); color: var(--vscode-notifications-foreground, #fff); border: 1px solid var(--border); padding: 6px 14px; border-radius: 4px; z-index: 10; }
`;

const app = document.getElementById('app');
document.head.append($('style', {}, css));
const side = $('div', { class: 'gz-side' });
const mapBox = $('div', { class: 'map-box' });
const codeEl = $('pre', { class: 'code' });
app.append($('div', { class: 'gz-wrap' }, side, $('div', { class: 'gz-right' }, mapBox, codeEl)));

function toast(text) {
    const t = $('div', { class: 'toast' }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 2200);
}

const snap = (v) => (st.snap > 0 ? Math.round(v / st.snap) * st.snap : Math.round(v * 100) / 100);
const snapW = (w) => [snap(w[0]), snap(w[1])];
const cur = () => st.zones[st.sel];
const nextColor = () => PALETTE[st.zones.length % PALETTE.length];
const SHAPE = { rect: () => L.shapeRect, circle: () => L.shapeCircle, poly: () => L.shapePoly };

// ───────────────────────── side panel ─────────────────────────

const toolBtns = {};
const hintEl = $('div', { class: 'gz-hint' });
const listEl = $('div', { class: 'list gz-list' });
const editEl = $('div', { class: 'col', style: 'gap:6px' });
const totalEl = $('div', { class: 'muted' });

function buildSide() {
    const tools = $('div', { class: 'gz-tools' });
    for (const [id, icon, label] of [['select', '⬚', L.toolSelect], ['rect', '▭', L.toolRect], ['circle', '◯', L.toolCircle], ['poly', '⬠', L.toolPoly], ['pan', '✋', L.toolPan]]) {
        toolBtns[id] = $('button', { class: 'secondary', title: label, onclick: () => setTool(id) }, `${icon} ${label}`);
        tools.append(toolBtns[id]);
    }
    const snapSel = $('select', { title: L.snap },
        ...[[0, L.snapFree], [1, '1'], [5, '5'], [10, '10'], [25, '25'], [50, '50']].map(([v, t]) => $('option', { value: v, selected: st.snap === v }, t)));
    snapSel.onchange = () => { st.snap = +snapSel.value; save(); };
    const goIn = $('input', { type: 'text', placeholder: 'x, y', style: 'width: 120px' });
    const go = () => {
        const n = goIn.value.split(/[\s,;]+/).map(parseFloat).filter(Number.isFinite);
        if (n.length >= 2) {
            map.centerOn(n[0], n[1], Math.min(map.scale, 1));
            map.setMarker([n[0], n[1]]);
        }
    };
    goIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

    const o = st.opts;
    const check = (key, label, hint) => {
        const c = $('input', { type: 'checkbox', checked: o[key] });
        c.onchange = () => { o[key] = c.checked; changed(false); };
        return $('label', { class: 'gz-check' }, c, $('span', {}, label, hint ? $('small', {}, hint) : null));
    };
    const showSel = $('select', {}, $('option', { value: 'player', selected: o.show === 'player' }, L.showPlayer), $('option', { value: 'all', selected: o.show === 'all' }, L.showAll));
    showSel.onchange = () => { o.show = showSel.value; changed(false); };

    const importBox = $('textarea', { placeholder: L.importHint, style: 'display:none' });
    const importBtn = $('button', { class: 'secondary', style: 'display:none', onclick: () => { doImport(importBox.value); importBox.value = ''; importBox.style.display = importBtn.style.display = 'none'; } }, L.importBtn);

    side.append(
        $('div', { class: 'col' }, tools, hintEl),
        $('div', { class: 'row wrap' }, $('label', {}, L.snap), snapSel, $('label', {}, L.goTo), goIn, $('button', { class: 'secondary', onclick: go }, '→')),
        $('div', { class: 'gz-sec' }, $('h3', {}, L.zones), listEl),
        editEl,
        $('div', { class: 'gz-sec' },
            $('h3', {}, L.output),
            check('gangzones', L.outGangzones, L.outGangzonesHint),
            $('div', { class: 'row', style: 'padding-left: 22px' }, showSel),
            check('streamer', L.outStreamer, L.outStreamerHint),
            $('div', { style: 'padding-left: 22px' }, check('callbacks', L.callbacks)),
            totalEl,
            $('div', { class: 'actions' },
                $('button', { onclick: () => st.zones.length && vscode.postMessage({ type: 'insert', code: code() }) }, L.insert),
                $('button', { class: 'secondary', onclick: () => st.zones.length && vscode.postMessage({ type: 'copy', text: code() }) }, L.copy),
                $('button', { class: 'secondary', onclick: () => { const v = importBox.style.display === 'none'; importBox.style.display = importBtn.style.display = v ? '' : 'none'; if (v) importBox.focus(); } }, L.importCode)),
            importBox, importBtn,
            $('div', { class: 'note' }, L.stripsNote)));
}

function setTool(t) {
    if (draft && t !== 'poly') draft = null;
    st.tool = t;
    for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle('active', id === t);
    hintEl.textContent = { select: L.hintSelect, rect: L.hintRect, circle: L.hintCircle, poly: L.hintPoly, pan: L.hintPan }[t];
    map?.setTool(t === 'pan' ? 'pan' : t === 'select' ? 'drag-pans' : 'draw');
    map?.draw();
}

function renderList() {
    listEl.textContent = '';
    if (!st.zones.length) listEl.append($('div', { class: 'muted', style: 'padding: 6px 2px' }, L.noZones));
    st.zones.forEach((z, i) => {
        const n = gangRects(z).length;
        listEl.append($('div', { class: 'item' + (i === st.sel ? ' selected' : ''), onclick: () => select(i, true) },
            $('span', { class: 'sw', style: `background:#${z.color}` }),
            $('span', { class: 'name' }, z.name),
            $('span', { class: 'tag' }, `${SHAPE[z.shape]()} · ${fmt(L.gangzonesCount, n)}`)));
    });
}

function field(label, value, onInput, attrs = {}) {
    const i = $('input', { type: 'number', step: 'any', value, ...attrs });
    i.addEventListener('input', () => {
        const v = parseFloat(i.value);
        if (Number.isFinite(v)) onInput(v);
    });
    return $('label', {}, label, i);
}

function renderEdit() {
    editEl.textContent = '';
    const z = cur();
    if (!z) return;
    const name = $('input', { type: 'text', value: z.name });
    name.addEventListener('input', () => { z.name = name.value; changed(true, false); });
    const color = $('input', { type: 'color', value: `#${z.color}`, style: 'width: 40px; height: 24px; padding: 0' });
    color.addEventListener('input', () => { z.color = color.value.slice(1).toUpperCase(); changed(true, false); hexEl.textContent = hexOf(z); });
    const alpha = $('input', { type: 'range', min: 0, max: 255, value: z.alpha, style: 'flex: 1' });
    alpha.addEventListener('input', () => { z.alpha = +alpha.value; changed(true, false); hexEl.textContent = hexOf(z); });
    const hexOf = (q) => `0x${q.color}${q.alpha.toString(16).toUpperCase().padStart(2, '0')}`;
    const hexEl = $('code', {}, hexOf(z));
    const pal = $('div', { class: 'gz-palette' }, ...PALETTE.map((c) => $('span', { class: 'sw', title: `#${c}`, style: `background:#${c}`, onclick: () => { z.color = c; color.value = `#${c}`; hexEl.textContent = hexOf(z); changed(true, false); } })));

    const shape = $('div', { class: 'gz-grid' });
    if (z.shape === 'rect') {
        const r = z.rect;
        shape.append(
            field(L.minX, num(r.x1), (v) => { z.rect.x1 = v; changed(true, false); }),
            field(L.minY, num(r.y1), (v) => { z.rect.y1 = v; changed(true, false); }),
            field(L.maxX, num(r.x2), (v) => { z.rect.x2 = v; changed(true, false); }),
            field(L.maxY, num(r.y2), (v) => { z.rect.y2 = v; changed(true, false); }));
    } else if (z.shape === 'circle') {
        shape.append(
            field(L.centerX, num(z.circle.x), (v) => { z.circle.x = v; changed(true, false); }),
            field(L.centerY, num(z.circle.y), (v) => { z.circle.y = v; changed(true, false); }),
            field(L.radius, num(z.circle.r), (v) => { z.circle.r = Math.abs(v); changed(true, false); }, { min: 0 }));
    }
    let pts = null;
    if (z.shape === 'poly') {
        pts = $('textarea', { title: L.pointsHint }, z.poly.map(([x, y]) => `${num(x)}, ${num(y)}`).join('\n'));
        pts.addEventListener('input', () => {
            const p = pts.value.split(/\n/).map((l) => l.split(/[\s,;]+/).map(parseFloat).filter(Number.isFinite)).filter((a) => a.length >= 2).map((a) => [a[0], a[1]]);
            if (p.length >= 3) { z.poly = p; changed(true, false); }
        });
    }
    let strips = null;
    if (z.shape !== 'rect') {
        const n = $('input', { type: 'number', min: 1, max: MAX_STRIPS, value: z.strips, style: 'width: 70px' });
        const r = $('input', { type: 'range', min: 2, max: 64, value: Math.min(64, z.strips), style: 'flex:1' });
        const set = (v) => { z.strips = Math.max(1, Math.min(MAX_STRIPS, Math.round(v) || 1)); changed(true, false); stripsInfo.textContent = fmt(L.gangzonesCount, gangRects(z).length); };
        n.addEventListener('input', () => { set(+n.value); r.value = Math.min(64, z.strips); });
        r.addEventListener('input', () => { set(+r.value); n.value = z.strips; });
        const stripsInfo = $('span', { class: 'muted' }, fmt(L.gangzonesCount, gangRects(z).length));
        strips = $('div', { class: 'col' }, $('label', { title: L.stripsHint }, L.strips), $('div', { class: 'row' }, r, n), stripsInfo);
    }
    const warn = z.shape === 'poly' && selfIntersects(z.poly) ? $('div', { class: 'gz-warn' }, L.selfCross) : null;
    editEl.append($('div', { class: 'gz-sec' },
        $('h3', {}, $('span', { class: 'sw', style: `background:#${z.color}` }), `${SHAPE[z.shape]()}`),
        $('label', {}, L.name, name),
        $('div', { class: 'row' }, $('label', {}, L.color), color, pal),
        $('div', { class: 'row' }, $('label', {}, L.opacity), alpha, hexEl),
        shape,
        pts ? $('label', {}, L.points, pts) : null,
        warn,
        strips,
        $('div', { class: 'actions' },
            $('button', { class: 'secondary', onclick: () => fitZone(z) }, `⤢ ${L.focus}`),
            $('button', { class: 'secondary', onclick: duplicate }, L.duplicate),
            $('button', { class: 'secondary', onclick: remove }, L.del))));
}

// ───────────────────────── state changes ─────────────────────────

function code() {
    return generate(st.zones, { ...st.opts, labels: { header: 'GangZone Creator', create: L.cCreate, show: L.cShow, showAll: L.cShowAll, enter: L.cEnter, leave: L.cLeave } });
}

/** Something changed: redraw, regenerate; rebuild the editor fields only when asked (not while typing in them). */
function changed(list = true, edit = true) {
    if (list) renderList();
    if (edit) renderEdit();
    const total = st.opts.gangzones ? st.zones.reduce((a, z) => a + gangRects(z).length, 0) : 0;
    totalEl.textContent = '';
    totalEl.append(st.opts.gangzones ? fmt(L.total, total, GANGZONE_LIMIT) : '');
    if (total > GANGZONE_LIMIT) totalEl.append($('div', { class: 'gz-warn' }, L.overLimit));
    codeEl.textContent = st.zones.length ? code() : L.codeEmpty;
    map?.draw();
    save();
}

function select(i, fit = false) {
    st.sel = i;
    changed();
    if (fit && cur()) {
        const b = bounds(cur());
        const [sx1, sy1] = map.toScreen(b.x1, b.y2);
        const [sx2, sy2] = map.toScreen(b.x2, b.y1);
        if (sx2 < 0 || sy2 < 0 || sx1 > map.w || sy1 > map.h) fitZone(cur());
    }
}

function fitZone(z) {
    map.fit(bounds(z));
}

function addZone(z) {
    st.zones.push(z);
    st.sel = st.zones.length - 1;
    setTool('select');
    changed();
}

function duplicate() {
    const z = cur();
    if (!z) return;
    const c = JSON.parse(JSON.stringify(z));
    c.name = `${z.name} 2`;
    const b = bounds(z);
    moveZone(c, (b.x2 - b.x1) * 0.15 + 10, -((b.y2 - b.y1) * 0.15 + 10));
    addZone(c);
}

function remove() {
    if (st.sel < 0) return;
    st.zones.splice(st.sel, 1);
    st.sel = Math.min(st.sel, st.zones.length - 1);
    changed();
}

function doImport(text) {
    const zones = parseZones(text || '');
    if (!zones.length) return toast(L.nothingImported);
    st.zones.push(...zones);
    st.sel = st.zones.length - zones.length;
    changed();
    const b = zones.map(bounds).reduce((a, q) => ({ x1: Math.min(a.x1, q.x1), y1: Math.min(a.y1, q.y1), x2: Math.max(a.x2, q.x2), y2: Math.max(a.y2, q.y2) }));
    map.fit(b);
    toast(fmt(L.imported, zones.length));
}

// ───────────────────────── map interaction ─────────────────────────

/** Handles of the selected zone in world units: [{ kind, i, x, y }] */
function handles(z) {
    if (!z) return [];
    if (z.shape === 'rect') {
        const r = normRect(z.rect);
        return [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]].map(([x, y], i) => ({ kind: 'corner', i, x, y }));
    }
    if (z.shape === 'circle') return [{ kind: 'radius', i: 0, x: z.circle.x + z.circle.r, y: z.circle.y }];
    const out = z.poly.map(([x, y], i) => ({ kind: 'vertex', i, x, y }));
    z.poly.forEach(([x, y], i) => {
        const [nx, ny] = z.poly[(i + 1) % z.poly.length];
        out.push({ kind: 'mid', i, x: (x + nx) / 2, y: (y + ny) / 2 });
    });
    return out;
}

function hitHandle(w) {
    const r = 8 * map.scale;
    let best = null;
    let bd = r * r;
    for (const h of handles(cur())) {
        const d = (h.x - w[0]) ** 2 + (h.y - w[1]) ** 2;
        if (d <= bd && (!best || h.kind !== 'mid' || best.kind === 'mid')) { bd = d; best = h; }
    }
    return best;
}

function hitZone(w) {
    // the selected zone wins, then the top-most (last drawn)
    if (cur() && contains(cur(), w[0], w[1])) return st.sel;
    for (let i = st.zones.length - 1; i >= 0; i--) if (contains(st.zones[i], w[0], w[1])) return i;
    return -1;
}

const interact = {
    down(w, e) {
        const p = snapW(w);
        if (st.tool === 'select') {
            const h = hitHandle(w);
            if (h) {
                const z = cur();
                if (h.kind === 'vertex' && e.altKey && z.poly.length > 3) {
                    z.poly.splice(h.i, 1);
                    changed();
                    return true;
                }
                if (h.kind === 'mid') {
                    z.poly.splice(h.i + 1, 0, p);
                    drag = { kind: 'vertex', i: h.i + 1 };
                } else drag = { kind: h.kind, i: h.i };
                return true;
            }
            const i = hitZone(w);
            if (i < 0) {
                if (st.sel >= 0) { st.sel = -1; changed(); }
                return false; // empty space: the map pans
            }
            if (i !== st.sel) select(i);
            drag = { kind: 'move', last: p, moved: false };
            return true;
        }
        if (st.tool === 'rect' || st.tool === 'circle') {
            drag = { kind: 'new', start: p, end: p };
            return true;
        }
        if (st.tool === 'poly') {
            if (!draft) draft = [];
            const first = draft[0];
            if (draft.length >= 3 && first && (first[0] - w[0]) ** 2 + (first[1] - w[1]) ** 2 <= (9 * map.scale) ** 2) finishPoly();
            else draft.push(p);
            map.draw();
            return true;
        }
        return false;
    },
    move(w) {
        hoverW = w;
        if (!drag) return;
        const p = snapW(w);
        const z = cur();
        if (drag.kind === 'new') drag.end = p;
        else if (drag.kind === 'move') {
            const dx = p[0] - drag.last[0];
            const dy = p[1] - drag.last[1];
            if (dx || dy) { moveZone(z, dx, dy); drag.last = p; drag.moved = true; liveUpdate(); }
        } else if (drag.kind === 'corner') {
            const r = normRect(z.rect);
            const xs = drag.i === 0 || drag.i === 3 ? 'x1' : 'x2';
            const ys = drag.i === 0 || drag.i === 1 ? 'y1' : 'y2';
            r[xs] = p[0];
            r[ys] = p[1];
            z.rect = r;
            // keep dragging the same visual corner when it crosses the opposite side
            if (r.x1 > r.x2) drag.i = { 0: 1, 1: 0, 2: 3, 3: 2 }[drag.i];
            if (r.y1 > r.y2) drag.i = { 0: 3, 3: 0, 1: 2, 2: 1 }[drag.i];
            z.rect = normRect(r);
            liveUpdate();
        } else if (drag.kind === 'radius') {
            z.circle.r = Math.max(1, snap(Math.hypot(w[0] - z.circle.x, w[1] - z.circle.y)));
            liveUpdate();
        } else if (drag.kind === 'vertex') {
            z.poly[drag.i] = p;
            liveUpdate();
        }
    },
    up() {
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.kind === 'new') {
            const [x1, y1] = d.start;
            const [x2, y2] = d.end;
            const name = `${L.zoneDefault} ${st.zones.length + 1}`;
            if (st.tool === 'rect' && Math.abs(x2 - x1) >= 2 && Math.abs(y2 - y1) >= 2) addZone(makeZone('rect', { x1, y1, x2, y2 }, name, nextColor()));
            else if (st.tool === 'circle' && Math.hypot(x2 - x1, y2 - y1) >= 2) addZone(makeZone('circle', { x: x1, y: y1, r: snap(Math.hypot(x2 - x1, y2 - y1)) }, name, nextColor()));
            map.draw();
            return;
        }
        changed();
    },
    dblclick() {
        if (st.tool === 'poly') {
            // the two clicks of the double click added the same point twice
            if (draft && draft.length > 1) {
                const a = draft[draft.length - 1];
                const b = draft[draft.length - 2];
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4 * map.scale) draft.pop();
            }
            finishPoly();
            return true;
        }
        return st.tool !== 'select' || hitZone(hoverW ?? [0, 0]) >= 0;
    },
    hover(w) {
        hoverW = w;
        if (st.tool === 'select') {
            const h = hitHandle(w);
            map.setCursor(h ? (h.kind === 'mid' ? 'copy' : 'pointer') : hitZone(w) >= 0 ? 'move' : 'grab');
        }
        if (draft) map.draw();
    },
};

/** While dragging: redraw the map and the code, but not the side fields (cheap enough at 60 fps). */
let liveTimer = 0;
function liveUpdate() {
    map.draw();
    if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = 0; codeEl.textContent = code(); renderList(); }, 80);
}

function finishPoly() {
    if (draft && draft.length >= 3) addZone(makeZone('poly', draft, `${L.zoneDefault} ${st.zones.length + 1}`, nextColor()));
    draft = null;
    map.draw();
}

function rgba(z, a) {
    const n = parseInt(z.color, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function pathOf(ctx, z, view) {
    ctx.beginPath();
    if (z.shape === 'rect') {
        const r = normRect(z.rect);
        const [x1, y1] = view.toScreen(r.x1, r.y2);
        const [x2, y2] = view.toScreen(r.x2, r.y1);
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
    } else if (z.shape === 'circle') {
        const [cx, cy] = view.toScreen(z.circle.x, z.circle.y);
        ctx.arc(cx, cy, z.circle.r / view.scale, 0, Math.PI * 2);
    } else {
        z.poly.forEach(([x, y], i) => {
            const [sx, sy] = view.toScreen(x, y);
            if (i) ctx.lineTo(sx, sy);
            else ctx.moveTo(sx, sy);
        });
        ctx.closePath();
    }
}

function overlay(ctx, view) {
    st.zones.forEach((z, i) => {
        const selected = i === st.sel;
        // what the radar shows: the GangZoneCreate rectangles in the zone color/alpha
        ctx.fillStyle = rgba(z, Math.max(0.08, z.alpha / 255));
        if (st.opts.gangzones) {
            for (const [x1, y1, x2, y2] of gangRects(z)) {
                const [a, b] = view.toScreen(x1, y2);
                const [c, d] = view.toScreen(x2, y1);
                ctx.fillRect(a, b, c - a, d - b);
            }
        } else {
            pathOf(ctx, z, view);
            ctx.fill();
        }
        // the exact shape (= the streamer area)
        pathOf(ctx, z, view);
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.strokeStyle = selected ? '#ffffff' : rgba(z, 1);
        ctx.setLineDash(st.opts.streamer && z.shape !== 'rect' ? [6, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        const b = bounds(z);
        const [lx, ly] = view.toScreen((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
        if ((b.x2 - b.x1) / view.scale > 40) {
            ctx.font = '600 12px var(--vscode-font-family, sans-serif)';
            ctx.textAlign = 'center';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0,0,0,.7)';
            ctx.strokeText(z.name, lx, ly);
            ctx.fillStyle = '#fff';
            ctx.fillText(z.name, lx, ly);
            ctx.textAlign = 'start';
        }
    });
    // handles of the selected zone
    if (st.tool === 'select') {
        for (const h of handles(cur())) {
            const [sx, sy] = view.toScreen(h.x, h.y);
            ctx.beginPath();
            ctx.arc(sx, sy, h.kind === 'mid' ? 3.5 : 5, 0, Math.PI * 2);
            ctx.fillStyle = h.kind === 'mid' ? 'rgba(255,255,255,.5)' : '#fff';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#000';
            ctx.stroke();
        }
    }
    // shape being drawn
    const ghost = (z) => {
        pathOf(ctx, z, view);
        ctx.fillStyle = 'rgba(255,255,255,.15)';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
    };
    if (drag?.kind === 'new') {
        const [x1, y1] = drag.start;
        const [x2, y2] = drag.end;
        if (st.tool === 'rect') ghost(makeZone('rect', { x1, y1, x2, y2 }, ''));
        else ghost(makeZone('circle', { x: x1, y: y1, r: Math.hypot(x2 - x1, y2 - y1) }, ''));
        const label = st.tool === 'rect' ? `${num(Math.abs(x2 - x1))} × ${num(Math.abs(y2 - y1))}` : `r = ${num(Math.hypot(x2 - x1, y2 - y1))}`;
        const [sx, sy] = view.toScreen(x2, y2);
        ctx.font = '12px var(--vscode-editor-font-family, monospace)';
        ctx.fillStyle = 'rgba(0,0,0,.65)';
        ctx.fillRect(sx + 10, sy + 6, ctx.measureText(label).width + 10, 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, sx + 15, sy + 19);
    }
    if (draft?.length) {
        ctx.beginPath();
        draft.forEach(([x, y], i) => {
            const [sx, sy] = view.toScreen(x, y);
            if (i) ctx.lineTo(sx, sy);
            else ctx.moveTo(sx, sy);
        });
        if (hoverW) {
            const [hx, hy] = view.toScreen(...snapW(hoverW));
            ctx.lineTo(hx, hy);
        }
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        draft.forEach(([x, y], i) => {
            const [sx, sy] = view.toScreen(x, y);
            ctx.beginPath();
            ctx.arc(sx, sy, i === 0 && draft.length >= 3 ? 7 : 4, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? '#ffc800' : '#fff';
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.stroke();
        });
    }
}

document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) return;
    if (e.key === 'Escape') {
        if (draft) draft = null;
        else if (st.tool !== 'select') setTool('select');
        else { st.sel = -1; changed(); }
        map.draw();
    } else if (e.key === 'Enter' && draft) finishPoly();
    else if (e.key === 'Backspace' && draft) { draft.pop(); map.draw(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel >= 0) remove();
    else if (e.key === 'd' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicate(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = { v: 'select', r: 'rect', c: 'circle', p: 'poly', h: 'pan' }[e.key.toLowerCase()];
        if (t) setTool(t);
    }
});

// ───────────────────────── start ─────────────────────────

window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
        mapBox.textContent = '';
        map = new MapView(mapBox, m.map, { tool: 'drag-pans', interact, overlay });
        if (st.view) {
            map.centerOn(st.view.cx, st.view.cy, st.view.scale);
            map.fitted = true; // keep it when the map image finishes loading
        }
        mapBox.append($('div', { class: 'hud' }, L.mapHint));
        if (!m.map) mapBox.append($('div', { class: 'map-tools' }, $('span', { class: 'muted', style: 'background: rgba(0,0,0,.55); color: #fff; padding: 2px 8px; border-radius: 3px' }, L.noMap), $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'pickGta' }) }, L.pickGta)));
        // remember where the user was looking
        let t = 0;
        mapBox.addEventListener('pointerup', () => { clearTimeout(t); t = setTimeout(save, 300); });
        mapBox.addEventListener('wheel', () => { clearTimeout(t); t = setTimeout(save, 300); }, { passive: true });
        setTool('select');
        changed();
        if (m.import) doImport(m.import);
    } else if (m.type === 'import') doImport(m.text);
});

buildSide();
mapBox.append($('div', { class: 'msg' }, L.loading));
changed();
vscode.postMessage({ type: 'init' });
