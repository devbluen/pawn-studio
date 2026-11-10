/**
 * Live checking, in two layers:
 *  1. Quick analysis (quickLint) on every keystroke — milliseconds, no pawncc.
 *  2. Background pawncc over a shadow copy containing the UNSAVED text. Never cancelled by
 *     typing (YSI projects take tens of seconds): it is queued, and the result is adjusted
 *     to the edits made while compiling.
 * Also, diagnostics follow the text: inserting lines shifts the errors and editing a line
 * with an error removes it immediately.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { Builder, toVsDiagnostics } from './build';
import { cfg, Pawn, PAWN_EXT } from './context';
import { pathKey } from './includeGraph';
import { SymbolIndex } from './language/features';
import { makeContext, quickLint } from './language/quickLint';
import { parseSymbols } from './language/symbols';
import { commonAncestor, ShadowTree } from './shadow';
import { t } from './i18n';

interface LineEdit {
    start: number;
    end: number;
    delta: number;
}

function isPawnDoc(doc: vscode.TextDocument): boolean {
    return doc.languageId === 'pawn' || PAWN_EXT.test(doc.fileName);
}

function copyDiag(d: vscode.Diagnostic, range: vscode.Range): vscode.Diagnostic {
    const n = new vscode.Diagnostic(range, d.message, d.severity);
    n.source = d.source;
    n.code = d.code;
    n.tags = d.tags;
    n.relatedInformation = d.relatedInformation;
    return n;
}

/** Applies line edits to a list of diagnostics: shifts the ones below and removes the edited ones. */
export function shiftDiagnostics(list: readonly vscode.Diagnostic[], edits: LineEdit[]): vscode.Diagnostic[] {
    let out = [...list];
    for (const e of edits) {
        out = out.flatMap((d) => {
            if (d.range.end.line < e.start) return [d];
            if (d.range.start.line > e.end) {
                if (!e.delta) return [d];
                return [copyDiag(d, new vscode.Range(d.range.start.translate(e.delta), d.range.end.translate(e.delta)))];
            }
            return [];
        });
    }
    return out;
}

function toLineEdits(changes: readonly vscode.TextDocumentContentChangeEvent[]): LineEdit[] {
    return changes.map((c) => {
        const start = c.range.start.line;
        const end = c.range.end.line;
        const added = (c.text.match(/\n/g) ?? []).length;
        return { start, end, delta: added - (end - start) };
    });
}

export class LiveChecker implements vscode.Disposable {
    readonly quick = vscode.languages.createDiagnosticCollection('pawn-lint');
    private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    private disposables: vscode.Disposable[] = [];
    private knownGood = new Set<string>();
    private quickTimers = new Map<string, NodeJS.Timeout>();
    private deepTimer: NodeJS.Timeout | undefined;
    private deepRunning = false;
    private deepQueued = false;
    private deepDoc: vscode.Uri | undefined;
    private pendingEdits = new Map<string, LineEdit[]>();
    private shadows = new Map<string, ShadowTree>();
    private statusTimer: NodeJS.Timeout | undefined;

    constructor(
        private pawn: Pawn,
        private builder: Builder,
        private index: SymbolIndex,
    ) {
        this.status.name = t('Pawn: check');
        this.disposables.push(
            this.quick,
            this.status,
            vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
            vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
            vscode.workspace.onDidCloseTextDocument((d) => this.quick.delete(d.uri)),
            vscode.window.onDidChangeActiveTextEditor((ed) => ed && isPawnDoc(ed.document) && this.scheduleQuick(ed.document, 0)),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pawnStudio.lint')) vscode.window.visibleTextEditors.forEach((ed) => isPawnDoc(ed.document) && this.scheduleQuick(ed.document, 0));
            }),
        );
        for (const ed of vscode.window.visibleTextEditors) if (isPawnDoc(ed.document)) this.scheduleQuick(ed.document, 500);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.quickTimers.forEach((timer) => clearTimeout(timer));
        if (this.deepTimer) clearTimeout(this.deepTimer);
        if (this.statusTimer) clearInterval(this.statusTimer);
    }

    /** Project/files changed (save, create, delete): re-analyzes the open ones. */
    refreshVisible(): void {
        for (const ed of vscode.window.visibleTextEditors) if (isPawnDoc(ed.document)) this.scheduleQuick(ed.document, 50);
    }

    // ───────────────────────── events ─────────────────────────

    private onChange(e: vscode.TextDocumentChangeEvent): void {
        const doc = e.document;
        if (!isPawnDoc(doc) || !e.contentChanges.length) return;
        const edits = toLineEdits(e.contentChanges);
        // pawncc / crashdetect diagnostics follow the text
        for (const coll of [this.pawn.diagnostics, this.pawn.runtimeDiagnostics]) {
            const list = coll.get(doc.uri);
            if (list?.length) coll.set(doc.uri, shiftDiagnostics(list, edits));
        }
        // ...and the result of the pawncc run still in progress will be adjusted too
        if (this.deepRunning) {
            const k = doc.uri.toString();
            this.pendingEdits.set(k, [...(this.pendingEdits.get(k) ?? []), ...edits]);
        }
        this.scheduleQuick(doc, 120);
        if (doc.uri.scheme === 'file' && cfg().get<boolean>('lint.onType', true)) {
            this.deepDoc = doc.uri;
            this.scheduleDeep(cfg().get<number>('lint.delay', 1500));
        }
    }

    private onSave(doc: vscode.TextDocument): void {
        if (!isPawnDoc(doc) || doc.uri.scheme !== 'file') return;
        this.index.invalidate();
        this.builder.invalidateResolve();
        this.scheduleQuick(doc, 0);
        if (cfg().get<boolean>('lintOnSave', true)) {
            this.deepDoc = doc.uri;
            this.scheduleDeep(100);
        }
    }

    // ───────────────────────── quick analysis ─────────────────────────

    private scheduleQuick(doc: vscode.TextDocument, delay: number): void {
        const k = doc.uri.toString();
        const timer = this.quickTimers.get(k);
        if (timer) clearTimeout(timer);
        this.quickTimers.set(
            k,
            setTimeout(() => {
                this.quickTimers.delete(k);
                this.runQuick(doc).catch((e) => this.pawn.output.appendLine(t('quick analysis: {0}', e?.stack ?? e)));
            }, delay),
        );
    }

    async runQuick(doc: vscode.TextDocument): Promise<void> {
        if (doc.isClosed) return;
        if (!cfg().get<boolean>('lint.quick', true)) {
            this.quick.delete(doc.uri);
            return;
        }
        const version = doc.version;
        const data = await this.index.lintData(doc);
        if (doc.isClosed || doc.version !== version) return; // a new edit arrived: another round is already scheduled
        const src = doc.getText();
        const isFile = doc.uri.scheme === 'file';
        const entryDir = data.entry ? path.dirname(data.entry) : path.dirname(doc.fileName);
        const docWords = isFile ? this.index.fileWords(doc.fileName)?.words : undefined;
        const args = this.pawn.compilerArgs();
        const ctx = makeContext({
            src,
            own: parseSymbols(src, { locals: true }),
            external: data.external,
            excludeFile: isFile ? doc.fileName : undefined,
            inOtherFiles: (n) => (data.wordFiles.get(n) ?? 0) - (docWords?.has(n) ? 1 : 0) > 0,
            includeExists: (name, style) => !isFile || !!this.pawn.graph.resolveInclude({ name, style }, doc.fileName, entryDir),
            semicolonRequired: args.includes('-;+') || data.pragmaSemicolon || /^[ \t]*#[ \t]*pragma[ \t]+semicolon[ \t]+1/m.test(src),
            knownGood: this.knownGood,
        });
        const issues = quickLint(src, ctx);
        // Do not duplicate what pawncc is already showing on the same line
        const deepLines = new Set((this.pawn.diagnostics.get(doc.uri) ?? []).flatMap((d) => [d.range.start.line, d.range.start.line - 1]));
        const diags = issues
            .filter((i) => !deepLines.has(i.line))
            .map((i) => {
                const lineLen = i.line < doc.lineCount ? doc.lineAt(i.line).text.length : i.endCol;
                const range = new vscode.Range(i.line, Math.min(i.col, lineLen), i.line, Math.max(Math.min(i.endCol, lineLen), Math.min(i.col, lineLen)));
                const d = new vscode.Diagnostic(range, i.message, i.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                d.source = 'pawn';
                d.code = i.code;
                return d;
            });
        this.quick.set(doc.uri, diags);
    }

    // ───────────────────────── background pawncc ─────────────────────────

    private scheduleDeep(delay: number): void {
        if (this.deepTimer) clearTimeout(this.deepTimer);
        this.deepTimer = setTimeout(() => {
            this.deepTimer = undefined;
            this.runDeep().catch((e) => {
                this.pawn.output.appendLine(t('background check: {0}', e?.stack ?? e));
                this.deepRunning = false;
                this.setStatus('idle');
            });
        }, delay);
    }

    private shadowFor(root: string): ShadowTree {
        const k = pathKey(root);
        let s = this.shadows.get(k);
        if (!s) {
            s = new ShadowTree(root);
            this.shadows.set(k, s);
        }
        return s;
    }

    async runDeep(): Promise<void> {
        if (this.deepRunning) {
            this.deepQueued = true; // let the current run finish, then run again with the latest text
            return;
        }
        if (this.builder.isCompiling) {
            this.scheduleDeep(2000);
            return;
        }
        const uri = this.deepDoc ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'file') return;
        const r = await this.builder.resolve(uri.fsPath);
        if (!('target' in r)) return;
        const target = r.target;

        this.deepRunning = true;
        this.pendingEdits.clear();
        const started = Date.now();
        let finished = false;
        this.setStatus('running', started, path.basename(target.entry));
        try {
            const graph = this.pawn.graph;
            this.pawn.syncGraphIncludes(target.entry);
            const includeDirs = this.pawn.includeDirs(target.entry);
            const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && isPawnDoc(d));
            const overlays = new Map(dirty.map((d) => [d.fileName, d.getText()]));

            let shadow: { entry: string; includeDirs: string[]; unmap: (p: string) => string } | undefined;
            if (overlays.size) {
                const closure = [...graph.closure(target.entry).values()];
                const projectRoot = this.pawn.projectRoot() ?? path.dirname(target.entry);
                const external = includeDirs.filter((d) => !pathKey(d).startsWith(pathKey(projectRoot)));
                const local = closure.filter((f) => !external.some((d) => pathKey(f).startsWith(pathKey(d))));
                const root = commonAncestor([target.entry, ...local, ...overlays.keys()]);
                if (!root || path.parse(root).root === root) {
                    // files spread across different drives: no shadow copy, only quick analysis until saved
                    return;
                }
                const tree = this.shadowFor(root);
                const files = new Set(local);
                // newly typed (still unsaved) includes must also go into the copy
                for (const [f, txt] of overlays) {
                    for (const m of txt.matchAll(/^[ \t]*#[ \t]*(?:try)?include[ \t]*(?:<([^>\r\n]+)>|"([^"\r\n]+)"|(\S+))/gm)) {
                        const name = (m[1] ?? m[2] ?? m[3]).trim();
                        const res = graph.resolveInclude({ name, style: m[1] ? 'angle' : m[2] ? 'quote' : 'bare' }, f, path.dirname(target.entry));
                        if (res) for (const x of graph.closure(res).values()) files.add(x);
                    }
                }
                tree.sync(files, overlays);
                shadow = {
                    entry: tree.map(target.entry),
                    includeDirs: includeDirs.map((d) => (tree.contains(d) ? tree.map(d) : d)),
                    unmap: (p) => tree.unmap(p),
                };
            }

            const res = await this.builder.compile(target, { background: true, quiet: true, publish: false, shadow });
            if (!res) return; // cancelled (a manual compile started) — the queue reschedules

            // Publish, adjusting for edits made during compilation
            this.pawn.diagnostics.clear();
            for (const { uri: u, items } of toVsDiagnostics(res.diags).values()) {
                const edits = this.pendingEdits.get(u.toString());
                this.pawn.diagnostics.set(u, edits ? shiftDiagnostics(items, edits) : items);
            }
            // Learn names quick analysis did not know but pawncc accepted (macro-generated)
            if (res.ok) {
                for (const list of this.collectQuick()) {
                    for (const d of list) {
                        if (d.code !== 'QL-undefined') continue;
                        const m = /"([^"]+)"/.exec(d.message);
                        if (m) this.knownGood.add(m[1]);
                    }
                }
            }
            this.setStatus('done', started, path.basename(target.entry), res.errors, res.warnings);
            finished = true;
            this.refreshVisible();
        } finally {
            if (!finished) this.setStatus('idle');
            this.deepRunning = false;
            this.pendingEdits.clear();
            if (this.deepQueued) {
                this.deepQueued = false;
                this.scheduleDeep(300);
            }
        }
    }

    private collectQuick(): Array<readonly vscode.Diagnostic[]> {
        const out: Array<readonly vscode.Diagnostic[]> = [];
        this.quick.forEach((_u, list) => out.push(list));
        return out;
    }

    // ───────────────────────── status ─────────────────────────

    private setStatus(state: 'running' | 'done' | 'idle', started = 0, name = '', errors = 0, warnings = 0): void {
        if (this.statusTimer) clearInterval(this.statusTimer);
        this.statusTimer = undefined;
        if (state === 'idle') {
            this.status.hide();
            return;
        }
        if (state === 'running') {
            const tick = () => {
                const s = Math.round((Date.now() - started) / 1000);
                this.status.text = `$(sync~spin) pawncc ${s}s`;
            };
            tick();
            this.status.tooltip = `${t('Checking {0} with pawncc in the background (includes unsaved text).', name)}\n${t('Quick analysis already shows common errors meanwhile.')}`;
            this.status.command = 'pawnStudio.showOutput';
            this.status.show();
            this.statusTimer = setInterval(tick, 1000);
            return;
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        this.status.text = errors ? `$(error) ${errors} · pawncc ${secs}s` : warnings ? `$(warning) ${warnings} · pawncc ${secs}s` : `$(check) pawncc ${secs}s`;
        this.status.tooltip = `${name}: ${t('{0} error(s), {1} warning(s)', errors, warnings)} — ${t('full check in {0}s', secs)}`;
        this.status.command = 'workbench.actions.view.problems';
        this.status.show();
        this.statusTimer = setTimeout(() => this.status.hide(), 8000) as unknown as NodeJS.Timeout;
    }
}
