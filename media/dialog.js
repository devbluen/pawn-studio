// Dialog Creator: form + SA-MP-like live preview + generated Pawn code (native or easyDialog).
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

const STYLES = [
    ['DIALOG_STYLE_MSGBOX', L.msgbox],
    ['DIALOG_STYLE_INPUT', L.inputStyle],
    ['DIALOG_STYLE_LIST', L.list],
    ['DIALOG_STYLE_PASSWORD', L.passwordStyle],
    ['DIALOG_STYLE_TABLIST', L.tablist],
    ['DIALOG_STYLE_TABLIST_HEADERS', L.tablistHeaders],
];
const PALETTE = ['FFFFFF', 'A9C4E4', 'AFAFAF', '33AA33', '00FF00', 'FFFF00', 'FFA500', 'FF0000', 'FF6347', '00BFFF', '1E90FF', 'C2A2DA', 'FF69B4'];
const MAX_INFO = 4096;
const SPLIT_AT = 400;

const defaults = {
    style: 'DIALOG_STYLE_LIST',
    caption: '{FFFFFF}Menu',
    body: 'Item 1\nItem 2\n{FF0000}Item 3',
    button1: 'Select',
    button2: 'Cancel',
    name: 'DIALOG_MENU',
    codeStyle: 'native',
    handler: true,
};
const st = Object.assign({}, defaults, vscode.getState() ?? {});
/** What the game receives: the Pawn escapes people type (\t, \n) become real tab/newline. */
const real = (s) => s.replace(/\\([\\tn])/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : '\\'));
let selectedRow = 0;
const save = () => vscode.setState(st);

const css = `
.dlg-wrap { display:flex; height:100%; min-height:0; }
.dlg-form { width: 380px; min-width: 300px; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:10px; border-right:1px solid var(--border); }
.dlg-right { flex:1; display:flex; flex-direction:column; min-width:0; overflow:auto; }
.dlg-stage { background: radial-gradient(ellipse at center, #5a6b78 0%, #2e3a44 70%, #1c242b 100%); padding: 28px 16px; display:flex; justify-content:center; align-items:center; min-height: 300px; border-bottom:1px solid var(--border); }
.samp { font-family: Arial, Helvetica, sans-serif; font-weight: bold; font-size: 13px; color: #A9C4E4; background: rgba(0,0,0,.78); min-width: 280px; max-width: 92%; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
.samp .cap { background: rgba(0,0,0,.55); padding: 7px 10px; color:#FFFFFF; border-bottom: 1px solid rgba(255,255,255,.08); white-space: pre; }
.samp .body { padding: 10px 12px; white-space: pre-wrap; tab-size: 4; line-height: 1.35; }
.samp .rows { padding: 6px 4px; max-height: 260px; overflow:auto; }
.samp .r { display:grid; padding: 2px 8px; cursor:pointer; white-space: pre; }
.samp .r.sel { background: rgba(169,196,228,.35); }
.samp .r.head { color:#FFFFFF; cursor:default; border-bottom:1px solid rgba(255,255,255,.12); margin-bottom:2px; }
.samp .inp { margin: 0 12px 10px; background: rgba(255,255,255,.92); color:#000; padding:4px 6px; font-weight:normal; }
.samp .btns { display:flex; justify-content:center; gap:10px; padding: 4px 10px 10px; }
.samp .btn { background: rgba(60,60,60,.9); border:1px solid rgba(255,255,255,.18); color:#FFFFFF; padding:4px 14px; min-width: 70px; text-align:center; }
.palette { display:flex; flex-wrap:wrap; gap:4px; }
.sw { width: 20px; height: 20px; border-radius: 3px; border: 1px solid #0006; cursor:pointer; }
.seg { display:flex; gap:12px; flex-wrap:wrap; }
.warn { color: var(--vscode-editorWarning-foreground); font-size:.9em; }
`;
document.head.append($('style', {}, css));

const app = document.getElementById('app');
let bodyArea;

function field(label, input, hint) {
    return $('div', { class: 'col' }, $('label', {}, label), input, hint ? $('div', { class: 'muted', style: 'font-size:.85em' }, hint) : null);
}

function build(detected) {
    app.textContent = '';
    const style = $('select', {}, ...STYLES.map(([v, l]) => $('option', { value: v, selected: v === st.style }, l)));
    const caption = $('input', { type: 'text', value: st.caption, maxlength: 128 });
    bodyArea = $('textarea', { rows: 9 });
    bodyArea.value = st.body;
    bodyArea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            // in a table, a row can't get a 5th column
            if (/TABLIST/.test(st.style)) {
                const a = bodyArea;
                const start = a.value.lastIndexOf('\n', a.selectionStart - 1) + 1;
                const end = a.value.indexOf('\n', a.selectionStart);
                const line = real(a.value.slice(start, end < 0 ? undefined : end));
                if (allCells(line).length >= MAX_COLS) {
                    bodyHint.textContent = fmt(L.maxColumnsTab, MAX_COLS);
                    bodyHint.classList.add('warn');
                    setTimeout(() => bodyHint.classList.remove('warn'), 2500);
                    return;
                }
            }
            insertAtCursor('\t');
        }
    });
    const b1 = $('input', { type: 'text', value: st.button1 });
    const b2 = $('input', { type: 'text', value: st.button2 });
    const name = $('input', { type: 'text', value: st.name });
    const handler = $('input', { type: 'checkbox', checked: st.handler });
    const native = $('input', { type: 'radio', name: 'cs', checked: st.codeStyle === 'native' });
    const easy = $('input', { type: 'radio', name: 'cs', checked: st.codeStyle === 'easy' });
    const tag = (s) => (detected === s ? ` (${L.detected})` : '');
    const palette = $('div', { class: 'palette' }, ...PALETTE.map((c) => $('div', { class: 'sw', style: `background:#${c}`, title: `{${c}}`, onclick: () => insertAtCursor(`{${c}}`) })));
    const bodyLabel = $('label', {});
    const bodyHint = $('div', { class: 'muted', style: 'font-size:.85em' });

    const form = $('div', { class: 'dlg-form' },
        field(L.style, style),
        field(L.caption, caption),
        $('div', { class: 'col' }, bodyLabel, bodyArea, bodyHint),
        field(L.colors, palette, L.colorsHint),
        $('div', { class: 'row' }, $('div', { class: 'grow' }, field(L.button1, b1)), $('div', { class: 'grow' }, field(L.button2, b2))),
        field(L.name, name),
        field(L.codeStyle, $('div', { class: 'seg' }, $('label', { class: 'row' }, native, L.native + tag('native')), $('label', { class: 'row' }, easy, L.easy + tag('easy')))),
        $('label', { class: 'row' }, handler, L.handler));
    const stage = $('div', { class: 'dlg-stage' });
    const codeOut = $('pre', { class: 'code' });
    const warn = $('div', { class: 'warn' });
    const right = $('div', { class: 'dlg-right' },
        $('div', { class: 'pad', style: 'padding:8px 16px 0' }, $('label', {}, L.preview), $('div', { class: 'muted', style: 'font-size:.85em' }, L.selectRow)),
        stage,
        $('div', { class: 'pad', style: 'padding:12px 16px; display:flex; flex-direction:column; gap:8px' },
            $('div', { class: 'row' }, $('label', { class: 'grow' }, L.generated),
                $('button', { onclick: () => vscode.postMessage({ type: 'insert', code: generate() }) }, L.insert),
                $('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'copy', text: generate() }) }, L.copy)),
            warn, codeOut));
    app.append($('div', { class: 'dlg-wrap' }, form, right));

    const update = () => {
        st.style = style.value;
        st.caption = caption.value;
        st.body = bodyArea.value;
        st.button1 = b1.value;
        st.button2 = b2.value;
        st.name = name.value.trim() || 'DIALOG_ID';
        st.handler = handler.checked;
        st.codeStyle = easy.checked ? 'easy' : 'native';
        save();
        const isList = /LIST/.test(st.style);
        bodyLabel.textContent = isList ? L.items : L.body;
        bodyHint.textContent = /TABLIST/.test(st.style) ? L.columns + (/HEADERS/.test(st.style) ? ` · ${L.header}` : '') : '';
        stage.textContent = '';
        stage.append(preview());
        codeOut.textContent = generate();
        const len = info().length;
        const over = overflowRows();
        warn.textContent = [
            over.length ? fmt(L.maxColumns, MAX_COLS, over.slice(0, 8).join(', ') + (over.length > 8 ? '…' : '')) : '',
            len > MAX_INFO ? fmt(L.limit, MAX_INFO, len) : len > SPLIT_AT ? fmt(L.longText, SPLIT_AT) : '',
        ].filter(Boolean).join(' ');
    };
    for (const el of [style, caption, bodyArea, b1, b2, name, handler, native, easy]) {
        el.addEventListener('input', update);
        el.addEventListener('change', update);
    }
    native.addEventListener('change', () => vscode.postMessage({ type: 'saveStyle', style: 'native' }));
    easy.addEventListener('change', () => vscode.postMessage({ type: 'saveStyle', style: 'easy' }));
    window.__update = update;
    update();
}

function insertAtCursor(text) {
    const a = bodyArea;
    const s = a.selectionStart ?? a.value.length;
    const e = a.selectionEnd ?? s;
    a.value = a.value.slice(0, s) + text + a.value.slice(e);
    a.focus();
    a.selectionStart = a.selectionEnd = s + text.length;
    a.dispatchEvent(new Event('input'));
}

/** Text with SA-MP {RRGGBB} colors → DOM spans. */
function colored(text, base = '#A9C4E4') {
    const frag = document.createDocumentFragment();
    let color = base;
    let last = 0;
    const re = /\{([0-9A-Fa-f]{6})\}/g;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > last) frag.append($('span', { style: `color:${color}` }, text.slice(last, m.index)));
        color = `#${m[1]}`;
        last = re.lastIndex;
    }
    if (last < text.length) frag.append($('span', { style: `color:${color}` }, text.slice(last)));
    return frag;
}

function rows() {
    return real(st.body).split('\n').filter((r, i, a) => r !== '' || i < a.length - 1);
}

/** SA-MP draws at most 4 columns in TABLIST dialogs (3 \t per row); the rest of the row is dropped. */
const MAX_COLS = 4;
function allCells(row) {
    return row.split(/\t|\|/);
}
function cells(row) {
    return allCells(row).slice(0, MAX_COLS);
}
/** 1-based numbers of the rows with more columns than the game shows. */
function overflowRows() {
    if (!/TABLIST/.test(st.style)) return [];
    return rows().map((r, i) => (allCells(r).length > MAX_COLS ? i + 1 : 0)).filter(Boolean);
}

function preview() {
    const box = $('div', { class: 'samp' });
    box.append($('div', { class: 'cap' }, colored(real(st.caption), '#FFFFFF')));
    const isTab = /TABLIST/.test(st.style);
    if (/LIST/.test(st.style)) {
        const list = $('div', { class: 'rows' });
        let rs = rows();
        const cols = isTab ? Math.max(1, ...rs.map((r) => cells(r).length)) : 1;
        const grid = `grid-template-columns: repeat(${cols}, minmax(70px, auto)); column-gap: 18px`;
        if (/HEADERS/.test(st.style) && rs.length) {
            list.append($('div', { class: 'r head', style: grid }, ...cells(rs[0]).map((c) => $('span', {}, colored(c, '#FFFFFF')))));
            rs = rs.slice(1);
        }
        rs.forEach((r, i) => {
            const el = $('div', { class: 'r' + (i === selectedRow ? ' sel' : ''), style: grid, onclick: () => { selectedRow = i; window.__update(); } },
                ...(isTab ? cells(r) : [r]).map((c) => $('span', {}, colored(c))));
            list.append(el);
        });
        box.append(list);
    } else {
        box.append($('div', { class: 'body' }, colored(real(st.body))));
        if (st.style === 'DIALOG_STYLE_INPUT') box.append($('div', { class: 'inp' }, L.input));
        if (st.style === 'DIALOG_STYLE_PASSWORD') box.append($('div', { class: 'inp' }, L.password));
    }
    const btns = $('div', { class: 'btns' }, $('div', { class: 'btn' }, colored(real(st.button1), '#FFFFFF')));
    if (st.button2) btns.append($('div', { class: 'btn' }, colored(real(st.button2), '#FFFFFF')));
    box.append(btns);
    return box;
}

// ───────────────────────── code generation ─────────────────────────

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t');

function info() {
    let rs = real(st.body).split('\n');
    if (/TABLIST/.test(st.style)) rs = rs.map((r) => cells(r).join('\t'));
    return rs.join('\n');
}

function literal(s) {
    return `"${esc(s).replace(/\n/g, '\\n')}"`;
}

function generate() {
    const easy = st.codeStyle === 'easy';
    const isId = /^[A-Za-z_]\w*$/.test(st.name);
    const id = easy ? (isId ? st.name : `Dialog_${st.name.replace(/\W/g, '')}`) : st.name;
    const text = info();
    const lines = [];
    let infoArg;
    if (text.length > SPLIT_AT) {
        // keep each source line short: build the text with strcat
        const parts = [];
        let cur = '';
        for (const piece of text.split(/(?<=\n)/)) {
            if ((cur + piece).length > SPLIT_AT && cur) {
                parts.push(cur);
                cur = '';
            }
            cur += piece;
        }
        if (cur) parts.push(cur);
        const size = Math.min(MAX_INFO, Math.ceil((text.length + 1) / 256) * 256);
        lines.push(`new dialog_text[${size}];`);
        for (const p of parts) lines.push(`strcat(dialog_text, ${literal(p)});`);
        infoArg = 'dialog_text';
    } else infoArg = literal(text);
    const args = `${st.style}, ${literal(real(st.caption))}, ${infoArg}, ${literal(real(st.button1))}, ${literal(real(st.button2))}`;
    if (easy) lines.push(`Dialog_Show(playerid, ${id}, ${args});`);
    else {
        if (isId && !/^\d+$/.test(id)) lines.unshift(`// #define ${id} (1) // or an enum entry — must be unique per dialog`);
        lines.push(`ShowPlayerDialog(playerid, ${id}, ${args});`);
    }
    if (!st.handler) return lines.join('\n') + '\n';

    const body = [];
    const isList = /LIST/.test(st.style);
    body.push('if (!response) return 1;');
    if (isList) {
        let rs = rows();
        if (/HEADERS/.test(st.style)) rs = rs.slice(1);
        body.push('switch (listitem)', '{');
        rs.forEach((r, i) => body.push(`\tcase ${i}: // ${cells(r)[0].replace(/\{[0-9A-Fa-f]{6}\}/g, '').trim() || '-'}`, '\t{', '\t}'));
        body.push('}');
    } else if (/INPUT|PASSWORD/.test(st.style)) {
        body.push('if (!strlen(inputtext))', '{', `\t// empty input: show it again`, '\treturn 1;', '}');
    }
    body.push('return 1;');
    const indent = (arr, n) => arr.map((l) => '\t'.repeat(n) + l);
    lines.push('');
    if (easy) {
        lines.push(`Dialog:${id}(playerid, response, listitem, inputtext[])`, '{', ...indent(body, 1), '}');
    } else {
        lines.push('// inside OnDialogResponse(playerid, dialogid, response, listitem, inputtext[]):');
        lines.push(`if (dialogid == ${id})`, '{', ...indent(body, 1), '}');
    }
    return lines.join('\n') + '\n';
}

window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init' || m.type === 'prefill') {
        if (m.type === 'init' && !vscode.getState()) st.codeStyle = m.style !== 'auto' ? m.style : m.detected;
        if (m.prefill) {
            for (const [k, v] of Object.entries(m.prefill)) if (v !== undefined) st[k] = v;
            if (m.prefill.codeStyle === undefined && m.prefill.style) st.style = m.prefill.style;
        }
        build(m.detected);
    }
});
vscode.postMessage({ type: 'init' });
