import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Builder, kindLabel, kindShort } from './build';
import { cfg, Pawn, PAWN_EXT, rel } from './context';
import { PawnDebugSession } from './debug/adapter';
import { ErrorLens } from './errorLens';
import { setLanguage, t } from './i18n';
import { LiveChecker } from './liveCheck';
import { registerLanguageFeatures, SymbolIndex } from './language/features';
import { findServer, readServerPlugins } from './packages/manifest';
import { PackagesController } from './packages/ui';
import { CompileView, PackagesView, ServerView } from './views';

let builder: Builder | undefined;

export function activate(context: vscode.ExtensionContext): void {
    // Must run before anything builds user-visible text.
    setLanguage(context.extensionPath, cfg().get<string>('language'));
    const pawn = new Pawn(context);
    const b = new Builder(pawn);
    builder = b;
    const index = new SymbolIndex(pawn, b);
    const packages = new PackagesController(pawn);
    const compileView = new CompileView(pawn, b);
    const packagesView = new PackagesView(pawn, packages);
    const serverView = new ServerView(pawn);
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    const sub = context.subscriptions;

    // ───────────── context keys (welcome views, menus) ─────────────
    const updateContextKeys = () => {
        const pm = pawn.packages();
        vscode.commands.executeCommand('setContext', 'pawnStudio.hasManifest', !!pm && fs.existsSync(path.join(pm.root, 'pawn.json')));
        vscode.commands.executeCommand('setContext', 'pawnStudio.hasServer', !!pawn.server());
        vscode.commands.executeCommand('setContext', 'pawnStudio.hasCompiled', !!b.last);
        vscode.commands.executeCommand('setContext', 'pawnStudio.serverRunning', serverView.running);
    };

    // ───────────── status bar ─────────────
    let statusTimer: NodeJS.Timeout | undefined;
    const scheduleStatus = () => {
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => updateStatus().catch((e) => pawn.output.appendLine(String(e))), 250);
    };
    const updateStatus = async () => {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || doc.uri.scheme !== 'file' || !PAWN_EXT.test(doc.fileName)) {
            statusItem.hide();
            return;
        }
        const r = await b.resolve(doc.fileName);
        if ('target' in r) {
            const target = r.target;
            statusItem.text = `$(play) ${kindShort(target.kind)}: ${path.basename(target.entry)}`;
            statusItem.tooltip = new vscode.MarkdownString(
                `**Pawn** — ${kindLabel(target.kind)}\n\n\`${rel(target.entry)}\`\n\n_${target.reason}_\n\n${t('Click (or F5) to compile · F6 compiles and starts the server.')}`,
            );
            statusItem.command = 'pawnStudio.compile';
        } else if ('ambiguous' in r) {
            statusItem.text = `$(question) ${t('Pawn: {0} targets', r.ambiguous.length)}`;
            statusItem.tooltip = t('This file is included by more than one entry file. Click to choose.');
            statusItem.command = 'pawnStudio.compile';
        } else {
            statusItem.text = `$(warning) ${t('Pawn: no target')}`;
            statusItem.tooltip = t('No gamemode/filterscript found.');
            statusItem.command = 'pawnStudio.selectTarget';
        }
        statusItem.show();
    };

    // ───────────── live check (quick analysis + background pawncc) ─────────────
    const live = new LiveChecker(pawn, b, index);

    // ───────────── watchers ─────────────
    const structureChanged = () => {
        b.invalidate();
        index.invalidate();
        scheduleStatus();
        live.refreshVisible();
    };
    const projectChanged = () => {
        pawn.fireProjectChanged();
    };
    const pawnWatcher = vscode.workspace.createFileSystemWatcher('**/*.{pwn,inc,p}');
    const projWatcher = vscode.workspace.createFileSystemWatcher('**/{pawn.json,pawn-lock.json,server.cfg,config.json}');

    sub.push(
        statusItem,
        live,
        packages,
        pawnWatcher,
        projWatcher,
        pawnWatcher.onDidCreate(structureChanged),
        pawnWatcher.onDidDelete(structureChanged),
        projWatcher.onDidChange(projectChanged),
        projWatcher.onDidCreate(projectChanged),
        projWatcher.onDidDelete(projectChanged),
        pawn.onDidChangeProject(() => {
            structureChanged();
            packagesView.refresh();
            serverView.refresh();
            updateContextKeys();
        }),
        packages.onDidChange(() => packagesView.refresh()),
        b.onDidCompile((r) => {
            compileView.refresh();
            updateContextKeys();
            if (!r.background) scheduleStatus();
        }),
        vscode.workspace.onDidSaveTextDocument((d) => {
            if (!PAWN_EXT.test(d.fileName)) return;
            index.invalidate();
            b.invalidateResolve();
            scheduleStatus();
        }),
        vscode.window.onDidChangeActiveTextEditor(scheduleStatus),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pawnStudio.language')) {
                setLanguage(context.extensionPath, cfg().get<string>('language'));
                compileView.refresh();
                packagesView.refresh();
                serverView.refresh();
                live.refreshVisible();
            }
            if (e.affectsConfiguration('pawnStudio')) {
                pawn.fireProjectChanged();
                scheduleStatus();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => pawn.fireProjectChanged()),
        new ErrorLens(),
        ...registerLanguageFeatures(pawn, index),
        vscode.window.registerTreeDataProvider('pawnStudio.compile', compileView),
        vscode.window.registerTreeDataProvider('pawnStudio.packages', packagesView),
        vscode.window.registerTreeDataProvider('pawnStudio.server', serverView),
    );

    // ───────────── commands ─────────────
    const activeFile = () => {
        const doc = vscode.window.activeTextEditor?.document;
        return doc && doc.uri.scheme === 'file' ? doc.fileName : undefined;
    };
    type PkgNode = { pkgKey?: string; repoUrl?: string };
    const reg = (id: string, fn: (...a: any[]) => unknown) => sub.push(vscode.commands.registerCommand(id, fn));

    reg('pawnStudio.compile', () => b.compileActive(activeFile()));
    reg('pawnStudio.compileFile', () => {
        const f = activeFile();
        if (f) return b.compileFileDirect(f);
    });
    reg('pawnStudio.compileAll', () => b.compileAll());
    reg('pawnStudio.selectTarget', async () => {
        await b.selectTarget();
        scheduleStatus();
    });
    reg('pawnStudio.clearTarget', async () => {
        await b.clearTarget();
        scheduleStatus();
    });
    reg('pawnStudio.showOutput', () => pawn.output.show());

    reg('pawnStudio.packages.install', (arg?: string) => packages.install(typeof arg === 'string' ? arg : undefined));
    reg('pawnStudio.packages.installAll', () => packages.installAll());
    reg('pawnStudio.packages.update', (n?: PkgNode) => (n?.pkgKey ? packages.update([n.pkgKey]) : packages.update()));
    reg('pawnStudio.packages.updateAll', () => packages.updateAllOutdated());
    reg('pawnStudio.packages.remove', (n?: PkgNode) => n?.pkgKey && packages.remove(n.pkgKey));
    reg('pawnStudio.packages.openOnGitHub', (n?: PkgNode) => n?.repoUrl && vscode.env.openExternal(vscode.Uri.parse(n.repoUrl)));
    reg('pawnStudio.packages.checkUpdates', () => packages.checkUpdates());
    reg('pawnStudio.packages.refresh', () => {
        pawn.fireProjectChanged();
        packagesView.refresh();
    });
    reg('pawnStudio.packages.init', () => packages.initManifest());
    reg('pawnStudio.packages.signIn', () => packages.signIn());

    reg('pawnStudio.server.start', () => startServer(true));
    reg('pawnStudio.server.startNoCompile', () => startServer(false));
    reg('pawnStudio.server.stop', () => {
        const s = vscode.debug.activeDebugSession;
        if (s?.type === 'pawn') return vscode.debug.stopDebugging(s);
        return vscode.debug.stopDebugging();
    });
    reg('pawnStudio.server.refresh', () => serverView.refresh());
    reg('pawnStudio.server.clearErrors', () => {
        serverView.clearRuntimeErrors();
        pawn.runtimeDiagnostics.clear();
    });
    reg('pawnStudio.server.openConfig', () => {
        const s = pawn.server();
        if (s && fs.existsSync(s.configFile)) vscode.window.showTextDocument(vscode.Uri.file(s.configFile));
    });

    async function startServer(compile: boolean) {
        if (serverView.running) {
            const restart = t('Restart');
            const a = await vscode.window.showWarningMessage(t('The server is already running.'), restart);
            if (a !== restart) return;
            await vscode.commands.executeCommand('workbench.action.debug.restart');
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        await vscode.debug.startDebugging(folder, { type: 'pawn', request: 'launch', name: t('SA-MP / open.mp server'), compile });
    }

    // ───────────── debugger ─────────────
    const resolveSource = (file: string): string | undefined => {
        if (path.isAbsolute(file) && fs.existsSync(file)) return file;
        const bases = new Set<string>();
        const last = b.last?.target.entry;
        if (last) bases.add(path.dirname(last));
        const me = pawn.manifestEntry().entry;
        if (me) bases.add(path.dirname(me));
        const server = pawn.server();
        if (server) {
            bases.add(path.join(server.dir, 'gamemodes'));
            bases.add(path.join(server.dir, 'filterscripts'));
            bases.add(server.dir);
        }
        for (const f of vscode.workspace.workspaceFolders ?? []) bases.add(f.uri.fsPath);
        for (const base of bases) {
            const p = path.resolve(base, file);
            if (fs.existsSync(p)) return p;
        }
        // last resort: look up by name among the files in the last target's tree
        if (last) {
            const tail = file.replace(/\\/g, '/').toLowerCase().split('/').slice(-2).join('/');
            for (const f of pawn.graph.closure(last).values()) {
                if (f.replace(/\\/g, '/').toLowerCase().endsWith(tail)) return f;
            }
        }
        return undefined;
    };

    sub.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('pawn', {
            createDebugAdapterDescriptor: () =>
                new vscode.DebugAdapterInlineImplementation(
                    new PawnDebugSession({
                        compileForLaunch: async (target) => {
                            if (cfg().get<boolean>('saveBeforeCompile')) await b.saveDirty();
                            let tgt;
                            if (target) tgt = b.makeTarget(target, 'launch.json');
                            else {
                                const me = pawn.manifestEntry().entry;
                                const r = await b.resolve(activeFile() ?? me);
                                if ('target' in r) tgt = r.target;
                                else tgt = await b.resolveInteractive(activeFile());
                            }
                            if (!tgt) return undefined;
                            await b.setLastTarget(tgt.entry);
                            pawn.runtimeDiagnostics.clear();
                            const res = await b.withProgress(`$(sync~spin) ${t('Compiling {0}…', path.basename(tgt.entry))}`, () => b.compile(tgt!, { quiet: true }));
                            if (!res) return undefined;
                            return {
                                ok: res.ok,
                                amx: res.amx,
                                message: res.ok
                                    ? t('{0} in {1}s ({2} warning(s))', path.basename(res.amx), (res.durationMs / 1000).toFixed(2), res.warnings)
                                    : t('{0} error(s) in {1}', res.errors, path.basename(tgt.entry)),
                            };
                        },
                        findServer: (explicit) => (explicit ? findServer(explicit, explicit) : pawn.server()),
                        resolveSource,
                        hasCrashdetect: (server) =>
                            readServerPlugins(server).some((p) => /crashdetect/i.test(p)) ||
                            ['crashdetect.dll', 'crashdetect.so'].some((f) => fs.existsSync(path.join(server.dir, 'plugins', f)) || fs.existsSync(path.join(server.dir, 'components', f))),
                        onRuntimeError: (err, frames) => {
                            serverView.addRuntimeError({ err, frames, at: new Date() });
                            const top = frames.find((f) => f.resolved && f.line);
                            if (!top) return;
                            const uri = vscode.Uri.file(top.resolved!);
                            const d = new vscode.Diagnostic(
                                new vscode.Range(top.line! - 1, 0, top.line! - 1, Number.MAX_SAFE_INTEGER),
                                [err.title, ...err.details].join(' — '),
                                vscode.DiagnosticSeverity.Error,
                            );
                            d.source = 'crashdetect';
                            d.relatedInformation = frames
                                .filter((f) => f !== top && f.resolved && f.line)
                                .map((f) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(f.resolved!), new vscode.Position(f.line! - 1, 0)), `#${f.index} ${f.func}`));
                            const existing = (pawn.runtimeDiagnostics.get(uri) ?? []).filter((x) => x.range.start.line !== d.range.start.line);
                            pawn.runtimeDiagnostics.set(uri, [...existing, d]);
                        },
                        onServerState: ({ running, pid }) => {
                            serverView.running = running;
                            serverView.pid = pid;
                            serverView.refresh();
                            updateContextKeys();
                        },
                    }),
                ),
        }),
        vscode.debug.registerDebugConfigurationProvider('pawn', {
            resolveDebugConfiguration(_folder, config) {
                if (!config.type && !config.request) {
                    return { type: 'pawn', request: 'launch', name: t('SA-MP / open.mp server'), compile: true };
                }
                return config;
            },
            provideDebugConfigurations() {
                return [{ type: 'pawn', request: 'launch', name: t('SA-MP / open.mp server'), compile: true }];
            },
        }),
    );

    updateContextKeys();
    scheduleStatus();
    packages.autoCheckOnStartup();
    void suggestCrashdetect(pawn);
}

/** Once per workspace: if there is a server but no crashdetect, suggest installing it. */
async function suggestCrashdetect(pawn: Pawn): Promise<void> {
    const key = 'pawnStudio.crashdetectSuggested';
    if (pawn.ctx.workspaceState.get(key)) return;
    const server = pawn.server();
    if (!server?.executable) return;
    if (readServerPlugins(server).some((p) => /crashdetect/i.test(p))) return;
    await pawn.ctx.workspaceState.update(key, true);
    const find = t('Find crashdetect');
    const a = await vscode.window.showInformationMessage(
        t('Pawn: install the crashdetect plugin to see the exact line of runtime errors when debugging the server.'),
        find,
        t('Not now'),
    );
    if (a === find) vscode.commands.executeCommand('pawnStudio.packages.install');
}

export function deactivate(): void {
    builder = undefined;
}

