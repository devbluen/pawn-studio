/**
 * Target discovery (gamemode/filterscript) and compilation.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AmxSizes, parseSizes } from './compiler';
import { parseOutput, PawnDiagnostic, runCompiler } from './compiler';
import { baseFolder, cfg, expandPath, Pawn, PAWN_EXT, rel } from './context';
import { t } from './i18n';
import { EntryKind, pathKey } from './includeGraph';

export interface Target {
    entry: string;
    kind: EntryKind;
    reason: string;
}

export type Resolution = { target: Target } | { ambiguous: string[] } | { none: true };

export interface CompileResult {
    target: Target;
    ok: boolean;
    errors: number;
    warnings: number;
    diags: PawnDiagnostic[];
    /** raw pawncc output */
    output: string;
    durationMs: number;
    at: Date;
    amx: string;
    amxSize?: number;
    /** memory summary printed by pawncc */
    sizes?: AmxSizes;
    compiler: string;
    /** automatic check on save (does not produce the real .amx) */
    background: boolean;
    exitCode: number | null;
}

export interface CompileJobInfo {
    target: Target;
    compiler: string;
    commandLine: string;
    includeDirs: string[];
    output: string;
}

const CHOICES_KEY = 'pawnStudio.choices';
const LAST_KEY = 'pawnStudio.lastTarget';

export function kindLabel(k: EntryKind): string {
    return k === 'gamemode' ? 'Gamemode' : k === 'filterscript' ? 'Filterscript' : 'Script';
}

export function kindShort(k: EntryKind): string {
    return k === 'gamemode' ? 'GM' : k === 'filterscript' ? 'FS' : 'AMX';
}

export class Builder {
    private pwnFilesCache: string[] | undefined;
    private running: { kill: () => void; background: boolean } | undefined;
    private _last: CompileResult | undefined;
    private _onDidCompile = new vscode.EventEmitter<CompileResult>();
    readonly onDidCompile = this._onDidCompile.event;
    private _onDidStart = new vscode.EventEmitter<Target>();
    readonly onDidStart = this._onDidStart.event;
    private _onDidStartJob = new vscode.EventEmitter<CompileJobInfo>();
    /** A real (not background) compilation started: what runs and how. */
    readonly onDidStartJob = this._onDidStartJob.event;

    constructor(private pawn: Pawn) {
        pawn.ctx.subscriptions.push(this._onDidCompile, this._onDidStart, this._onDidStartJob);
    }

    get last(): CompileResult | undefined {
        return this._last;
    }

    get isCompiling(): boolean {
        return !!this.running && !this.running.background;
    }

    invalidate(): void {
        this.pwnFilesCache = undefined;
        this.pawn.graph.invalidateResolution();
        this.resolveCache.clear();
    }

    /** Includes may have changed (file saved): recompute targets on the next query. */
    invalidateResolve(): void {
        this.resolveCache.clear();
    }

    private resolveCache = new Map<string, Promise<Resolution>>();

    // ───────────────────────── discovery ─────────────────────────

    async workspacePwnFiles(): Promise<string[]> {
        if (this.pwnFilesCache) return this.pwnFilesCache;
        const exclude = cfg().get<string>('entryExclude') || undefined;
        const uris = await vscode.workspace.findFiles('**/*.pwn', exclude, 5000);
        const files = uris.map((u) => u.fsPath);
        const me = this.pawn.manifestEntry().entry;
        if (me && fs.existsSync(me) && !files.some((f) => pathKey(f) === pathKey(me))) files.push(me);
        this.pwnFilesCache = files;
        return files;
    }

    async roots() {
        const files = await this.workspacePwnFiles();
        const hint = this.pawn.manifestEntry().entry ?? files.find((f) => /[\\/]gamemodes[\\/]/i.test(f)) ?? files[0];
        this.pawn.syncGraphIncludes(hint);
        return this.pawn.graph.findRoots(files);
    }

    makeTarget(entry: string, reason: string): Target {
        return { entry: path.resolve(entry), kind: this.pawn.graph.kind(entry), reason };
    }

    private choices(): Record<string, string> {
        return this.pawn.ctx.workspaceState.get<Record<string, string>>(CHOICES_KEY) ?? {};
    }

    async rememberChoice(file: string, entry: string): Promise<void> {
        const c = this.choices();
        c[pathKey(file)] = entry;
        await this.pawn.ctx.workspaceState.update(CHOICES_KEY, c);
        this.resolveCache.clear();
    }

    async clearChoices(): Promise<void> {
        await this.pawn.ctx.workspaceState.update(CHOICES_KEY, {});
        this.resolveCache.clear();
    }

    /** Same as resolveUncached, but reuses the result until something changes (save, file creation, settings). */
    resolve(file: string | undefined): Promise<Resolution> {
        const key = file ? pathKey(file) : '';
        let p = this.resolveCache.get(key);
        if (!p) {
            p = this.resolveUncached(file);
            this.resolveCache.set(key, p);
            p.catch(() => this.resolveCache.delete(key));
        }
        return p;
    }

    /**
     * Order: pinned target → // @entry directive → the file is an entry file → entry files that include it
     * (1 → that one; several → remembered choice) → orphan: last target / pawn.json entry / single gamemode.
     */
    private async resolveUncached(file: string | undefined): Promise<Resolution> {
        const graph = this.pawn.graph;
        const pinned = cfg().get<string>('entry');
        if (pinned) {
            const p = expandPath(pinned);
            if (fs.existsSync(p)) return { target: this.makeTarget(p, t('target pinned in settings')) };
        }
        if (file) {
            const info = graph.info(file);
            if (info?.directive) {
                const p = path.resolve(path.dirname(file), info.directive);
                if (fs.existsSync(p)) return { target: this.makeTarget(p, t('@entry directive in the file')) };
            }
        }

        const { roots, closures } = await this.roots();
        const rootKeys = new Set(roots.map(pathKey));

        if (file) {
            const fk = pathKey(file);
            if (rootKeys.has(fk)) return { target: this.makeTarget(file, t('is the entry file')) };
            const owners = roots.filter((r) => closures.get(pathKey(r))?.has(fk));
            if (owners.length === 1) return { target: this.makeTarget(owners[0], t('included by {0}', path.basename(owners[0]))) };
            if (owners.length > 1) {
                const chosen = this.choices()[fk];
                if (chosen && owners.some((o) => pathKey(o) === pathKey(chosen))) {
                    return { target: this.makeTarget(chosen, t('remembered choice (file included by several entry files)')) };
                }
                return { ambiguous: owners };
            }
        }

        const last = this.pawn.ctx.workspaceState.get<string>(LAST_KEY);
        if (last && rootKeys.has(pathKey(last))) return { target: this.makeTarget(last, t('not included by any file — last target')) };
        const me = this.pawn.manifestEntry().entry;
        if (me && rootKeys.has(pathKey(me))) return { target: this.makeTarget(me, t('pawn.json entry')) };
        const gms = roots.filter((r) => graph.kind(r) === 'gamemode');
        if (gms.length === 1) return { target: this.makeTarget(gms[0], t('not included by any file — only gamemode')) };
        if (roots.length === 1) return { target: this.makeTarget(roots[0], t('not included by any file — only entry file')) };
        if (roots.length > 1) return { ambiguous: roots };
        return { none: true };
    }

    async pickEntry(options: string[], title: string): Promise<string | undefined> {
        const items = options
            .map((e) => {
                const k = this.pawn.graph.kind(e);
                return {
                    label: `${k === 'filterscript' ? '$(extensions)' : '$(globe)'} ${path.basename(e)}`,
                    description: kindLabel(k),
                    detail: rel(e),
                    entry: e,
                    entryKind: k,
                };
            })
            .sort((a, b) => (a.entryKind === b.entryKind ? a.detail.localeCompare(b.detail) : a.entryKind === 'gamemode' ? -1 : 1));
        const pick = await vscode.window.showQuickPick(items, { title, placeHolder: t('Which entry file should be compiled?') });
        return pick?.entry;
    }

    async resolveInteractive(file: string | undefined): Promise<Target | undefined> {
        const r = await this.resolve(file);
        if ('target' in r) return r.target;
        if ('ambiguous' in r) {
            const title = file ? t('{0} is included by more than one entry file', path.basename(file)) : t('Choose the target');
            const chosen = await this.pickEntry(r.ambiguous, title);
            if (!chosen) return undefined;
            if (file) await this.rememberChoice(file, chosen);
            return this.makeTarget(chosen, t('chosen now'));
        }
        vscode.window.showWarningMessage(t('Pawn: no gamemode/filterscript found (.pwn file with main() or #define FILTERSCRIPT).'));
        return undefined;
    }

    async setLastTarget(entry: string): Promise<void> {
        if (this.pawn.ctx.workspaceState.get(LAST_KEY) === entry) return;
        await this.pawn.ctx.workspaceState.update(LAST_KEY, entry);
        this.resolveCache.clear();
    }

    // ───────────────────────── compilation ─────────────────────────

    async saveDirty(): Promise<void> {
        const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled && PAWN_EXT.test(d.fileName));
        await Promise.all(dirty.map((d) => d.save()));
    }

    outputFor(entry: string): string {
        const me = this.pawn.manifestEntry();
        if (me.entry && me.output && pathKey(me.entry) === pathKey(entry)) return me.output;
        const outDirSetting = cfg().get<string>('outputDirectory');
        const outDir = outDirSetting ? expandPath(outDirSetting) : path.dirname(entry);
        return path.join(outDir, path.basename(entry).replace(/\.[^.]+$/, '') + '.amx');
    }

    /**
     * Compiles a target. `background` = check on save: writes the .amx to a temp folder,
     * shows no notifications and is cancelled if the user requests a real compilation.
     */
    async compile(
        target: Target,
        opts: {
            clearDiagnostics?: boolean;
            quiet?: boolean;
            background?: boolean;
            /** false = do not publish diagnostics (the caller publishes them, e.g. live check) */
            publish?: boolean;
            /** compiles a shadow copy (unsaved text) and maps back to the real paths */
            shadow?: { entry: string; includeDirs: string[]; unmap: (p: string) => string };
        } = {},
    ): Promise<CompileResult | undefined> {
        const pawn = this.pawn;
        const background = !!opts.background;
        if (background && this.running && !this.running.background) return undefined;

        const compiler = pawn.compilerPath(target.entry);
        if (!compiler) {
            if (background) return undefined;
            const configured = pawn.projectCompiler().path ?? cfg().get<string>('compilerPath');
            const msg = configured
                ? t('Pawn: pawncc not found at "{0}".', configured)
                : t('Pawn: pawncc not found (searched pawno/, qawno/ and PATH).');
            const action = await vscode.window.showErrorMessage(msg, t('Configure path'));
            if (action) vscode.commands.executeCommand('workbench.action.openSettings', 'pawnStudio.compilerPath');
            return undefined;
        }

        let outFile = this.outputFor(target.entry);
        if (background) {
            const tmp = path.join(os.tmpdir(), 'pawn-studio');
            fs.mkdirSync(tmp, { recursive: true });
            outFile = path.join(tmp, `${path.basename(outFile, '.amx')}-${process.pid}.amx`);
        } else {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
        }
        const includeDirs = opts.shadow?.includeDirs ?? pawn.includeDirs(target.entry);
        const compileEntry = opts.shadow?.entry ?? target.entry;
        let args = pawn.compilerArgs();
        // The check does not need debug information.
        if (background) args = args.filter((a) => !/^-d\d$/.test(a));

        this.running?.kill();
        if (!background) this._onDidStart.fire(target);
        const job = runCompiler({ compiler, entry: compileEntry, output: outFile, includeDirs, args });
        const handle = { kill: job.kill, background };
        this.running = handle;

        // the compile log goes to the output channel only: the Pawn Studio panel shows it as a card
        const log = pawn.rawOutput;
        if (!background) {
            this._onDidStartJob.fire({ target, compiler, commandLine: job.commandLine, includeDirs, output: outFile });
            log.appendLine('');
            log.appendLine(`[${new Date().toLocaleTimeString()}] ${t('Compiling {0} {1}  ({2})', kindLabel(target.kind).toLowerCase(), rel(target.entry), target.reason)}`);
            log.appendLine(`> ${job.commandLine}`);
        }
        let res;
        try {
            res = await job.promise;
        } catch (e) {
            if (!background) {
                log.appendLine(t('Failed to run pawncc: {0}', String(e)));
                log.show(true);
            }
            return undefined;
        } finally {
            if (this.running === handle) this.running = undefined;
        }
        if (res.killed) return undefined;

        if (!background) log.append(res.output.endsWith('\n') ? res.output : res.output + '\n');
        const unmap = opts.shadow?.unmap ?? ((p: string) => p);
        const diags = parseOutput(res.output, path.dirname(compileEntry)).map((d) => ({ ...d, file: unmap(d.file) }));
        const errors = diags.filter((d) => d.severity !== 'warning').length;
        const warnings = diags.length - errors;
        const ok = errors === 0 && res.exitCode === 0;

        if (opts.publish !== false) {
            if (opts.clearDiagnostics !== false) pawn.diagnostics.clear();
            for (const { uri, items } of toVsDiagnostics(diags).values()) {
                pawn.diagnostics.set(uri, [...(pawn.diagnostics.get(uri) ?? []), ...items]);
            }
        }

        let amxSize: number | undefined;
        try {
            amxSize = ok ? fs.statSync(outFile).size : undefined;
        } catch {
            amxSize = undefined;
        }
        if (background) fs.rmSync(outFile, { force: true });

        const result: CompileResult = {
            target,
            ok,
            errors,
            warnings,
            diags,
            output: res.output,
            durationMs: res.durationMs,
            at: new Date(),
            amx: background ? this.outputFor(target.entry) : outFile,
            amxSize,
            sizes: ok ? parseSizes(res.output) : undefined,
            compiler,
            background,
            exitCode: res.exitCode,
        };
        this._last = result;
        this._onDidCompile.fire(result);

        if (background) return result;

        const secs = (res.durationMs / 1000).toFixed(2);
        log.appendLine(
            ok
                ? `✔ ${t('{0} built in {1}s — {2} warning(s) → {3}', path.basename(outFile), secs, warnings, rel(outFile))}`
                : `✖ ${t('Failed in {0}s — {1} error(s), {2} warning(s) (code {3})', secs, errors, warnings, String(res.exitCode))}`,
        );

        if (!opts.quiet) {
            if (ok) {
                const w = warnings ? ` — ${t('{0} warning(s)', warnings)}` : '';
                vscode.window.setStatusBarMessage(`$(check) ${t('{0} compiled in {1}s', path.basename(outFile), secs)}${w}`, 6000);
            } else {
                const showProblems = t('Show problems');
                const showOutput = t('Show details');
                vscode.window
                    .showErrorMessage(t('{0}: {1} error(s), {2} warning(s).', path.basename(target.entry), errors, warnings), showProblems, showOutput)
                    .then((a) => {
                        if (a === showProblems) vscode.commands.executeCommand('workbench.actions.view.problems');
                        if (a === showOutput) vscode.commands.executeCommand('pawnStudio.console.focus');
                    });
            }
        }
        return result;
    }

    /**
     * Is the .amx of a target older than its sources? `changed` = the first file edited after the last
     * build (or unsaved), "missing" when there is no .amx yet; undefined = up to date.
     */
    staleness(target: Target): { amx: string; builtAt?: Date; changed?: string } {
        const amx = this.outputFor(target.entry);
        let built: number;
        try {
            built = fs.statSync(amx).mtimeMs;
        } catch {
            return { amx, changed: 'missing' };
        }
        this.pawn.syncGraphIncludes(target.entry);
        const files = [target.entry, ...this.pawn.graph.closure(target.entry).values()];
        const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.fsPath.toLowerCase()));
        for (const f of files) {
            if (dirty.has(f.toLowerCase())) return { amx, builtAt: new Date(built), changed: f };
            try {
                if (fs.statSync(f).mtimeMs > built + 1) return { amx, builtAt: new Date(built), changed: f };
            } catch {
                /* a missing include is pawncc's to report */
            }
        }
        // pawn.json (compiler args, packages) or the settings file changed after the build
        for (const f of ['pawn.json', 'pawn-lock.json']) {
            const p = this.pawn.projectRoot() ? path.join(this.pawn.projectRoot()!, f) : undefined;
            try {
                if (p && fs.statSync(p).mtimeMs > built + 1) return { amx, builtAt: new Date(built), changed: p };
            } catch {
                /* not there */
            }
        }
        return { amx, builtAt: new Date(built) };
    }

    withProgress<T>(title: string, fn: () => Promise<T>): Thenable<T> {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);
    }

    // ───────────────────────── commands ─────────────────────────

    async compileActive(file: string | undefined): Promise<CompileResult | undefined> {
        if (cfg().get<boolean>('saveBeforeCompile')) await this.saveDirty();
        const target = await this.resolveInteractive(file);
        if (!target) return undefined;
        await this.setLastTarget(target.entry);
        return this.withProgress(`$(sync~spin) ${t('Compiling {0}…', path.basename(target.entry))}`, () => this.compile(target));
    }

    async compileFileDirect(file: string): Promise<void> {
        if (cfg().get<boolean>('saveBeforeCompile')) await this.saveDirty();
        this.pawn.syncGraphIncludes(file);
        await this.withProgress(`$(sync~spin) ${t('Compiling {0}…', path.basename(file))}`, () =>
            this.compile(this.makeTarget(file, t('direct file compilation'))),
        );
    }

    async compileAll(): Promise<void> {
        if (cfg().get<boolean>('saveBeforeCompile')) await this.saveDirty();
        const { roots } = await this.roots();
        if (!roots.length) {
            vscode.window.showWarningMessage(t('Pawn: no gamemode/filterscript found.'));
            return;
        }
        const graph = this.pawn.graph;
        const sorted = roots.sort((a, b) => (graph.kind(a) === 'gamemode' ? -1 : 0) - (graph.kind(b) === 'gamemode' ? -1 : 0));
        this.pawn.diagnostics.clear();
        let failed = 0;
        let warnings = 0;
        await this.withProgress(`$(sync~spin) ${t('Compiling all…')}`, async () => {
            for (const r of sorted) {
                const res = await this.compile(this.makeTarget(r, t('compile all')), { clearDiagnostics: false, quiet: true });
                if (!res || !res.ok) failed++;
                warnings += res?.warnings ?? 0;
            }
        });
        if (failed) {
            const a = await vscode.window.showErrorMessage(t('Pawn: {0} of {1} failed.', failed, sorted.length), t('Show problems'));
            if (a) vscode.commands.executeCommand('workbench.actions.view.problems');
        } else {
            vscode.window.setStatusBarMessage(`$(check) ${t('{0} script(s) compiled — {1} warning(s)', sorted.length, warnings)}`, 6000);
        }
    }

    async selectTarget(): Promise<void> {
        const { roots } = await this.roots();
        const items = [
            ...roots.map((e) => ({
                label: `${this.pawn.graph.kind(e) === 'filterscript' ? '$(extensions)' : '$(globe)'} ${path.basename(e)}`,
                description: kindLabel(this.pawn.graph.kind(e)),
                detail: rel(e),
                entry: e,
            })),
            { label: `$(file) ${t('Browse for file...')}`, entry: '__browse__' },
        ];
        const pick = await vscode.window.showQuickPick(items, { title: t('Pin target: every file will compile this entry file') });
        if (!pick) return;
        let entry = pick.entry;
        if (entry === '__browse__') {
            const sel = await vscode.window.showOpenDialog({ filters: { Pawn: ['pwn'] }, canSelectMany: false });
            if (!sel?.length) return;
            entry = sel[0].fsPath;
        }
        const base = baseFolder();
        const value =
            base && pathKey(entry).startsWith(pathKey(base)) ? '${workspaceFolder}/' + path.relative(base, entry).replace(/\\/g, '/') : entry;
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await cfg().update('entry', value, target);
        vscode.window.showInformationMessage(t('Pawn: target pinned to {0}.', path.basename(entry)));
    }

    async clearTarget(): Promise<void> {
        await cfg().update('entry', undefined, vscode.ConfigurationTarget.Workspace);
        await cfg().update('entry', undefined, vscode.ConfigurationTarget.Global);
        await this.clearChoices();
        vscode.window.showInformationMessage(t('Pawn: target unpinned — back to automatic detection.'));
    }
}

export function toVsDiagnostics(list: PawnDiagnostic[]): Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }> {
    const byFile = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
    for (const d of list) {
        const range = new vscode.Range(d.line - 1, 0, d.endLine - 1, Number.MAX_SAFE_INTEGER);
        const sev = d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
        const diag = new vscode.Diagnostic(range, d.message, sev);
        diag.source = 'pawncc';
        diag.code = d.code;
        const k = pathKey(d.file);
        if (!byFile.has(k)) byFile.set(k, { uri: vscode.Uri.file(d.file), items: [] });
        byFile.get(k)!.items.push(diag);
    }
    return byFile;
}
