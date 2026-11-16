/**
 * Shared extension state + configuration helpers.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { autoIncludeDirs, findCompiler } from './compiler';
import { IncludeGraph } from './includeGraph';
import { GitHub } from './packages/github';
import { PackageManager, STDLIBS } from './packages/manager';
import { CompileProfile, findServer, MANIFEST, PawnJson as PawnJsonType, readManifest, ServerInfo } from './packages/manifest';

export const PAWN_EXT = /\.(pwn|inc|p)$/i;
export const SECTION = 'pawnStudio';

export function cfg(uri?: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION, uri);
}

export function baseFolder(uri?: vscode.Uri): string | undefined {
    const f = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
    return f?.uri.fsPath;
}

/** Expands ${workspaceFolder} and ~, and resolves paths relative to the workspace folder. */
export function expandPath(p: string, uri?: vscode.Uri): string {
    const base = baseFolder(uri) ?? '';
    let s = p.trim().replace(/\$\{workspaceFolder\}/g, base);
    if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
    return path.isAbsolute(s) ? path.normalize(s) : path.resolve(base, s);
}

export function rel(p: string): string {
    return vscode.workspace.asRelativePath(p, false);
}

/** An output channel that also reports what is written to it. */
function mirror(inner: vscode.OutputChannel, emit: (text: string) => void): vscode.OutputChannel {
    return {
        name: inner.name,
        append: (v: string) => { inner.append(v); emit(v); },
        appendLine: (v: string) => { inner.appendLine(v); emit(v + '\n'); },
        replace: (v: string) => inner.replace(v),
        clear: () => inner.clear(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        show: (a?: any, b?: boolean) => (inner.show as (x?: any, y?: boolean) => void)(a, b),
        hide: () => inner.hide(),
        dispose: () => inner.dispose(),
    } as vscode.OutputChannel;
}

export class Pawn {
    readonly graph = new IncludeGraph();
/** The output channel itself: what the extension writes here does not go to the Pawn Studio panel. */
    readonly rawOutput = vscode.window.createOutputChannel('Pawn Studio');
    private _onLog = new vscode.EventEmitter<string>();
    /** Text written to `output` (packages, messages): mirrored in the Pawn Studio panel. */
    readonly onLog = this._onLog.event;
    readonly output: vscode.OutputChannel = mirror(this.rawOutput, (s) => this._onLog.fire(s));
    readonly diagnostics = vscode.languages.createDiagnosticCollection('pawncc');
    readonly runtimeDiagnostics = vscode.languages.createDiagnosticCollection('pawn-runtime');
    readonly github: GitHub;

    private _projectRoot: string | undefined;
    private _onDidChangeProject = new vscode.EventEmitter<void>();
    /** pawn.json / pawn-lock.json / settings changed. */
    readonly onDidChangeProject = this._onDidChangeProject.event;
    private _onDidChangeProfile = new vscode.EventEmitter<void>();
    /** The active compile profile changed. */
    readonly onDidChangeProfile = this._onDidChangeProfile.event;
    /** profile for the next compilation only ("Compile with profile…") */
    profileOverride: string | undefined;

    constructor(readonly ctx: vscode.ExtensionContext) {
        this.github = new GitHub(() => this.githubToken(false));
        ctx.subscriptions.push(this._onDidChangeProfile, this.rawOutput, this._onLog, this.diagnostics, this.runtimeDiagnostics, this._onDidChangeProject);
    }

    fireProjectChanged(): void {
        this._projectRoot = undefined;
        this._onDidChangeProject.fire();
    }

    async githubToken(interactive: boolean): Promise<string | undefined> {
        try {
            const s = await vscode.authentication.getSession('github', ['read:user'], interactive ? { createIfNone: true } : { silent: true });
            return s?.accessToken;
        } catch {
            return undefined;
        }
    }

    /** Folder containing pawn.json (or the first workspace folder, where it would be created). */
    projectRoot(): string | undefined {
        if (this._projectRoot) return this._projectRoot;
        for (const f of vscode.workspace.workspaceFolders ?? []) {
            if (fs.existsSync(path.join(f.uri.fsPath, MANIFEST))) return (this._projectRoot = f.uri.fsPath);
        }
        // pawn.json one level up (e.g. workspace opened at gamemodes/)
        for (const f of vscode.workspace.workspaceFolders ?? []) {
            const up = path.dirname(f.uri.fsPath);
            if (fs.existsSync(path.join(up, MANIFEST))) return (this._projectRoot = up);
        }
        const server = this.server();
        return (this._projectRoot = server?.dir ?? baseFolder());
    }

    server(): ServerInfo | undefined {
        const explicit = cfg().get<string>('server.path');
        const start = baseFolder();
        if (!start && !explicit) return undefined;
        return findServer(start ?? '', explicit ? expandPath(explicit) : undefined);
    }

    private rawCompiler(): NonNullable<PawnJsonType['compiler']> | undefined {
        const root = this.projectRoot();
        try {
            return root ? readManifest(root)?.compiler : undefined;
        } catch {
            return undefined;
        }
    }

    /** Compile profiles of pawn.json (compiler.profiles), by name. */
    profiles(): Record<string, CompileProfile> {
        const p = this.rawCompiler()?.profiles;
        return p && typeof p === 'object' ? p : {};
    }

    /** The profile compilations use: the one chosen in the editor, else compiler.profile, else the first. */
    activeProfile(): string | undefined {
        const names = Object.keys(this.profiles());
        if (!names.length) return undefined;
        if (this.profileOverride && names.includes(this.profileOverride)) return this.profileOverride;
        const chosen = this.ctx.workspaceState.get<string>('pawnStudio.profile');
        if (chosen && names.includes(chosen)) return chosen;
        const def = this.rawCompiler()?.profile;
        return def && names.includes(def) ? def : names[0];
    }

    async setActiveProfile(name: string): Promise<void> {
        await this.ctx.workspaceState.update('pawnStudio.profile', name);
        this._onDidChangeProfile.fire();
    }

    /** "compiler" from the project's pawn.json, with paths resolved against the project folder. */
    projectCompiler(): { path?: string; args?: string[]; includes: string[]; outputDir?: string; profile?: string } {
        const root = this.projectRoot();
        const c = this.rawCompiler() as { path?: unknown; args?: unknown; includes?: unknown } | undefined;
        const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root!, p));
        const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
        const base = {
            path: typeof c?.path === 'string' && c.path ? abs(c.path) : undefined,
            args: Array.isArray(c?.args) ? c!.args.map(String) : undefined,
            includes: strings(c?.includes).map(abs),
        };
        // the active profile changes args / defines / includes / output folder
        const name = this.activeProfile();
        const p = name ? this.profiles()[name] : undefined;
        if (!p) return base;
        let args = Array.isArray(p.args) ? p.args.map(String) : base.args;
        const defines = Object.entries(p.defines ?? {})
            .filter(([, v]) => v !== false && v !== undefined && v !== null)
            .map(([k, v]) => (v === true ? `${k}=1` : `${k}=${v}`));
        if (defines.length) args = [...(args ?? cfg().get<string[]>('args') ?? []), ...defines];
        return {
            ...base,
            args,
            includes: [...base.includes, ...strings(p.includes).map(abs)],
            outputDir: typeof p.outputDir === 'string' && p.outputDir ? abs(p.outputDir) : undefined,
            profile: name,
        };
    }

    /** pawncc arguments: pawn.json "compiler.args", else the pawnStudio.args setting. */
    compilerArgs(): string[] {
        return this.projectCompiler().args ?? cfg().get<string[]>('args') ?? [];
    }

    compilerPath(entry?: string): string | undefined {
        const project = this.projectCompiler().path;
        if (project) return findCompiler(project, []);
        const configured = cfg().get<string>('compilerPath');
        const starts = entry ? [path.dirname(entry)] : [];
        for (const f of vscode.workspace.workspaceFolders ?? []) starts.push(f.uri.fsPath);
        return findCompiler(configured ? expandPath(configured) : undefined, starts);
    }

    packages(): PackageManager | undefined {
        const root = this.projectRoot();
        if (!root) return undefined;
        const compiler = this.compilerPath();
        // If pawno/include with a_samp already exists, do not download the stdlib as a transitive dependency.
        const localStd = compiler && autoIncludeDirs(compiler, compiler).some((d) => fs.existsSync(path.join(d, 'a_samp.inc')));
        return new PackageManager(this.github, {
            root,
            server: this.server(),
            skipTransitive: localStd ? STDLIBS : [],
            copyIncludesTo: cfg().get<boolean>('packages.copyIncludes', true) ? undefined : false,
            log: (m) => this.output.appendLine(m),
        });
    }

    manifestEntry(): { entry?: string; output?: string } {
        const root = this.projectRoot();
        let m: ReturnType<typeof readManifest>;
        try {
            m = root ? readManifest(root) : undefined;
        } catch {
            m = undefined; // reported by the Packages view
        }
        return {
            entry: m?.entry && root ? path.resolve(root, m.entry) : undefined,
            output: m?.output && root ? path.resolve(root, m.output) : undefined,
        };
    }

    /** Include folders in order: configured → packages → automatic (pawno/include). */
    includeDirs(entry?: string): string[] {
        const configured = [...this.projectCompiler().includes, ...(cfg().get<string[]>('includePaths') ?? []).filter(Boolean).map((p) => expandPath(p))];
        let pkgs: string[] = [];
        try {
            pkgs = this.packages()?.includeDirs() ?? [];
        } catch {
            pkgs = [];
        }
        const compiler = this.compilerPath(entry);
        const auto = autoIncludeDirs(compiler, entry ?? compiler ?? baseFolder() ?? '');
        return [...new Set([...configured, ...pkgs, ...auto])];
    }

    syncGraphIncludes(entry?: string): void {
        this.graph.setIncludePaths(this.includeDirs(entry));
    }
}
