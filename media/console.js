// "Pawn Studio" panel: compile cards, package log, server log.
(() => {
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
    const saved = vscode.getState() ?? {};
    let filter = saved.filter ?? 'all';
    const entries = new Map();
    const order = [];

    const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
    const clock = (t) => new Date(t).toLocaleTimeString();
    const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;

    const app = document.getElementById('app');
    const list = $('div', { class: 'list' });
    const chips = {};
    const bar = $('div', { class: 'bar' });
    for (const [id, label] of [['all', L.all], ['compile', L.builds], ['log', L.packages], ['server', L.server]]) {
        chips[id] = $('button', { class: 'chip' + (filter === id ? ' on' : ''), onclick: () => setFilter(id) }, label);
        bar.append(chips[id]);
    }
    bar.append($('span', { class: 'spacer' }),
        $('button', { class: 'btn', onclick: () => vscode.postMessage({ type: 'command', command: 'pawnStudio.compile' }) }, `▶ ${L.compile}`),
        $('button', { class: 'btn secondary', onclick: () => vscode.postMessage({ type: 'command', command: 'pawnStudio.compileAll' }) }, L.compileAll));
    app.append(bar, list);

    function setFilter(id) {
        filter = id;
        vscode.setState({ filter });
        for (const [k, c] of Object.entries(chips)) c.classList.toggle('on', k === id);
        render();
    }

    const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 30;

    function render() {
        const stick = atBottom();
        list.textContent = '';
        const shown = order.map((id) => entries.get(id)).filter((e) => filter === 'all' || e.kind === filter);
        if (!shown.length) list.append($('div', { class: 'empty' }, L.empty));
        for (const e of shown) list.append(card(e));
        if (stick) window.scrollTo(0, document.body.scrollHeight);
    }

    function card(e) {
        if (e.kind === 'compile') return compileCard(e);
        if (e.kind === 'server') return linesCard(e, 'server', `▣ ${e.title}`, e.running ? L.running : L.stopped, e.lines.map((l) => [l.text, l.level]));
        return linesCard(e, 'log', e.title || L.message, '', e.lines.map((l) => [l, /^✔/.test(l) ? 'ok' : /^✖/.test(l) ? 'error' : /^\s*[+↓]/.test(l) ? 'dim' : '']));
    }

    function linesCard(e, cls, title, sub, lines) {
        const box = $('div', { class: 'lines' }, ...lines.map(([t, c]) => $('div', { class: c || '' }, t)));
        setTimeout(() => (box.scrollTop = box.scrollHeight), 0);
        return $('div', { class: `card ${cls}` },
            $('div', { class: 'head' }, $('span', { class: 'title' }, title), sub ? $('span', { class: 'muted' }, sub) : null, $('span', { class: 'time' }, clock(e.at))),
            lines.length ? box : null);
    }

    function compileCard(e) {
        const name = e.entry.split('/').pop();
        const c = $('div', { class: `card ${e.state}` });
        const icon = e.state === 'ok' ? '✔' : e.state === 'fail' ? '✖' : '⟳';
        const title = e.state === 'running' ? fmt(L.compiling, e.title.toLowerCase(), name) : fmt(e.state === 'ok' ? L.built : L.failed, `${e.title} ${name}`);
        c.append($('div', { class: 'head' },
            $('span', { class: 'icon' }, icon),
            $('span', { class: 'title' }, title),
            $('span', { class: 'muted' }, e.reason),
            $('span', { class: 'time' }, `${clock(e.at)}${e.durationMs !== undefined ? ' · ' + secs(e.durationMs) : ''}`)));
        if (e.state === 'running') return c;

        const stats = $('div', { class: 'stats' });
        if (e.amxSize !== undefined) {
            const d = e.prevSize !== undefined ? e.amxSize - e.prevSize : 0;
            stats.append($('span', {}, `${L.size}: `, $('b', {}, bytes(e.amxSize)),
                d ? $('span', { class: d > 0 ? 'delta-up' : 'delta-down' }, ` (${d > 0 ? '+' : '−'}${bytes(Math.abs(d))})`) : null,
                ' · ', $('span', { class: 'link', onclick: () => vscode.postMessage({ type: 'reveal', file: e.amxAbs }) }, e.amx)));
        }
        stats.append($('span', {},
            e.errors ? $('span', { class: 'err' }, fmt(L.errors, e.errors)) : null,
            e.errors && e.warnings ? ' · ' : null,
            e.warnings ? $('span', { class: 'warn' }, fmt(L.warnings, e.warnings)) : null,
            !e.errors && !e.warnings ? $('span', { class: 'muted' }, L.noIssues) : null));
        c.append(stats);

        if (e.sizes) {
            const s = e.sizes;
            const parts = [['c-header', L.header, s.header], ['c-code', L.code, s.code], ['c-data', L.data, s.data], ['c-stack', L.stack, s.stackHeap]];
            const sum = parts.reduce((a, p) => a + p[2], 0) || 1;
            const stackNote = s.stackUsed !== undefined ? fmt(L.stackUsed, bytes(s.stackUsed)) : L.stackUnknown;
            c.append($('div', { class: 'mem' },
                $('div', { class: 'membar', title: `${L.total}: ${bytes(s.total)}` }, ...parts.map(([cls, , v]) => $('span', { class: cls, style: `width:${(v / sum) * 100}%` }))),
                $('div', { class: 'legend' },
                    $('span', {}, `${L.memory}: `, $('b', {}, bytes(s.total))),
                    ...parts.map(([cls, label, v]) => $('span', {}, $('i', { class: cls }), `${label} ${bytes(v)}${cls === 'c-stack' ? ` (${stackNote})` : ''}`)))));
        }

        if (e.diags.length) {
            const box = $('div', { class: 'diags' });
            const max = 30;
            for (const d of e.diags.slice(0, max)) {
                box.append($('div', { class: `diag ${d.severity}`, title: `${d.abs}:${d.line}`, onclick: () => vscode.postMessage({ type: 'open', file: d.abs, line: d.line }) },
                    $('span', { class: 'sev' }, d.severity === 'warning' ? '⚠' : '✖'),
                    $('span', { class: 'loc' }, `${d.file}:${d.line}`),
                    $('span', { class: 'msg' }, d.message),
                    $('span', { class: 'code' }, `${d.severity} ${d.code}`)));
            }
            if (e.diags.length > max) box.append($('div', { class: 'muted' }, fmt(L.more, e.diags.length - max)));
            c.append(box);
        }

        const det = $('details', {}, $('summary', {}, L.details),
            $('dl', { class: 'kv' },
                $('dt', {}, L.compiler), $('dd', {}, e.compiler),
                $('dt', {}, L.includes), $('dd', {}, e.includeDirs.join('\n') || '—'),
                $('dt', {}, L.command), $('dd', {}, e.commandLine, ' ', $('span', { class: 'link', onclick: () => vscode.postMessage({ type: 'copy', text: e.commandLine }) }, L.copy))));
        det.querySelector('dd:nth-of-type(2)').style.whiteSpace = 'pre-line';
        c.append(det);
        return c;
    }

    window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m.type === 'reset') {
            entries.clear();
            order.length = 0;
            for (const e of m.entries) { entries.set(e.id, e); order.push(e.id); }
            render();
        } else if (m.type === 'upsert') {
            if (!entries.has(m.entry.id)) order.push(m.entry.id);
            entries.set(m.entry.id, m.entry);
            while (order.length > 150) entries.delete(order.shift());
            render();
        }
    });
    render();
    vscode.postMessage({ type: 'ready' });
})();
