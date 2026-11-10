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
import { findServer, MANIFEST, readManifest, ServerInfo } from './packages/manifest';

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

    constructor(readonly ctx: vscode.ExtensionContext) {
        this.github = new GitHub(() => this.githubToken(false));
        ctx.subscriptions.push(this.rawOutput, this._onLog, this.diagnostics, this.runtimeDiagnostics, this._onDidChangeProject);
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

    compilerPath(entry?: string): string | undefined {
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
        const configured = (cfg().get<string[]>('includePaths') ?? []).filter(Boolean).map((p) => expandPath(p));
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
