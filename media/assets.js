// Asset browser UI: objects (3D), sprites, animations (3D ped) and sounds.
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
const PAGE = 300;
const saved = vscode.getState() ?? {};
const state = {
    tab: saved.tab ?? 'objects',
    q: saved.q ?? { objects: '', sprites: '', animations: '', sounds: '' },
    group: saved.group ?? '',
    skin: saved.skin ?? 7,
    loop: saved.loop ?? true,
    inPlace: saved.inPlace ?? true,
    speed: saved.speed ?? 1,
    openLibs: saved.openLibs ?? [],
    objFilter: Object.assign({ source: '', type: '', placed: '', sort: 'id', ddMin: '', ddMax: '' }, saved.objFilter),
    objMode: saved.objMode ?? 'list',
    objMoreOpen: saved.objMoreOpen ?? false,
    area: saved.area ?? null,
    resultsFocus: saved.resultsFocus ?? null,
    openBanks: saved.openBanks ?? [],
    soundMode: saved.soundMode ?? 'ids',
    soundKind: saved.soundKind ?? '',
    volume: saved.volume ?? 0.8,
    data: {},
    selected: {},
};
// everything except the loaded data and the current selection survives the panel being hidden
const save = () => {
    const { data, selected, ...keep } = state;
    void data;
    void selected;
    vscode.setState(keep);
};

const pending = new Map();
function request(type, extra = {}) {
    return new Promise((resolve, reject) => {
        const key = type + JSON.stringify(extra);
        pending.set(key, { resolve, reject, type });
        vscode.postMessage({ type, ...extra });
    });
}
function settle(msg, keyExtra) {
    for (const [k, p] of pending) {
        if (p.type === msg.type && (keyExtra === undefined || k === msg.type + JSON.stringify(keyExtra))) {
            pending.delete(k);
            p.resolve(msg);
            return;
        }
    }
}

let viewer = null;
async function getViewer(container) {
    if (!viewer) {
        const { Viewer } = await import('./viewer.js');
        viewer = new Viewer(container);
    } else if (viewer.container !== container) {
        container.appendChild(viewer.renderer.domElement);
        viewer.container = container;
        viewer.resize();
        new ResizeObserver(() => viewer.resize()).observe(container);
    }
    return viewer;
}

const app = document.getElementById('app');
let gtaDir = null;

function shell() {
    app.textContent = '';
    const tabs = $('div', { class: 'tabs' });
    for (const [id, label] of [['objects', L.objects], ['sprites', L.sprites], ['animations', L.animations], ['sounds', L.sounds]]) {
        tabs.append($('div', { class: 'tab' + (state.tab === id ? ' active' : ''), onclick: () => switchTab(id) }, label));
    }
    tabs.append($('div', { class: 'spacer' }), $('div', { class: 'src', title: gtaDir }, fmt(L.gtaFrom, gtaDir)),
        $('button', { class: 'secondary src-btn', title: L.changeGta, onclick: () => vscode.postMessage({ type: 'pickGta' }) }, `📁 ${L.changeGta}`));
    const body = $('div', { class: 'split', id: 'body' });
    app.append(tabs, body);
    return body;
}

function switchTab(tab) {
    state.tab = tab;
    save();
    render();
}

function noGta(error) {
    app.textContent = '';
    app.append($('div', { class: 'empty' }, $('p', {}, L.noGta), error ? $('p', { class: 'muted' }, error) : null, $('button', { onclick: () => vscode.postMessage({ type: 'pickGta' }) }, L.pickGta)));
}

function insert(code, snippet = true) {
    vscode.postMessage({ type: 'insert', code, snippet });
}
function copy(text) {
    vscode.postMessage({ type: 'copy', text });
}
function codeBlock(code, display) {
    return $('pre', { class: 'code' }, display ?? code.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}|\$0/g, ''));
}
function sideList({ placeholder, query, onQuery, extra, count }) {
    const side = $('div', { class: 'side' });
    const input = $('input', { type: 'text', placeholder, value: query });
    let timer;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => onQuery(input.value), 120);
    });
    const filters = $('div', { class: 'filters' }, input, extra ?? null, count);
    const list = $('div', { class: 'list' });
    side.append(filters, list);
    setTimeout(() => input.focus(), 0);
    return { side, list, input };
}
const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (hay, ws) => ws.every((w) => hay.includes(w));

// ───────────────────────── objects ─────────────────────────

async function renderObjects(body) {
    if (!state.data.objects) {
        body.append($('div', { class: 'empty' }, L.loading));
        state.data.objects = (await request('objects')).items;
        if (state.tab !== 'objects') return;
        body.textContent = '';
    }
    // o = [id, model, txd, group, drawDist, archive, section, placed, lodPlaced]
    const items = state.data.objects;
    const F = state.objFilter;
    const groups = [...new Set(items.map((o) => o[3]))].sort();
    const count = $('div', { class: 'count' });
    const opt = (v, label, cur) => $('option', { value: v, selected: v === cur }, label);
    const select = $('select', { title: L.group }, opt('', L.allGroups, state.group), ...groups.map((g) => opt(g, g, state.group)));
    const source = $('select', { title: L.fSource }, opt('', L.fSourceAll, F.source), opt('gta', 'GTA San Andreas', F.source), opt('samp', 'SA-MP', F.source));
    const type = $('select', { title: L.fType }, opt('', L.fTypeAll, F.type), opt('objs', L.fTypeStatic, F.type), opt('tobj', L.fTypeTimed, F.type), opt('anim', L.fTypeAnim, F.type));
    const placed = $('select', { title: L.fPlaced },
        opt('', L.fPlacedAll, F.placed), opt('yes', L.fPlacedYes, F.placed), opt('no', L.fPlacedNo, F.placed),
        opt('nolod', L.fNoLod, F.placed), opt('lod', L.fOnlyLod, F.placed));
    const sort = $('select', { title: L.fSort }, opt('id', L.fSortId, F.sort), opt('name', L.fSortName, F.sort), opt('placed', L.fSortPlaced, F.sort), opt('dd', L.fSortDd, F.sort));
    const ddMin = $('input', { type: 'number', min: 0, placeholder: 'min', value: F.ddMin, style: 'width:64px', title: L.fDrawDist });
    const ddMax = $('input', { type: 'number', min: 0, placeholder: 'max', value: F.ddMax, style: 'width:64px', title: L.fDrawDist });
    const areaBtn = $('button', { class: state.objMode === 'area' ? '' : 'secondary', title: L.areaHint }, state.objMode === 'area' ? `✕ ${L.areaClose}` : `🗺 ${L.areaOpen}`);
    const resultsBtn = $('button', { class: state.objMode === 'results' ? '' : 'secondary', title: L.resultsHint }, state.objMode === 'results' ? `✕ ${L.areaClose}` : `📍 ${L.resultsOpen}`);
    const more = $('details', { class: 'filters-more', open: state.objMoreOpen },
        $('summary', {}, L.moreFilters),
        $('div', { class: 'col', style: 'gap:6px;margin-top:6px' },
            $('div', { class: 'row' }, source, type),
            $('div', { class: 'row' }, placed, sort),
            $('div', { class: 'row' }, $('span', { class: 'muted' }, L.fDrawDist), ddMin, '–', ddMax)));
    more.addEventListener('toggle', () => { state.objMoreOpen = more.open; save(); });
    const { side, list } = sideList({
        placeholder: L.search,
        query: state.q.objects,
        onQuery: (q) => { state.q.objects = q; save(); fill(); },
        extra: $('div', { class: 'col', style: 'gap:6px' }, select, $('div', { class: 'row' }, resultsBtn, areaBtn), more),
        count,
    });
    const onFilter = () => {
        state.group = select.value;
        Object.assign(F, { source: source.value, type: type.value, placed: placed.value, sort: sort.value, ddMin: ddMin.value, ddMax: ddMax.value });
        save();
        fill();
        if (state.objMode !== 'list') area?.refresh();
    };
    for (const el of [select, source, type, placed, sort]) el.addEventListener('change', onFilter);
    for (const el of [ddMin, ddMax]) el.addEventListener('input', onFilter);
    areaBtn.addEventListener('click', () => { state.objMode = state.objMode === 'area' ? 'list' : 'area'; save(); render(); });
    resultsBtn.addEventListener('click', () => { state.objMode = state.objMode === 'results' ? 'list' : 'results'; save(); render(); });
    const detail = $('div', { class: 'detail' });
    body.append(side, detail);
    let shown = PAGE;

    function passes(o) {
        if (state.group && o[3] !== state.group) return false;
        if (F.source && o[5] !== F.source) return false;
        if (F.type && o[6] !== F.type) return false;
        if (F.placed === 'yes' && !o[7]) return false;
        if (F.placed === 'no' && o[7]) return false;
        if (F.placed === 'nolod' && (o[8] > 0 || /^lod/i.test(o[1]))) return false;
        if (F.placed === 'lod' && !(o[8] > 0 || /^lod/i.test(o[1]))) return false;
        if (F.ddMin !== '' && o[4] < +F.ddMin) return false;
        if (F.ddMax !== '' && o[4] > +F.ddMax) return false;
        return true;
    }
    function filtered(extra) {
        const ws = words(state.q.objects);
        const f = items.filter((o) => passes(o) && (!ws.length || matches(`${o[0]} ${o[1]} ${o[2]}`.toLowerCase(), ws)) && (!extra || extra(o)));
        if (F.sort === 'name') f.sort((a, b) => a[1].localeCompare(b[1]));
        else if (F.sort === 'placed') f.sort((a, b) => b[7] - a[7] || a[0] - b[0]);
        else if (F.sort === 'dd') f.sort((a, b) => b[4] - a[4] || a[0] - b[0]);
        return f;
    }
    function row(o, tag, onclick) {
        const el = $('div', { class: 'item' + (state.selected.object === o[0] ? ' selected' : ''), title: `${o[1]} · ${o[2]}.txd · ${o[3]}`, onclick: () => onclick(o, el) },
            $('span', { class: 'id' }, o[0]), $('span', { class: 'name' }, o[1]), $('span', { class: 'tag' }, tag));
        return el;
    }
    function fill(keep = false) {
        if (state.objMode !== 'list') return area?.refresh();
        if (!keep) shown = PAGE;
        const f = filtered();
        // exact ID first
        const exact = /^\d+$/.test(state.q.objects.trim()) ? f.findIndex((o) => o[0] === +state.q.objects.trim()) : -1;
        if (exact > 0) f.unshift(...f.splice(exact, 1));
        count.textContent = fmt(L.results, f.length);
        list.textContent = '';
        for (const o of f.slice(0, shown)) list.append(row(o, F.sort === 'placed' ? `×${o[7]}` : F.sort === 'dd' ? `${o[4]}m` : o[3], select_));
        if (f.length > shown) list.append($('button', { class: 'more secondary', onclick: () => { shown += PAGE; fill(true); } }, L.showMore));
    }
    function select_(o, el) {
        state.selected.object = o[0];
        list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
        el?.classList.add('selected');
        showObject(detail, o);
    }

    let area = null;
    if (state.objMode === 'area') {
        area = await areaMode(detail, list, count, filtered, row);
        return;
    }
    if (state.objMode === 'results') {
        area = await resultsMode(detail, list, count, filtered, row);
        return;
    }
    fill();
    const sel = items.find((o) => o[0] === state.selected.object);
    if (sel) showObject(detail, sel);
    else detail.append($('div', { class: 'empty' }, L.pickItem));
}

/** Placements, unpacked once: ids, xyz, flags + index by model. */
async function placements() {
    if (!state.data.pl) {
        const r = await request('placements');
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
        const pl = { count: r.count, ids: new Int32Array(bytes(r.ids)), xyz: new Float32Array(bytes(r.xyz)), rot: new Float32Array(bytes(r.rot)), flags: new Uint8Array(bytes(r.flags)), byModel: new Map() };
        for (let i = 0; i < pl.count; i++) {
            const id = pl.ids[i];
            let a = pl.byModel.get(id);
            if (!a) pl.byModel.set(id, (a = []));
            a.push(i);
        }
        state.data.pl = pl;
    }
    return state.data.pl;
}

async function mapImage() {
    return (state.data.mapSrc ??= (await request('mapImage')).src);
}

async function getMapView(container, opts) {
    const { MapView } = await import('./map.js');
    return new MapView(container, await mapImage(), opts);
}

const fmtN = (n) => (Math.round(n * 10000) / 10000).toFixed(4);

function removeLines(pl, idxs) {
    return idxs.map((i) => `RemoveBuildingForPlayer(playerid, ${pl.ids[i]}, ${fmtN(pl.xyz[i * 3])}, ${fmtN(pl.xyz[i * 3 + 1])}, ${fmtN(pl.xyz[i * 3 + 2])}, 0.25);`);
}

/** Area mode: drag a rectangle on the map, list every object placed inside it. */
async function areaMode(detail, list, count, filtered, row) {
    detail.textContent = '';
    const mapBox = $('div', { class: 'map-box' }, $('div', { class: 'msg' }, L.loading));
    const info = $('div', { class: 'muted' }, L.areaHint);
    const tools = $('div', { class: 'map-tools' });
    const bar = $('div', { class: 'pad map-bar' }, info, $('div', { class: 'actions', id: 'areaActions' }));
    detail.append(mapBox, bar);
    const pl = await placements();
    mapBox.textContent = '';
    let inArea = []; // placement indexes inside the area that pass the filters
    let byModel = new Map();
    let focus = null;
    const map = await getMapView(mapBox, {
        tool: 'select',
        onSelect: (rect) => { state.area = rect; save(); refresh(); },
        onPick: (w) => pick(w),
    });
    const selBtn = $('button', { class: 'secondary', title: L.toolSelect }, '▭');
    const panBtn = $('button', { class: 'secondary', title: L.toolPan }, '✋');
    const fitBtn = $('button', { class: 'secondary', title: L.resetView }, '⤢');
    const setTool = (t) => { map.setTool(t); selBtn.classList.toggle('active', t === 'select'); panBtn.classList.toggle('active', t === 'pan'); };
    selBtn.onclick = () => setTool('select');
    panBtn.onclick = () => setTool('pan');
    fitBtn.onclick = () => map.fit(state.area ?? undefined);
    tools.append(selBtn, panBtn, fitBtn);
    mapBox.append(tools, $('div', { class: 'hud' }, L.mapHint));
    setTool('select');

    function refresh() {
        const ok = new Set(filtered().map((o) => o[0]));
        const a = state.area;
        inArea = [];
        const base = [];
        for (let i = 0; i < pl.count; i++) {
            if (!ok.has(pl.ids[i])) continue;
            const x = pl.xyz[i * 3];
            const y = pl.xyz[i * 3 + 1];
            if (a && x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2) inArea.push(i);
            else base.push(x, y);
        }
        byModel = new Map();
        for (const i of inArea) {
            const id = pl.ids[i];
            if (!byModel.has(id)) byModel.set(id, []);
            byModel.get(id).push(i);
        }
        if (focus && !byModel.has(focus)) focus = null;
        map.setSelection(a);
        draw(base);
        fillList();
        actions();
    }
    let baseXY = [];
    function draw(base = baseXY) {
        baseXY = base;
        const inXY = [];
        const focusXY = [];
        for (const i of inArea) (pl.ids[i] === focus ? focusXY : inXY).push(pl.xyz[i * 3], pl.xyz[i * 3 + 1]);
        map.setLayers([
            { xy: base, color: 'rgba(30,30,30,.35)', size: 1 },
            { xy: inXY, color: focus ? 'rgba(255,200,0,.55)' : '#ffc800', size: 1.6, stroke: 'rgba(0,0,0,.5)' },
            { xy: focusXY, color: '#e0245e', size: 2.6, stroke: '#fff' },
        ]);
    }
    function fillList() {
        list.textContent = '';
        if (!state.area) {
            count.textContent = L.areaNone;
            list.append($('div', { class: 'empty', style: 'padding:16px' }, L.areaHint));
            return;
        }
        const ws = words(state.q.objects);
        const objs = filtered((o) => byModel.has(o[0]));
        count.textContent = fmt(L.areaCount, objs.length, inArea.length);
        for (const o of objs) {
            if (ws.length && !matches(`${o[0]} ${o[1]} ${o[2]}`.toLowerCase(), ws)) continue;
            list.append(row(o, `×${byModel.get(o[0]).length}`, (ob, el) => {
                focus = focus === ob[0] ? null : ob[0];
                state.selected.object = ob[0];
                list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
                if (focus) el.classList.add('selected');
                draw();
                actions();
            }));
        }
    }
    function pick(w) {
        // nearest placement in the area (or anywhere) to the click
        let best = -1;
        let bd = (12 * map.scale) ** 2;
        const pool = inArea.length ? inArea : [];
        for (const i of pool) {
            const d = (pl.xyz[i * 3] - w[0]) ** 2 + (pl.xyz[i * 3 + 1] - w[1]) ** 2;
            if (d < bd) { bd = d; best = i; }
        }
        if (best < 0) return;
        focus = pl.ids[best];
        map.setMarker([pl.xyz[best * 3], pl.xyz[best * 3 + 1]]);
        draw();
        fillList();
        actions(best);
    }
    function actions(one) {
        const box = bar.querySelector('#areaActions');
        box.textContent = '';
        if (!state.area) { info.textContent = L.areaHint; return; }
        const a = state.area;
        info.textContent = fmt(L.areaInfo, `${a.x1.toFixed(1)}, ${a.y1.toFixed(1)}`, `${a.x2.toFixed(1)}, ${a.y2.toFixed(1)}`, inArea.length, byModel.size);
        const all = inArea;
        const sel = focus ? byModel.get(focus) ?? [] : [];
        const head = (n) => `// ${n} — ${L.areaComment} (${a.x1.toFixed(1)}, ${a.y1.toFixed(1)}) → (${a.x2.toFixed(1)}, ${a.y2.toFixed(1)})`;
        box.append(
            $('button', { onclick: () => insert([head(fmt(L.areaRemoveAll, all.length)), ...removeLines(pl, all)].join('\n') + '\n', false), disabled: !all.length }, fmt(L.areaRemoveAllBtn, all.length)),
            focus ? $('button', { class: 'secondary', onclick: () => insert([`// ${focus}`, ...removeLines(pl, sel)].join('\n') + '\n', false) }, fmt(L.areaRemoveModel, sel.length, focus)) : null,
            focus ? $('button', { class: 'secondary', onclick: () => { state.selected.object = focus; state.objMode = 'list'; save(); render(); } }, `🧊 ${L.view3d}`) : null,
            $('button', { class: 'secondary', onclick: () => { state.area = null; focus = null; map.setMarker(null); save(); refresh(); } }, L.areaClear));
        if (one !== undefined) {
            const line = removeLines(pl, [one])[0];
            box.append($('div', { class: 'col', style: 'width:100%' }, $('div', { class: 'muted' }, fmt(L.pickedAt, pl.ids[one], `${fmtN(pl.xyz[one * 3])}, ${fmtN(pl.xyz[one * 3 + 1])}, ${fmtN(pl.xyz[one * 3 + 2])}`)), codeBlock(line, line)));
        }
    }
    if (state.area) map.fit(state.area);
    refresh();
    return { refresh, fillList };
}

const fmtR = (n) => String(Math.round(n * 100) / 100).replace(/^(-?\d+)$/, '$1.0');
const posOf = (pl, i) => [pl.xyz[i * 3], pl.xyz[i * 3 + 1], pl.xyz[i * 3 + 2]].map(fmtN);
const rotOf = (pl, i) => [pl.rot[i * 3], pl.rot[i * 3 + 1], pl.rot[i * 3 + 2]].map(fmtR);
const COLORS = ['#e0245e', '#ffc800', '#1da1f2', '#17bf63', '#f45d22', '#a970ff', '#00d3c7', '#ff7ac6', '#c0ff00', '#ffffff'];

/** The code someone needs to work with one placement: coordinates, the same object again, removing it, going there. */
function placementCode(pl, i, model) {
    const id = pl.ids[i];
    const [x, y, z] = posOf(pl, i);
    const [rx, ry, rz] = rotOf(pl, i);
    const zUp = fmtN(pl.xyz[i * 3 + 2] + 1);
    return [
        [L.coords, `${x}, ${y}, ${z}`],
        [L.object, `CreateObject(${id}, ${x}, ${y}, ${z}, ${rx}, ${ry}, ${rz}); // ${model}`],
        [L.dynamicObject, `CreateDynamicObject(${id}, ${x}, ${y}, ${z}, ${rx}, ${ry}, ${rz}); // ${model}`],
        [L.removeBuilding, `RemoveBuildingForPlayer(playerid, ${id}, ${x}, ${y}, ${z}, 0.25);`],
        [L.teleport, `SetPlayerPos(playerid, ${x}, ${y}, ${zUp});`],
    ];
}

/** Every position of a model as a Pawn array ({x, y, z, rotZ}, or all three rotations when it is tilted). */
function positionsArray(pl, idxs, id, model) {
    const tilted = idxs.some((i) => Math.abs(pl.rot[i * 3]) > 0.01 || Math.abs(pl.rot[i * 3 + 1]) > 0.01);
    const name = 'g_' + model.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
    const rows = idxs.map((i) => {
        const r = rotOf(pl, i);
        return `    {${[...posOf(pl, i), ...(tilted ? r : [r[2]])].join(', ')}}`;
    });
    return [
        `// ${id} ${model} — ${fmt(L.positionsCount, idxs.length)} (${tilted ? 'x, y, z, rotX, rotY, rotZ' : 'x, y, z, rotZ'})`,
        `new const Float:${name}[][${tilted ? 6 : 4}] = {`,
        rows.join(',\n'),
        '};',
        '',
    ].join('\n');
}

/** Results mode: every placement of every object the search/filters find, on the big map. */
async function resultsMode(detail, list, count, filtered, row) {
    detail.textContent = '';
    const mapBox = $('div', { class: 'map-box' }, $('div', { class: 'msg' }, L.loading));
    const info = $('div', { class: 'muted' });
    const actionsBox = $('div', { class: 'actions' });
    const picked = $('div', { class: 'col' });
    const table = $('div', { class: 'pos-table' });
    const bar = $('div', { class: 'pad map-bar' }, info, actionsBox, picked, table);
    detail.append(mapBox, bar);
    const pl = await placements();
    mapBox.textContent = '';
    let objs = [];
    let colorOf = new Map();
    let pickedIdx = -1;
    const names = new Map(state.data.objects.map((o) => [o[0], o[1]]));
    const map = await getMapView(mapBox, { tool: 'pan', onPick: (w) => pick(w) });
    mapBox.append($('div', { class: 'hud' }, L.mapHint));

    const focusIdx = () => (state.resultsFocus ? pl.byModel.get(state.resultsFocus) ?? [] : []);
    const shownIdx = () => (state.resultsFocus ? focusIdx() : objs.flatMap((o) => pl.byModel.get(o[0])));
    function bounds(idxs) {
        const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
        for (const i of idxs) {
            const x = pl.xyz[i * 3];
            const y = pl.xyz[i * 3 + 1];
            b.x1 = Math.min(b.x1, x); b.y1 = Math.min(b.y1, y); b.x2 = Math.max(b.x2, x); b.y2 = Math.max(b.y2, y);
        }
        if (!idxs.length) return undefined;
        const pad = idxs.length === 1 ? 120 : 30;
        return { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad };
    }

    function refresh(fit = false) {
        objs = filtered((o) => pl.byModel.has(o[0]));
        if (state.resultsFocus && !objs.some((o) => o[0] === state.resultsFocus)) state.resultsFocus = null;
        // one color per model while there are few of them, so a mixed search (pump: petrol, gas, vegas…) reads apart
        colorOf = new Map(objs.length <= COLORS.length ? objs.map((o, i) => [o[0], COLORS[i]]) : []);
        fillList();
        draw();
        bar_();
        if (fit) fitResults();
    }
    function fitResults() {
        const b = bounds(shownIdx());
        if (b) map.fit(b);
    }
    function draw() {
        const layers = [];
        const many = shownIdx().length > 400;
        if (state.resultsFocus) {
            const other = [];
            for (const o of objs) if (o[0] !== state.resultsFocus) for (const i of pl.byModel.get(o[0])) other.push(pl.xyz[i * 3], pl.xyz[i * 3 + 1]);
            layers.push({ xy: other, color: 'rgba(30,30,30,.35)', size: 1 });
            const xy = focusIdx().flatMap((i) => [pl.xyz[i * 3], pl.xyz[i * 3 + 1]]);
            layers.push({ xy, color: colorOf.get(state.resultsFocus) ?? '#e0245e', size: many ? 1.6 : 2.6, stroke: many ? undefined : '#fff' });
        } else if (colorOf.size) {
            for (const o of objs) layers.push({ xy: pl.byModel.get(o[0]).flatMap((i) => [pl.xyz[i * 3], pl.xyz[i * 3 + 1]]), color: colorOf.get(o[0]), size: many ? 1.6 : 2.4, stroke: many ? undefined : 'rgba(0,0,0,.6)' });
        } else {
            const xy = [];
            for (const o of objs) for (const i of pl.byModel.get(o[0])) xy.push(pl.xyz[i * 3], pl.xyz[i * 3 + 1]);
            layers.push({ xy, color: '#ffc800', size: 1.3 });
        }
        map.setLayers(layers);
    }
    function fillList() {
        list.textContent = '';
        const total = objs.reduce((a, o) => a + pl.byModel.get(o[0]).length, 0);
        count.textContent = fmt(L.resultsCount, objs.length, total);
        if (!objs.length) list.append($('div', { class: 'empty', style: 'padding:16px' }, L.resultsNone));
        for (const o of objs.slice(0, 1000)) {
            const el = row(o, `×${pl.byModel.get(o[0]).length}`, (ob) => {
                state.resultsFocus = state.resultsFocus === ob[0] ? null : ob[0];
                state.selected.object = ob[0];
                pickedIdx = -1;
                map.setMarker(null);
                save();
                fillList();
                draw();
                bar_();
                fitResults();
            });
            el.classList.toggle('selected', state.resultsFocus === o[0]);
            const c = colorOf.get(o[0]);
            if (c) el.prepend($('span', { class: 'swatch', style: `background:${c}` }));
            list.append(el);
        }
    }
    function pick(w) {
        let best = -1;
        let bd = (14 * map.scale) ** 2;
        for (const i of shownIdx()) {
            const d = (pl.xyz[i * 3] - w[0]) ** 2 + (pl.xyz[i * 3 + 1] - w[1]) ** 2;
            if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0) select(best);
    }
    function select(i, center = false) {
        pickedIdx = i;
        map.setMarker([pl.xyz[i * 3], pl.xyz[i * 3 + 1]]);
        if (center) map.centerOn(pl.xyz[i * 3], pl.xyz[i * 3 + 1], Math.min(map.scale, 0.6));
        showPicked();
        table.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
        table.querySelector(`[data-i="${i}"]`)?.classList.add('selected');
    }
    function showPicked() {
        picked.textContent = '';
        if (pickedIdx < 0) return;
        const i = pickedIdx;
        const id = pl.ids[i];
        const model = names.get(id) ?? String(id);
        const notes = [pl.flags[i] & 1 ? L.lodNote : '', pl.flags[i] & 2 ? L.interiorNote : ''].filter(Boolean).join(' · ');
        picked.append($('div', {}, $('b', {}, `${id} ${model}`), notes ? $('span', { class: 'muted' }, ` — ${notes}`) : null));
        for (const [label, code] of placementCode(pl, i, model)) {
            picked.append($('div', { class: 'code-row' },
                $('span', { class: 'muted' }, label),
                $('code', { title: L.clickToCopy, onclick: () => copy(code) }, code),
                $('button', { class: 'secondary', title: L.insert, onclick: () => insert(code + '\n', false) }, '↵')));
        }
    }
    function bar_() {
        actionsBox.textContent = '';
        table.textContent = '';
        const total = shownIdx().length;
        if (!state.resultsFocus) {
            info.textContent = objs.length ? fmt(L.resultsInfo, total, objs.length) : L.resultsNone;
            actionsBox.append($('button', { class: 'secondary', onclick: fitResults, disabled: !total }, `⤢ ${L.fitResults}`));
            showPicked();
            return;
        }
        const id = state.resultsFocus;
        const model = names.get(id) ?? String(id);
        const idxs = focusIdx();
        info.textContent = fmt(L.resultsModelInfo, `${id} ${model}`, idxs.length);
        actionsBox.append(
            $('button', { onclick: () => insert(positionsArray(pl, idxs, id, model), false) }, fmt(L.insertPositions, idxs.length)),
            $('button', { class: 'secondary', onclick: () => copy(positionsArray(pl, idxs, id, model)) }, L.copyPositions),
            $('button', { class: 'secondary', onclick: () => insert([`// ${id} — ${fmt(L.areaRemoveAll, idxs.length)}`, ...removeLines(pl, idxs)].join('\n') + '\n', false) }, fmt(L.removeEverywhere, idxs.length)),
            $('button', { class: 'secondary', onclick: () => { state.selected.object = id; state.objMode = 'list'; save(); render(); } }, `🧊 ${L.view3d}`),
            $('button', { class: 'secondary', onclick: fitResults }, `⤢ ${L.fitResults}`));
        table.append($('div', { class: 'pos-head' }, $('span', {}, '#'), $('span', {}, 'X, Y, Z'), $('span', {}, 'rotX, rotY, rotZ')));
        idxs.slice(0, 2000).forEach((i, n) => {
            table.append($('div', { class: 'pos-row' + (i === pickedIdx ? ' selected' : ''), 'data-i': i, onclick: () => select(i, true) },
                $('span', { class: 'muted' }, n + 1), $('span', {}, posOf(pl, i).join(', ')), $('span', { class: 'muted' }, rotOf(pl, i).join(', '))));
        });
        showPicked();
    }
    refresh(true);
    return { refresh: () => refresh(true), fillList };
}

async function showObject(detail, o) {
    const [id, model, txd, group, dd, archive, section, placedN, lodN] = o;
    detail.textContent = '';
    const vp = $('div', { class: 'viewport' });
    const msg = $('div', { class: 'msg' }, L.loading);
    const wire = $('button', { class: 'secondary', onclick: () => viewer?.setWireframe(!viewer.wireframe) }, L.wireframe);
    const reset = $('button', { class: 'secondary', onclick: () => viewer?.resetView() }, L.resetView);
    vp.append(msg, $('div', { class: 'tools' }, wire, reset), $('div', { class: 'hud' }, L.animHint));
    const create = `CreateObject(${id}, \${1:x}, \${2:y}, \${3:z}, \${4:0.0}, \${5:0.0}, \${6:0.0});`;
    const dyn = `CreateDynamicObject(${id}, \${1:x}, \${2:y}, \${3:z}, \${4:0.0}, \${5:0.0}, \${6:0.0});`;
    const remove = `RemoveBuildingForPlayer(\${1:playerid}, ${id}, \${2:x}, \${3:y}, \${4:z}, \${5:0.25});`;
    const types = { objs: L.fTypeStatic, tobj: L.fTypeTimed, anim: L.fTypeAnim, weap: L.fTypeWeapon };
    const mapSection = $('div', { class: 'col', style: 'gap:6px' });
    const pad = $('div', { class: 'pad' },
        $('h2', {}, $('span', { class: 'id' }, id), model),
        $('dl', { class: 'props' },
            $('dt', {}, L.model), $('dd', {}, `${model}.dff`),
            $('dt', {}, L.txd), $('dd', {}, `${txd}.txd`),
            $('dt', {}, L.group), $('dd', {}, `${group} · ${archive === 'samp' ? 'SA-MP' : 'GTA SA'}`),
            $('dt', {}, L.fType), $('dd', {}, types[section] ?? section),
            $('dt', {}, L.fDrawDist), $('dd', {}, `${dd} m`),
            $('dt', {}, L.fPlaced), $('dd', {}, placedN ? fmt(L.placedTimes, placedN) + (lodN ? ` (${fmt(L.lodTimes, lodN)})` : '') : L.notPlaced)),
        $('div', { class: 'actions' },
            $('button', { onclick: () => insert(create) }, `${L.insert} ${L.object}`),
            $('button', { onclick: () => insert(dyn) }, `${L.insert} ${L.dynamicObject}`),
            $('button', { class: 'secondary', onclick: () => insert(remove) }, `${L.insert} ${L.removeBuilding}`),
            $('button', { class: 'secondary', onclick: () => copy(String(id)) }, L.copyId)),
        codeBlock(create),
        mapSection);
    detail.append(vp, pad);
    if (placedN) placementsOf(mapSection, id).catch((e) => mapSection.append($('div', { class: 'muted' }, fmt(L.error, e.message))));
    const res = await request('model', { id });
    if (state.selected.object !== id) return;
    if (!res.data) {
        msg.textContent = L.noModel;
        return;
    }
    msg.remove();
    try {
        (await getViewer(vp)).showModel(res.data);
    } catch (e) {
        vp.append($('div', { class: 'msg' }, fmt(L.error, e.message)));
    }
}

/** Mini map with every spot where the game places this model. */
async function placementsOf(box, id) {
    const pl = await placements();
    if (state.selected.object !== id) return;
    const idx = pl.byModel.get(id) ?? [];
    const xy = [];
    let b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const i of idx) {
        const x = pl.xyz[i * 3];
        const y = pl.xyz[i * 3 + 1];
        xy.push(x, y);
        b = { x1: Math.min(b.x1, x), y1: Math.min(b.y1, y), x2: Math.max(b.x2, x), y2: Math.max(b.y2, y) };
    }
    const picked = $('div', { class: 'col' });
    const mini = $('div', { class: 'map-box mini' });
    box.append($('label', {}, fmt(L.onMap, idx.length)), mini, picked,
        $('div', { class: 'actions' },
            $('button', { onclick: () => { state.resultsFocus = id; state.objMode = 'results'; save(); render(); } }, `📍 ${L.openBigMap}`),
            $('button', { class: 'secondary', onclick: () => insert(positionsArray(pl, idx, id, state.data.objects.find((x) => x[0] === id)?.[1] ?? String(id)), false) }, fmt(L.insertPositions, idx.length)),
            $('button', { class: 'secondary', onclick: () => insert([`// ${id} — ${fmt(L.areaRemoveAll, idx.length)}`, ...removeLines(pl, idx)].join('\n') + '\n', false) }, fmt(L.removeEverywhere, idx.length))));
    const map = await getMapView(mini, {
        tool: 'pan',
        onPick: (w) => {
            let best = -1;
            let bd = (14 * map.scale) ** 2;
            for (const i of idx) {
                const d = (pl.xyz[i * 3] - w[0]) ** 2 + (pl.xyz[i * 3 + 1] - w[1]) ** 2;
                if (d < bd) { bd = d; best = i; }
            }
            if (best < 0) return;
            map.setMarker([pl.xyz[best * 3], pl.xyz[best * 3 + 1]]);
            picked.textContent = '';
            picked.append($('div', { class: 'muted' }, fmt(L.pickedAt, id, posOf(pl, best).join(', '))));
            for (const [label, code] of placementCode(pl, best, state.data.objects.find((x) => x[0] === id)?.[1] ?? String(id))) {
                picked.append($('div', { class: 'code-row' },
                    $('span', { class: 'muted' }, label),
                    $('code', { title: L.clickToCopy, onclick: () => copy(code) }, code),
                    $('button', { class: 'secondary', title: L.insert, onclick: () => insert(code + '\n', false) }, '↵')));
            }
        },
    });
    map.setLayers([{ xy, color: "#e0245e", size: idx.length > 150 ? 1.4 : 2.4, stroke: idx.length > 150 ? undefined : "#fff" }]);
    if (idx.length) map.fit(idx.length === 1 ? { x1: b.x1 - 150, y1: b.y1 - 150, x2: b.x2 + 150, y2: b.y2 + 150 } : b);
}

// ───────────────────────── sprites ─────────────────────────

async function renderSprites(body) {
    if (!state.data.sprites) {
        body.append($('div', { class: 'empty' }, L.loading));
        state.data.sprites = (await request('sprites')).libs;
        state.data.spritePngs = {};
        if (state.tab !== 'sprites') return;
        body.textContent = '';
    }
    const libs = state.data.sprites;
    const count = $('div', { class: 'count' });
    const { side, list } = sideList({ placeholder: L.searchSprites, query: state.q.sprites, onQuery: (q) => { state.q.sprites = q; save(); fill(); }, count });
    const main = $('div', { class: 'detail' });
    body.append(side, main);
    function fill() {
        const ws = words(state.q.sprites);
        list.textContent = '';
        let total = 0;
        const visible = [];
        for (const lib of libs) {
            const tex = lib.textures.filter((t) => !ws.length || matches(`${lib.name}:${t[0]}`.toLowerCase(), ws));
            if (!tex.length) continue;
            total += tex.length;
            visible.push([lib, tex]);
            const el = $('div', { class: 'item' + (state.selected.spriteLib === lib.name ? ' selected' : ''), onclick: () => { state.selected.spriteLib = lib.name; fill(); showLib(lib, tex); } }, $('span', { class: 'name' }, lib.name), $('span', { class: 'tag' }, tex.length));
            list.append(el);
        }
        count.textContent = fmt(L.results, total);
        const cur = visible.find(([l]) => l.name === state.selected.spriteLib) ?? visible[0];
        if (cur) {
            state.selected.spriteLib = cur[0].name;
            list.querySelectorAll('.item').forEach((x) => x.classList.toggle('selected', x.firstChild.textContent === cur[0].name));
            showLib(cur[0], cur[1]);
        } else main.textContent = '';
    }
    async function showLib(lib, tex) {
        main.textContent = '';
        const info = $('div', { class: 'pad', id: 'spriteInfo' }, $('div', { class: 'muted' }, L.pickItem));
        const grid = $('div', { class: 'grid' });
        main.append(info, grid);
        let pngs = state.data.spritePngs[lib.name];
        if (!pngs) {
            grid.append($('div', { class: 'muted' }, L.loading));
            pngs = state.data.spritePngs[lib.name] = (await request('spriteLib', { name: lib.name })).pngs;
            if (state.selected.spriteLib !== lib.name) return;
            grid.textContent = '';
        }
        for (const t of tex) {
            const cell = $('div', { class: 'cell' + (state.selected.sprite === `${lib.name}:${t[0]}` ? ' selected' : ''), title: `${lib.name}:${t[0]}` },
                $('div', { class: 'thumb checker' }, $('img', { src: pngs[t[0]] ?? '', alt: t[0] })),
                $('div', { class: 'cap' }, t[0]), $('div', { class: 'cap muted' }, `${t[1]}×${t[2]}`));
            cell.addEventListener('click', () => {
                state.selected.sprite = `${lib.name}:${t[0]}`;
                grid.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
                cell.classList.add('selected');
                showSprite(info, lib.name, t, pngs[t[0]]);
            });
            cell.addEventListener('dblclick', () => insert(spriteCode(lib.name, t, false)));
            grid.append(cell);
        }
        const sel = tex.find((t) => state.selected.sprite === `${lib.name}:${t[0]}`);
        if (sel) showSprite(info, lib.name, sel, pngs[sel[0]]);
    }
    fill();
}

function spriteCode(lib, t, player) {
    const name = `${lib}:${t[0]}`;
    if (player) {
        return `new PlayerText:\${1:td} = CreatePlayerTextDraw(\${2:playerid}, \${3:320.0}, \${4:240.0}, "${name}");\n` +
            `PlayerTextDrawFont(\${2:playerid}, \${1:td}, TEXT_DRAW_FONT_SPRITE_DRAW);\n` +
            `PlayerTextDrawTextSize(\${2:playerid}, \${1:td}, \${5:${t[1]}.0}, \${6:${t[2]}.0});\n` +
            `PlayerTextDrawColour(\${2:playerid}, \${1:td}, \${7:-1});\n`;
    }
    return `new Text:\${1:td} = TextDrawCreate(\${2:320.0}, \${3:240.0}, "${name}");\n` +
        `TextDrawFont(\${1:td}, TEXT_DRAW_FONT_SPRITE_DRAW);\n` +
        `TextDrawTextSize(\${1:td}, \${4:${t[1]}.0}, \${5:${t[2]}.0});\n` +
        `TextDrawColour(\${1:td}, \${6:-1});\n`;
}

function showSprite(info, lib, t, png) {
    const name = `${lib}:${t[0]}`;
    info.textContent = '';
    info.append(
        $('div', { class: 'row wrap' },
            $('div', { class: 'checker', style: 'padding:6px;border-radius:4px' }, $('img', { src: png, style: `width:${Math.max(64, Math.min(t[1], 160))}px;image-rendering:pixelated;display:block` })),
            $('div', { class: 'col grow' },
                $('h2', {}, $('code', {}, `"${name}"`)),
                $('dl', { class: 'props' }, $('dt', {}, L.size), $('dd', {}, `${t[1]} × ${t[2]}`), $('dt', {}, L.library), $('dd', {}, `models/txd/${lib}.txd`)),
                $('div', { class: 'actions' },
                    $('button', { onclick: () => insert(spriteCode(lib, t, false)) }, `${L.insert} — ${L.textdraw}`),
                    $('button', { onclick: () => insert(spriteCode(lib, t, true)) }, `${L.insert} — ${L.playerTextdraw}`),
                    $('button', { class: 'secondary', onclick: () => copy(name) }, `${L.copy} "${name}"`)))),
        $('div', { class: 'note' }, L.spriteHint));
}

// ───────────────────────── animations ─────────────────────────

async function renderAnimations(body) {
    if (!state.data.anims) {
        body.append($('div', { class: 'empty' }, L.loading));
        const res = await request('anims');
        state.data.anims = res.libs;
        state.data.skins = res.skins;
        state.data.peds = {};
        if (state.tab !== 'animations') return;
        body.textContent = '';
    }
    const libs = state.data.anims;
    const count = $('div', { class: 'count' });
    const { side, list } = sideList({ placeholder: L.searchAnims, query: state.q.animations, onQuery: (q) => { state.q.animations = q; save(); fill(); }, count });
    const detail = $('div', { class: 'detail' });
    body.append(side, detail);
    let shown = PAGE;
    function fill(keep = false) {
        if (!keep) shown = PAGE;
        const ws = words(state.q.animations);
        list.textContent = '';
        let n = 0;
        let total = 0;
        // libraries start collapsed (jump straight to the one you want); a search opens the ones that match
        const open = new Set(state.openLibs);
        for (const lib of libs) {
            const anims = lib.anims.filter((a) => !ws.length || matches(`${lib.name} ${a}`.toLowerCase(), ws));
            if (!anims.length) continue;
            total += anims.length;
            const expanded = ws.length ? !open.has('!' + lib.name) : open.has(lib.name);
            const toggle = () => {
                const key = ws.length ? '!' + lib.name : lib.name;
                const set = new Set(state.openLibs);
                if (set.has(key)) set.delete(key);
                else set.add(key);
                state.openLibs = [...set];
                save();
                const top = list.scrollTop;
                fill(true);
                list.scrollTop = top;
            };
            list.append($('div', { class: 'item header' + (expanded ? ' open' : ''), onclick: toggle },
                $('span', { class: 'chev' }, expanded ? '▾' : '▸'), $('span', { class: 'name' }, lib.name), $('span', { class: 'tag' }, anims.length)));
            if (!expanded) continue;
            for (const a of anims) {
                if (n++ >= shown) break;
                const key = `${lib.name}/${a}`;
                const el = $('div', { class: 'item' + (state.selected.anim === key ? ' selected' : ''), onclick: () => { state.selected.anim = key; list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected')); el.classList.add('selected'); showAnim(detail, lib.name, a); } }, $('span', { class: 'name', style: 'padding-left:22px' }, a));
                list.append(el);
            }
        }
        count.textContent = fmt(L.results, total);
        if (n > shown) list.append($('button', { class: 'more secondary', onclick: () => { shown += PAGE; fill(true); } }, L.showMore));
    }
    fill();
    if (state.selected.anim) {
        const [lib, name] = state.selected.anim.split('/');
        showAnim(detail, lib, name);
    } else detail.append($('div', { class: 'empty' }, L.pickItem));
}

async function showAnim(detail, lib, name) {
    detail.textContent = '';
    const vp = $('div', { class: 'viewport' });
    const msg = $('div', { class: 'msg' }, L.loading);
    const timeHud = $('div', { class: 'hud' }, L.animHint);
    vp.append(msg, timeHud);
    const skinSel = $('select', {}, ...state.data.skins.map(([id, model]) => $('option', { value: id, selected: id === state.skin }, `${id} · ${model}`)));
    const playBtn = $('button', { class: 'secondary' }, L.pause);
    const loop = $('input', { type: 'checkbox', checked: state.loop });
    const inPlace = $('input', { type: 'checkbox', checked: state.inPlace });
    const speed = $('select', {}, ...[0.25, 0.5, 1, 1.5, 2].map((s) => $('option', { value: s, selected: s === state.speed }, `${s}×`)));
    const code = () =>
        `ApplyAnimation(\${1:playerid}, "${lib}", "${name}", \${2:4.1}, \${3:${state.loop ? 1 : 0}}, \${4:0}, \${5:0}, \${6:0}, \${7:0}, \${8:1});`;
    const block = codeBlock(code());
    const pad = $('div', { class: 'pad' },
        $('h2', {}, $('code', {}, `"${lib}", "${name}"`)),
        $('div', { class: 'row wrap' },
            $('label', {}, L.skin), skinSel, playBtn,
            $('label', { class: 'row' }, loop, L.loop), $('label', { class: 'row' }, inPlace, L.inPlace),
            $('label', {}, L.speed), speed),
        $('div', { class: 'actions' },
            $('button', { onclick: () => insert(code()) }, `${L.insert} ${L.applyAnimation}`),
            $('button', { class: 'secondary', onclick: () => copy(`"${lib}", "${name}"`) }, L.copy)),
        block);
    detail.append(vp, pad);
    let paused = false;
    const load = async () => {
        msg.textContent = L.loading;
        if (!msg.isConnected) vp.append(msg);
        const needPed = !state.data.peds[state.skin];
        const res = await request('animation', { lib, name, skin: needPed ? state.skin : 0 });
        if (state.selected.anim !== `${lib}/${name}`) return;
        if (res.ped) state.data.peds[state.skin] = res.ped;
        const ped = state.data.peds[state.skin];
        if (!ped) { msg.textContent = L.noModel; return; }
        msg.remove();
        const v = await getViewer(vp);
        v.showAnimated(ped, res.anim, { loop: state.loop, inPlace: state.inPlace, speed: state.speed });
        v.setPaused(paused);
        v.onFrame = (t, d) => (timeHud.textContent = `${t.toFixed(2)}s / ${d.toFixed(2)}s`);
    };
    skinSel.addEventListener('change', () => { state.skin = +skinSel.value; save(); load(); });
    loop.addEventListener('change', () => { state.loop = loop.checked; save(); block.replaceWith(codeBlock(code())); load(); });
    inPlace.addEventListener('change', () => { state.inPlace = inPlace.checked; save(); load(); });
    speed.addEventListener('change', () => { state.speed = +speed.value; save(); if (viewer) viewer.speed = state.speed; });
    playBtn.addEventListener('click', () => { paused = !paused; viewer?.setPaused(paused); playBtn.textContent = paused ? L.play : L.pause; });
    load();
}

// ───────────────────────── sounds ─────────────────────────

let audioCtx = null;
let playing = [];
function stopAudio() {
    for (const s of playing) {
        try {
            s.stop();
        } catch {
            /* already ended */
        }
    }
    playing = [];
}
/** parts: [{ rate, pan, speed, pcm (base64 mono s16le) }] played together, like the game does (left/right pairs). */
function playParts(parts) {
    stopAudio();
    if (!parts?.length) return 0;
    audioCtx ??= new AudioContext();
    let longest = 0;
    for (const p of parts) {
        const bin = atob(p.pcm);
        const n = bin.length >> 1;
        if (!n) continue;
        const buf = audioCtx.createBuffer(1, n, p.rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) {
            let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
            if (v & 0x8000) v -= 0x10000;
            ch[i] = v / 32768;
        }
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = p.speed || 1;
        const pan = audioCtx.createStereoPanner();
        pan.pan.value = (p.pan || 0) * 0.7;
        const gain = audioCtx.createGain();
        gain.gain.value = state.volume;
        src.connect(pan).connect(gain).connect(audioCtx.destination);
        src.start();
        playing.push(src);
        longest = Math.max(longest, n / p.rate / (p.speed || 1));
    }
    return longest;
}

function volumeControl() {
    const v = $('input', { type: 'range', min: 0, max: 1, step: 0.05, value: state.volume, title: L.volume, style: 'width:90px' });
    v.addEventListener('input', () => { state.volume = +v.value; save(); });
    return $('label', { class: 'row', title: L.volume }, '🔈', v);
}

/** IDs (PlayerPlaySound) ⇄ every sound in the game's banks. */
function modeSwitch() {
    if (!state.data.hasAudio) return null;
    const banks = state.soundMode === 'banks';
    const b = $('button', { class: 'secondary', title: banks ? L.soundIdsHint : L.soundBanksHint }, banks ? L.soundIds : L.soundBanks);
    b.addEventListener('click', () => { state.soundMode = banks ? 'ids' : 'banks'; save(); stopAudio(); render(); });
    return b;
}

async function renderSounds(body) {
    if (!state.data.sounds) {
        body.append($('div', { class: 'empty' }, L.loading));
        const res = await request('sounds');
        state.data.sounds = res.items;
        state.data.hasAudio = res.hasAudio;
        if (state.tab !== 'sounds') return;
        body.textContent = '';
    }
    if (state.soundMode === 'banks' && state.data.hasAudio) return renderBanks(body);
    const items = state.data.sounds;
    const count = $('div', { class: 'count' });
    const kindSel = $('select', {},
        $('option', { value: '', selected: !state.soundKind }, L.soundsAll),
        $('option', { value: 'play', selected: state.soundKind === 'play' }, L.soundsAudible),
        $('option', { value: 'known', selected: state.soundKind === 'known' }, L.soundsKnown));
    kindSel.addEventListener('change', () => { state.soundKind = kindSel.value; save(); fill(); });
    const { side, list } = sideList({
        placeholder: L.searchSounds,
        query: state.q.sounds,
        onQuery: (q) => { state.q.sounds = q; save(); fill(); },
        extra: $('div', { class: 'row' }, kindSel, modeSwitch()),
        count,
    });
    const detail = $('div', { class: 'detail' });
    body.append(side, detail);
    let shown = PAGE;
    const pretty = (n) => n.replace(/^SOUND_/, '').toLowerCase().replace(/_/g, ' ');
    const icon = { play: '🔊', mission: '🔇', track: '🎵' };
    function fill(keep = false) {
        if (!keep) shown = PAGE;
        const ws = words(state.q.sounds.replace(/_/g, ' '));
        const f = items.filter((s) =>
            (!state.soundKind || (state.soundKind === 'play' ? s[2] === 'play' : s[2] !== 'none')) &&
            (!ws.length || matches(`${s[0]} ${s[1].toLowerCase().replace(/_/g, ' ')}`, ws)));
        count.textContent = fmt(L.results, f.length);
        list.textContent = '';
        for (const s of f.slice(0, shown)) {
            const el = $('div', {
                class: 'item' + (state.selected.sound === s[0] ? ' selected' : ''),
                title: s[1],
                onclick: () => {
                    state.selected.sound = s[0];
                    list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
                    el.classList.add('selected');
                    show(s, true);
                },
            }, $('span', { class: 'id' }, s[0]), $('span', { class: 'name' }, pretty(s[1])), icon[s[2]] ? $('span', { class: 'tag', title: L['kind_' + s[2]] }, icon[s[2]]) : null);
            list.append(el);
        }
        if (f.length > shown) list.append($('button', { class: 'more secondary', onclick: () => { shown += PAGE; fill(true); } }, L.showMore));
    }
    function show(s, autoplay = false) {
        const code = `PlayerPlaySound(\${1:playerid}, ${s[0]}, \${2:0.0}, \${3:0.0}, \${4:0.0}); // ${s[1]}`;
        detail.textContent = '';
        const audible = s[2] === 'play' && state.data.hasAudio;
        const status = $('span', { class: 'muted' });
        const from = $('div', { class: 'muted', style: 'font-size:.9em' });
        const play = async () => {
            status.textContent = L.loading;
            const res = await request('soundAudio', { id: s[0] });
            if (state.selected.sound !== s[0]) return;
            status.textContent = res.parts.length ? fmt(L.soundDuration, playParts(res.parts).toFixed(2)) : L.kind_none;
            from.textContent = res.parts.length ? fmt(L.soundFrom, res.parts.map((p) => `${p.bank}:${p.sound}`).join(', ')) : '';
        };
        detail.append($('div', { class: 'pad' },
            $('h2', {}, $('span', { class: 'id' }, s[0]), $('code', {}, s[1])),
            audible ? $('div', { class: 'actions' },
                $('button', { onclick: () => play().catch((e) => (status.textContent = fmt(L.error, e.message))) }, '▶ ' + L.play),
                $('button', { class: 'secondary', title: L.stop, onclick: stopAudio }, '■'),
                volumeControl(), status) : null,
            from,
            $('div', { class: 'note' }, state.data.hasAudio ? L['kind_' + s[2]] : L.noAudio),
            $('div', { class: 'actions' },
                $('button', { onclick: () => insert(code) }, `${L.insert} ${L.playSound}`),
                $('button', { class: 'secondary', onclick: () => copy(String(s[0])) }, L.copyId)),
            codeBlock(code)));
        if (audible && autoplay) play().catch(() => {});
    }
    fill();
    const sel = items.find((s) => s[0] === state.selected.sound);
    if (sel) show(sel);
    else detail.append($('div', { class: 'empty' }, L.soundIntro));
}

async function renderBanks(body) {
    if (!state.data.banks) {
        body.append($('div', { class: 'empty' }, L.loading));
        state.data.banks = (await request('banks')).banks.filter((b) => b[3] > 0);
        if (state.tab !== 'sounds') return;
        body.textContent = '';
    }
    const banks = state.data.banks;
    const count = $('div', { class: 'count' });
    const { side, list } = sideList({
        placeholder: L.searchBanks,
        query: state.q.banks ?? '',
        onQuery: (q) => { state.q.banks = q; save(); fill(); },
        extra: modeSwitch(),
        count,
    });
    const detail = $('div', { class: 'detail' });
    body.append(side, detail);
    const opened = () => new Set(state.openBanks);
    function fill() {
        const ws = words((state.q.banks ?? '').replace(/_/g, ' '));
        const o = opened();
        const f = banks.filter((b) => !ws.length || matches(`${b[0]} ${b[1].toLowerCase().replace(/_/g, ' ')} ${b[2].toLowerCase()}`, ws));
        count.textContent = fmt(L.soundBanksCount, f.length, f.reduce((a, b) => a + b[3], 0));
        const top = list.scrollTop;
        list.textContent = '';
        for (const [bank, name, pak, n] of f) {
            const expanded = o.has(bank);
            list.append($('div', {
                class: 'item header' + (expanded ? ' open' : ''),
                title: `${pak} · bank ${bank}`,
                onclick: () => {
                    const s = opened();
                    if (s.has(bank)) s.delete(bank);
                    else s.add(bank);
                    state.openBanks = [...s];
                    save();
                    fill();
                },
            }, $('span', { class: 'chev' }, expanded ? '▾' : '▸'), $('span', { class: 'name' }, name.toLowerCase()), $('span', { class: 'tag' }, n)));
            if (!expanded) continue;
            for (let i = 0; i < n; i++) {
                const key = `${bank}:${i}`;
                const el = $('div', {
                    class: 'item' + (state.selected.bankSound === key ? ' selected' : ''),
                    onclick: () => {
                        state.selected.bankSound = key;
                        list.querySelectorAll('.selected').forEach((x) => x.classList.remove('selected'));
                        el.classList.add('selected');
                        show(bank, name, i);
                    },
                }, $('span', { class: 'name', style: 'padding-left:22px' }, `#${i}`), $('span', { class: 'tag' }, '▶'));
                list.append(el);
            }
        }
        list.scrollTop = top;
    }
    function show(bank, name, i) {
        detail.textContent = '';
        const status = $('span', { class: 'muted' }, L.loading);
        const label = `${name.toLowerCase()} #${i}`;
        const play = async () => {
            const res = await request('bankSound', { bank, index: i });
            if (state.selected.bankSound !== `${bank}:${i}`) return;
            status.textContent = res.part ? fmt(L.soundDuration, playParts([res.part]).toFixed(2)) : L.kind_none;
        };
        const usedBy = state.data.sounds.filter((s) => (s[3] ?? []).includes(`${bank}:${i}`));
        detail.append($('div', { class: 'pad' },
            $('h2', {}, $('code', {}, label)),
            $('div', { class: 'actions' },
                $('button', { onclick: () => play().catch((e) => (status.textContent = fmt(L.error, e.message))) }, '▶ ' + L.play),
                $('button', { class: 'secondary', title: L.stop, onclick: stopAudio }, '■'),
                volumeControl(),
                $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'saveWav', bank, index: i, name: `${name.toLowerCase()}_${i}` }) }, L.saveWav),
                status),
            usedBy.length ? $('div', {}, L.usedBy + ' ', ...usedBy.map((s) => $('code', { style: 'margin-right:6px' }, `${s[0]} ${s[1]}`))) : null,
            $('div', { class: 'note' }, L.soundBankNote)));
        play().catch((e) => (status.textContent = fmt(L.error, e.message)));
    }
    fill();
    detail.append($('div', { class: 'empty' }, L.soundBankNote));
}

// ───────────────────────── wiring ─────────────────────────

function render() {
    const body = shell();
    const fn = { objects: renderObjects, sprites: renderSprites, animations: renderAnimations, sounds: renderSounds }[state.tab];
    fn(body).catch((e) => body.append($('div', { class: 'empty' }, fmt(L.error, e.message))));
}

window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
        case 'init':
            if (msg.tab) state.tab = msg.tab;
            gtaDir = msg.gtaDir;
            if (!gtaDir) noGta(msg.error);
            else render();
            return;
        case 'tab':
            state.tab = msg.tab;
            save();
            if (gtaDir) render();
            return;
        case 'reset':
            state.data = {};
            viewer = null;
            vscode.postMessage({ type: 'init' });
            return;
        case 'error': {
            for (const [k, p] of pending) if (p.type === msg.request) { pending.delete(k); p.reject(new Error(msg.message)); }
            return;
        }
        case 'model': return settle(msg, { id: msg.id });
        case 'spriteLib': return settle(msg, { name: msg.name });
        case 'soundAudio': return settle(msg, { id: msg.id });
        case 'bankSound': return settle(msg, { bank: msg.bank, index: msg.index });
        default: return settle(msg);
    }
});
vscode.postMessage({ type: 'init' });
