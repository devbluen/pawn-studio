/**
 * "Pawn Studio" tab in the bottom panel: every compilation as a card (target, time, .amx size,
 * memory, errors you can click), the package manager log and the server log of debug sessions.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Builder, CompileJobInfo, CompileResult, kindLabel } from './build';
import { cfg, Pawn, rel } from './context';
import { notify } from './notify';
import { t } from './i18n';

const MAX_ENTRIES = 150;
const MAX_LINES = 400;

interface Diag {
    file: string;
    abs: string;
    line: number;
    severity: string;
    code: string;
    message: string;
}

type Entry =
    | {
          kind: 'compile';
          id: number;
          at: number;
          state: 'running' | 'ok' | 'fail' | 'cancelled';
          title: string;
          entry: string;
          entryAbs: string;
          reason: string;
          compiler: string;
          commandLine: string;
          includeDirs: string[];
          amx: string;
          amxAbs: string;
          durationMs?: number;
          amxSize?: number;
          prevSize?: number;
          sizes?: CompileResult['sizes'];
          errors: number;
          warnings: number;
          diags: Diag[];
      }
    | { kind: 'log'; id: number; at: number; title: string; lines: string[] }
    | { kind: 'server'; id: number; at: number; title: string; session: string; running: boolean; lines: { text: string; level: string }[] };

function nonce(): string {
    let s = '';
    for (let i = 0; i < 32; i++) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)];
    return s;
}

export class ConsoleView implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly id = 'pawnStudio.console';
    private view: vscode.WebviewView | undefined;
    private entries: Entry[] = [];
    private nextId = 1;
    private running: Extract<Entry, { kind: 'compile' }> | undefined;
    private logEntry: Extract<Entry, { kind: 'log' }> | undefined;
    private logPartial = '';
    private lastSize = new Map<string, number>();
    private subs: vscode.Disposable[] = [];

    constructor(private pawn: Pawn, private builder: Builder) {
        this.subs.push(
            vscode.window.registerWebviewViewProvider(ConsoleView.id, this, { webviewOptions: { retainContextWhenHidden: true } }),
            builder.onDidStartJob((j) => this.started(j)),
            builder.onDidCompile((r) => !r.background && this.finished(r)),
            builder.onDidCancel((t) => this.cancelled(t.entry)),
            vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('pawnStudio.notify') && this.postSettings()),
            pawn.onLog((s) => this.log(s)),
            vscode.debug.registerDebugAdapterTrackerFactory('pawn', { createDebugAdapterTracker: (s) => this.tracker(s) }),
        );
    }

    dispose(): void {
        this.subs.forEach((d) => d.dispose());
    }

    // ───────────────────────── sources ─────────────────────────

    /** The compilation that was running stops showing "Compiling…" when a new one replaces it. */
    private cancelled(entryAbs?: string): void {
        const e = this.running;
        if (!e || (entryAbs && e.entryAbs !== entryAbs) || e.state !== 'running') return;
        e.state = 'cancelled';
        e.durationMs = Date.now() - e.at;
        this.running = undefined;
        this.update(e);
    }

    private started(j: CompileJobInfo): void {
        this.cancelled(); // anything still marked as running was replaced by this one
        this.logEntry = undefined;
        const e: Extract<Entry, { kind: 'compile' }> = {
            kind: 'compile',
            id: this.nextId++,
            at: Date.now(),
            state: 'running',
            title: kindLabel(j.target.kind),
            entry: rel(j.target.entry),
            entryAbs: j.target.entry,
            reason: j.target.reason,
            compiler: j.compiler,
            commandLine: j.commandLine,
            includeDirs: j.includeDirs.map((d) => rel(d)),
            amx: rel(j.output),
            amxAbs: j.output,
            errors: 0,
            warnings: 0,
            diags: [],
        };
        this.running = e;
        this.push(e);
        const reveal = cfg().get<string>('revealOutput');
        if (reveal === 'always') this.reveal();
    }

    private finished(r: CompileResult): void {
        const e = this.running && this.running.entryAbs === r.target.entry ? this.running : undefined;
        if (!e) return;
        this.running = undefined;
        e.state = r.ok ? 'ok' : 'fail';
        e.durationMs = r.durationMs;
        e.errors = r.errors;
        e.warnings = r.warnings;
        e.sizes = r.sizes;
        e.amxSize = r.amxSize;
        const key = r.target.entry.toLowerCase();
        if (r.amxSize !== undefined) {
            e.prevSize = this.lastSize.get(key);
            this.lastSize.set(key, r.amxSize);
        }
        e.diags = r.diags.slice(0, 200).map((d) => ({ file: rel(d.file), abs: d.file, line: d.line, severity: d.severity, code: d.code, message: d.message }));
        this.update(e);
        if (!r.ok && cfg().get<string>('revealOutput') !== 'never') this.reveal();
        this.queueNotification(e);
    }

    // ───────────────────────── notification + sound ─────────────────────────

    private pendingNotes: Array<Extract<Entry, { kind: 'compile' }>> = [];
    private noteTimer: NodeJS.Timeout | undefined;

    /** Builds that end together (compile all) make one notification. */
    private queueNotification(e: Extract<Entry, { kind: 'compile' }>): void {
        const desktop = cfg().get<boolean>('notify.desktop', false);
        const sound = cfg().get<boolean>('notify.sound', false);
        if (!desktop && !sound) return;
        this.pendingNotes.push(e);
        clearTimeout(this.noteTimer);
        this.noteTimer = setTimeout(() => {
            const list = this.pendingNotes;
            this.pendingNotes = [];
            const failed = list.filter((x) => x.state === 'fail');
            const size = (n?: number) => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
            let title: string;
            let body: string;
            if (list.length === 1) {
                const x = list[0];
                const name = x.entry.split('/').pop()!;
                title = x.state === 'ok' ? t('{0} compiled', name) : t('{0} failed', name);
                body = x.state === 'ok'
                    ? [x.amx.split('/').pop(), size(x.amxSize), `${((x.durationMs ?? 0) / 1000).toFixed(2)}s`, x.warnings ? t('{0} warning(s)', x.warnings) : ''].filter(Boolean).join(' · ')
                    : [t('{0} error(s)', x.errors), x.diags[0] ? `${x.diags[0].file}:${x.diags[0].line} ${x.diags[0].message}` : ''].filter(Boolean).join(' · ');
            } else {
                title = failed.length ? t('{0} of {1} failed', failed.length, list.length) : t('{0} scripts compiled', list.length);
                body = list.map((x) => `${x.state === 'ok' ? '✔' : '✖'} ${x.entry.split('/').pop()}`).join('  ');
            }
            notify(!failed.length, title, body, { desktop, sound });
        }, 700);
    }

    private postSettings(): void {
        void this.view?.webview.postMessage({ type: 'settings', desktop: cfg().get<boolean>('notify.desktop', false), sound: cfg().get<boolean>('notify.sound', false) });
    }

    /** Package manager and other messages: grouped by their "[time] title" header line. */
    private log(text: string): void {
        const parts = (this.logPartial + text).split('\n');
        this.logPartial = parts.pop() ?? '';
        for (const line of parts) {
            const head = /^\[(\d{1,2}:\d{2}:\d{2}[^\]]*)\]\s+(.+)$/.exec(line);
            if (head) {
                this.logEntry = { kind: 'log', id: this.nextId++, at: Date.now(), title: head[2], lines: [] };
                this.push(this.logEntry);
                continue;
            }
            if (!line.trim()) continue;
            if (!this.logEntry) {
                this.logEntry = { kind: 'log', id: this.nextId++, at: Date.now(), title: '', lines: [] };
                this.push(this.logEntry);
            }
            this.logEntry.lines.push(line);
            if (this.logEntry.lines.length > MAX_LINES) this.logEntry.lines.splice(0, this.logEntry.lines.length - MAX_LINES);
            this.update(this.logEntry);
        }
    }

    /** Server output of Pawn debug sessions (the same text as the Debug Console). */
    private tracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
        let e: Extract<Entry, { kind: 'server' }> | undefined;
        let pending = '';
        let timer: NodeJS.Timeout | undefined;
        const flush = () => {
            timer = undefined;
            if (e) this.update(e);
        };
        return {
            onWillStartSession: () => {
                this.logEntry = undefined;
                e = { kind: 'server', id: this.nextId++, at: Date.now(), title: session.name, session: session.id, running: true, lines: [] };
                this.push(e);
            },
            onDidSendMessage: (m: { type?: string; event?: string; body?: { output?: string; category?: string; description?: string; text?: string } }) => {
                if (!e || m.type !== 'event') return;
                if (m.event === 'output' && m.body?.output && m.body.category !== 'telemetry') {
                    const parts = (pending + m.body.output).split(/\r?\n/);
                    pending = parts.pop() ?? '';
                    for (const text of parts) {
                        // whole words: "crashdetect.dll" in "Loading plugin" is not an error
                        const level = /run time error|\[debug\]\s*#\d|\berror\b|\bfatal\b|\bcrash(ed)?\b/i.test(text) ? 'error' : /\bwarning\b/i.test(text) ? 'warning' : m.body.category === 'important' ? 'info' : '';
                        e.lines.push({ text, level });
                    }
                    if (e.lines.length > MAX_LINES) e.lines.splice(0, e.lines.length - MAX_LINES);
                    if (!timer) timer = setTimeout(flush, 120);
                }
            },
            onExit: () => {
                if (!e) return;
                e.running = false;
                this.update(e);
            },
            onWillStopSession: () => {
                if (!e) return;
                e.running = false;
                this.update(e);
            },
        };
    }

    // ───────────────────────── view ─────────────────────────

    private push(e: Entry): void {
        this.entries.push(e);
        if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        void this.view?.webview.postMessage({ type: 'upsert', entry: e });
    }

    private update(e: Entry): void {
        void this.view?.webview.postMessage({ type: 'upsert', entry: e });
    }

    clear(): void {
        this.entries = [];
        this.logEntry = undefined;
        void this.view?.webview.postMessage({ type: 'reset', entries: [] });
    }

    /** Shows the tab without taking the keyboard from the editor. */
    reveal(): void {
        if (this.view) {
            this.view.show(true);
            return;
        }
        void vscode.commands.executeCommand(`${ConsoleView.id}.focus`).then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const media = vscode.Uri.joinPath(this.pawn.ctx.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const n = nonce();
        const w = view.webview;
        const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
        const strings = JSON.stringify(this.strings()).replace(/</g, '\\u003c');
        w.html = `<!DOCTYPE html><html lang="${vscode.env.language}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${n}' ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('console.css')}"></head>
<body><div id="app"></div>
<script nonce="${n}">window.L10N = ${strings};</script>
<script nonce="${n}" src="${uri('console.js')}"></script></body></html>`;
        w.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.subs);
        view.onDidDispose(() => (this.view = undefined), undefined, this.subs);
    }

    private async onMessage(m: { type: string; file?: string; line?: number; text?: string; command?: string; key?: string; value?: boolean }): Promise<void> {
        switch (m.type) {
            case 'ready':
                void this.view?.webview.postMessage({ type: 'reset', entries: this.entries });
                this.postSettings();
                return;
            case 'setting': {
                const key = m.key === 'sound' ? 'notify.sound' : 'notify.desktop';
                await cfg().update(key, !!m.value, vscode.ConfigurationTarget.Global);
                // turning one on gives a sample right away
                if (m.value) notify(true, t('Pawn Studio'), t('This is how a finished compilation is announced.'), { desktop: m.key !== 'sound', sound: m.key === 'sound' });
                return;
            }
            case 'open':
                if (m.file && fs.existsSync(m.file)) {
                    const line = Math.max(0, (m.line ?? 1) - 1);
                    await vscode.window.showTextDocument(vscode.Uri.file(m.file), { selection: new vscode.Range(line, 0, line, 0), preview: true });
                }
                return;
            case 'reveal':
                if (m.file) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.file));
                return;
            case 'copy':
                if (m.text) {
                    await vscode.env.clipboard.writeText(m.text);
                    vscode.window.setStatusBarMessage(t('$(check) Copied'), 2000);
                }
                return;
            case 'command':
                if (m.command && /^pawnStudio\./.test(m.command)) await vscode.commands.executeCommand(m.command);
                return;
        }
    }

    private strings(): Record<string, string> {
        return {
            empty: t('Nothing here yet. Press F5 in a .pwn file to compile: every build shows up here with its time, the .amx size, the memory it needs and the errors.'),
            compile: t('Compile'),
            compileAll: t('Compile all'),
            all: t('All'),
            builds: t('Compilation'),
            packages: t('Packages'),
            server: t('Server'),
            compiling: t('Compiling {0} {1}…'),
            built: t('{0} compiled'),
            failed: t('{0} failed'),
            cancelled: t('{0} cancelled: a new compilation started'),
            notifyDesktop: t('Notification'),
            notifyDesktopHint: t('Desktop notification when a compilation ends'),
            notifySound: t('Sound'),
            notifySoundHint: t('Play a sound when a compilation ends (a different one when it fails)'),
            errors: t('{0} error(s)'),
            warnings: t('{0} warning(s)'),
            noIssues: t('no errors or warnings'),
            size: t('.amx size'),
            memory: t('Memory'),
            header: t('Header'),
            code: t('Code'),
            data: t('Data'),
            stack: t('Stack/heap'),
            stackUsed: t('estimated use {0}'),
            stackUnknown: t('use unknown (recursion)'),
            total: t('Total'),
            details: t('Details'),
            compiler: t('Compiler'),
            includes: t('Include folders'),
            command: t('Command line'),
            copy: t('Copy'),
            openFolder: t('Open folder'),
            more: t('{0} more'),
            running: t('running'),
            stopped: t('stopped'),
            packageLog: t('Packages'),
            message: t('Message'),
        };
    }
}

export function registerConsole(pawn: Pawn, builder: Builder): ConsoleView {
    const view = new ConsoleView(pawn, builder);
    pawn.ctx.subscriptions.push(view, vscode.commands.registerCommand('pawnStudio.console.clear', () => view.clear()));
    void path;
    return view;
}
