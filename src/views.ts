/**
 * "Pawn" sidebar: Build, Packages and Server.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Builder, kindLabel } from './build';
import { Pawn, rel } from './context';
import { RuntimeError, RuntimeFrame } from './debug/crashdetect';
import { PackageStatus } from './packages/manager';
import { readServerCfgValue, readServerPlugins, ServerInfo } from './packages/manifest';
import { manifestErrorMessage, PackagesController } from './packages/ui';
import { t } from './i18n';

type Node = vscode.TreeItem & { children?: () => Node[] | Promise<Node[]> };

function item(label: string | vscode.TreeItemLabel, opts: Partial<Node> = {}): Node {
    const node = new vscode.TreeItem(label, opts.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None) as Node;
    Object.assign(node, opts);
    return node;
}

function icon(id: string, color?: string): vscode.ThemeIcon {
    return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function openAt(file: string, line?: number): vscode.Command {
    const args: unknown[] = [vscode.Uri.file(file)];
    if (line !== undefined) args.push({ selection: new vscode.Range(line, 0, line, 0) });
    return { command: 'vscode.open', title: t('Open'), arguments: args };
}

function bytes(n: number): string {
    return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

abstract class Provider implements vscode.TreeDataProvider<Node> {
    protected _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    refresh(): void {
        this._onDidChange.fire();
    }
    getTreeItem(n: Node): vscode.TreeItem {
        return n;
    }
    async getChildren(n?: Node): Promise<Node[]> {
        if (n) return n.children ? await n.children() : [];
        return this.roots();
    }
    protected abstract roots(): Node[] | Promise<Node[]>;
}

// ───────────────────────── Build ─────────────────────────

export class CompileView extends Provider {
    constructor(
        private pawn: Pawn,
        private builder: Builder,
    ) {
        super();
    }

    protected roots(): Node[] {
        const r = this.builder.last;
        if (!r) return [];
        const nodes: Node[] = [];
        const amxName = path.basename(r.amx);
        const when = r.at.toLocaleTimeString();
        const secs = (r.durationMs / 1000).toFixed(2) + 's';
        nodes.push(
            item(r.ok ? t('{0} compiled', amxName) : t('Failed: {0} error(s)', r.errors), {
                description: `${secs} · ${when}${r.background ? ` · ${t('check on save')}` : ''}`,
                iconPath: r.ok ? icon('pass-filled', 'testing.iconPassed') : icon('error', 'testing.iconFailed'),
                tooltip: new vscode.MarkdownString(
                    `**${r.ok ? t('Success') : t('Failed')}** ${t('in {0} at {1}', secs, when)}\n\n` +
                        `- ${t('Target: {0} ({1})', `\`${rel(r.target.entry)}\``, kindLabel(r.target.kind))}\n- ${r.target.reason}\n` +
                        `- ${t('{0} error(s), {1} warning(s)', r.errors, r.warnings)}\n- ${t('Exit code: {0}', String(r.exitCode))}` +
                        (r.background ? `\n\n_${t('Automatic check on save: the real .amx was not changed.')}_` : ''),
                ),
            }),
        );
        nodes.push(
            item(path.basename(r.target.entry), {
                description: `${kindLabel(r.target.kind)} · ${rel(path.dirname(r.target.entry))}`,
                iconPath: icon(r.target.kind === 'filterscript' ? 'extensions' : 'globe'),
                command: openAt(r.target.entry),
                tooltip: r.target.reason,
            }),
        );
        if (!r.background) {
            let size = r.amxSize;
            if (size === undefined) {
                try {
                    size = fs.statSync(r.amx).size;
                } catch {
                    size = undefined;
                }
            }
            nodes.push(
                item(rel(r.amx), {
                    description: size !== undefined ? bytes(size) : t('not generated'),
                    iconPath: icon('file-binary'),
                    resourceUri: vscode.Uri.file(r.amx),
                    contextValue: 'amx',
                }),
            );
        }
        const group = (label: string, sev: 'error' | 'warning') => {
            const list = r.diags.filter((d) => (sev === 'error' ? d.severity !== 'warning' : d.severity === 'warning'));
            if (!list.length) return;
            nodes.push(
                item(`${label} (${list.length})`, {
                    iconPath: icon(sev === 'error' ? 'error' : 'warning', sev === 'error' ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'),
                    collapsibleState: sev === 'error' || list.length <= 15 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                    children: () =>
                        list.map((d) =>
                            item(d.message, {
                                description: `${path.basename(d.file)}:${d.line}`,
                                tooltip: `${d.severity} ${d.code}: ${d.message}\n${d.file}:${d.line}`,
                                iconPath: icon(sev === 'error' ? 'circle-filled' : 'circle-outline', sev === 'error' ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'),
                                command: openAt(d.file, d.line - 1),
                            }),
                        ),
                }),
            );
        };
        group(t('Errors'), 'error');
        group(t('Warnings'), 'warning');
        nodes.push(item(t('Compiler'), { description: rel(r.compiler), iconPath: icon('tools'), tooltip: r.compiler }));
        const incs = this.pawn.includeDirs(r.target.entry);
        nodes.push(
            item(t('Include folders ({0})', incs.length), {
                iconPath: icon('folder-library'),
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                children: () => incs.map((d) => item(rel(d), { iconPath: icon('folder'), tooltip: d })),
            }),
        );
        return nodes;
    }
}

// ───────────────────────── Packages ─────────────────────────

export class PackagesView extends Provider {
    constructor(
        private pawn: Pawn,
        private ctl: PackagesController,
    ) {
        super();
    }

    protected roots(): Node[] {
        const pm = this.pawn.packages();
        if (!pm?.hasManifest()) return [];
        const problem = pm.manifestError();
        if (problem) {
            return [
                item(manifestErrorMessage(problem), {
                    iconPath: icon('error', 'problemsErrorIcon.foreground'),
                    tooltip: manifestErrorMessage(problem),
                    command: { command: 'vscode.open', title: t('Open pawn.json'), arguments: [vscode.Uri.file(problem.file)] },
                }),
            ];
        }
        const status = pm.status();
        const direct = status.filter((s) => s.direct);
        const indirect = status.filter((s) => !s.direct);
        const nodes: Node[] = [];

        const outdated = [...this.ctl.updates.values()].filter((u) => u.state === 'outdated').length;
        const major = [...this.ctl.updates.values()].filter((u) => u.state === 'major').length;
        const missing = direct.filter((s) => !s.installed || s.missingOnDisk).length;
        let summary: string;
        if (this.ctl.busy) summary = t('operation in progress…');
        else if (this.ctl.checking) summary = t('checking for updates…');
        else if (missing) summary = t('{0} not installed', missing);
        else if (outdated) summary = t('{0} update(s) available', outdated);
        else if (major) summary = t('up to date within pawn.json · {0} with a new major version', major);
        else if (this.ctl.lastCheck) summary = t('all up to date · checked at {0}', this.ctl.lastCheck.toLocaleTimeString());
        else summary = t('updates not checked');
        nodes.push(
            item(this.ctl.lastError ? t('Could not check') : summary, {
                description: this.ctl.lastError ? this.ctl.lastError.slice(0, 80) : undefined,
                iconPath: this.ctl.busy || this.ctl.checking
                    ? icon('sync~spin')
                    : this.ctl.lastError
                      ? icon('warning', 'problemsWarningIcon.foreground')
                      : missing
                        ? icon('cloud-download', 'problemsWarningIcon.foreground')
                        : outdated
                          ? icon('arrow-circle-up', 'charts.yellow')
                          : icon('check', 'testing.iconPassed'),
                command: missing
                    ? { command: 'pawnStudio.packages.installAll', title: t('Install') }
                    : outdated
                      ? { command: 'pawnStudio.packages.updateAll', title: t('Update') }
                      : { command: 'pawnStudio.packages.checkUpdates', title: t('Check') },
                tooltip: this.ctl.lastError ?? t('Click to act'),
            }),
        );

        nodes.push(
            item(t('Dependencies ({0})', direct.length), {
                iconPath: icon('package'),
                children: () => direct.map((s) => this.pkgNode(s)),
            }),
        );
        if (indirect.length) {
            nodes.push(
                item(t('Indirect ({0})', indirect.length), {
                    iconPath: icon('type-hierarchy-sub'),
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    children: () => indirect.map((s) => this.pkgNode(s)),
                }),
            );
        }
        return nodes;
    }

    private pkgNode(s: PackageStatus): Node {
        const e = s.installed;
        const u = this.ctl.updates.get(s.key);
        const name = s.name;
        let description: string;
        let ic: vscode.ThemeIcon;
        let ctx: string;
        if (!e || s.missingOnDisk) {
            description = t('not installed');
            ic = icon('cloud-download', 'problemsWarningIcon.foreground');
            ctx = 'pkg.missing';
        } else if (u?.state === 'outdated') {
            description = `${u.current} → ${u.wanted}`;
            ic = icon('arrow-circle-up', 'charts.yellow');
            ctx = 'pkg.outdated';
        } else if (u?.state === 'major') {
            description = `${u.current} · ${t('{0} available', u.latest ?? '')}`;
            ic = icon('arrow-circle-up', 'charts.blue');
            ctx = 'pkg.outdated';
        } else {
            description = e.refType === 'branch' ? `${e.ref}@${(e.commit ?? '').slice(0, 7)}` : e.ref;
            if (u?.state === 'up-to-date') description += ' ✓';
            ic = u?.state === 'up-to-date' ? icon('pass-filled', 'testing.iconPassed') : u?.state === 'pinned' ? icon('pinned') : icon('package');
            ctx = 'pkg.installed';
        }
        if (!s.direct) ctx += '.indirect';
        const tip = new vscode.MarkdownString(`**${name}**\n\n`);
        tip.appendMarkdown(`- ${t('requirement')}: \`${s.requirement}\`${s.dev ? ' (dev)' : ''}\n`);
        if (e) {
            tip.appendMarkdown(`- ${t('version')}: \`${e.ref}\` (${e.refType})${e.commit ? ` · \`${e.commit.slice(0, 10)}\`` : ''}\n`);
            tip.appendMarkdown(`- ${t('folder')}: \`${e.dir}\`\n- ${t('installed')}: ${new Date(e.installedAt).toLocaleString()}\n`);
            if (e.asset) tip.appendMarkdown(`- ${t('release file')}: \`${e.asset}\`\n`);
            if (e.plugins.length) tip.appendMarkdown(`- ${t('plugins')}: ${e.plugins.join(', ')}\n`);
        }
        if (u?.wanted && u.wanted !== u.current) tip.appendMarkdown(`- ${t('newest allowed')}: \`${u.wanted}\`\n`);
        if (u?.latest) tip.appendMarkdown(`- ${t('latest')}: \`${u.latest}\`\n`);
        if (u?.error) tip.appendMarkdown(`- ⚠ ${u.error}\n`);

        const children: Node[] = [];
        if (e) {
            for (const p of e.plugins) children.push(item(p, { description: t('plugin'), iconPath: icon('plug') }));
            for (const inc of e.includePaths) {
                const abs = path.resolve(this.pawn.projectRoot() ?? '', inc);
                children.push(item(inc, { description: t('include'), iconPath: icon('folder-library'), resourceUri: vscode.Uri.file(abs), command: { command: 'revealInExplorer', title: t('Reveal'), arguments: [vscode.Uri.file(abs)] } }));
            }
            for (const d of e.dependencies) children.push(item(d, { description: t('depends on'), iconPath: icon('arrow-small-right') }));
        }
        const n = item(name, {
            description,
            iconPath: ic,
            tooltip: tip,
            contextValue: ctx,
            collapsibleState: children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            children: children.length ? () => children : undefined,
        });
        n.collapsibleState = children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        (n as Node & { pkgKey: string; repoUrl: string }).pkgKey = s.key;
        (n as Node & { repoUrl: string }).repoUrl = `https://github.com/${name}`;
        return n;
    }
}

// ───────────────────────── Server ─────────────────────────

export interface RuntimeRecord {
    err: RuntimeError;
    frames: Array<RuntimeFrame & { resolved?: string }>;
    at: Date;
}

export class ServerView extends Provider {
    running = false;
    pid: number | undefined;
    runtimeErrors: RuntimeRecord[] = [];

    constructor(private pawn: Pawn) {
        super();
    }

    addRuntimeError(r: RuntimeRecord): void {
        this.runtimeErrors.unshift(r);
        this.runtimeErrors = this.runtimeErrors.slice(0, 50);
        this.refresh();
    }

    clearRuntimeErrors(): void {
        this.runtimeErrors = [];
        this.refresh();
    }

    protected roots(): Node[] {
        const server: ServerInfo | undefined = this.pawn.server();
        if (!server) return [];
        const nodes: Node[] = [];
        const kindName = server.kind === 'openmp' ? 'open.mp' : 'SA-MP';
        nodes.push(
            item(this.running ? t('Running') : t('Stopped'), {
                description: this.running ? t('PID {0}', this.pid ?? '?') : t('click to start'),
                iconPath: this.running ? icon('vm-running', 'testing.iconPassed') : icon('vm-outline'),
                command: this.running ? { command: 'pawnStudio.server.stop', title: t('Stop') } : { command: 'pawnStudio.server.start', title: t('Start') },
                contextValue: this.running ? 'server.running' : 'server.stopped',
            }),
        );
        nodes.push(
            item(server.executable ? path.basename(server.executable) : t('executable not found'), {
                description: `${kindName} · ${rel(server.dir) || server.dir}`,
                iconPath: icon('server-process'),
                tooltip: server.executable ?? t('Put samp-server.exe / omp-server.exe in the project folder or set pawnStudio.server.path'),
            }),
        );
        if (fs.existsSync(server.configFile)) {
            const gm = readServerCfgValue(server, 'gamemode0');
            const port = readServerCfgValue(server, 'port');
            nodes.push(
                item(path.basename(server.configFile), {
                    description: [gm && `gamemode: ${gm}`, port && t('port {0}', port)].filter(Boolean).join(' · '),
                    iconPath: icon('settings-gear'),
                    command: openAt(server.configFile),
                }),
            );
        }
        const logFile = path.join(server.dir, server.kind === 'openmp' ? 'log.txt' : 'server_log.txt');
        if (fs.existsSync(logFile)) {
            nodes.push(item(path.basename(logFile), { description: t('server log'), iconPath: icon('output'), command: openAt(logFile) }));
        }

        const plugins = readServerPlugins(server);
        const pluginsDir = path.join(server.dir, 'plugins');
        const lock = this.pawn.packages()?.lock();
        const owner = (name: string) =>
            Object.values(lock?.packages ?? {}).find((e) => e.plugins.some((p) => p.toLowerCase().replace(/\.(dll|so)$/, '') === name.toLowerCase().replace(/\.(dll|so)$/, '')));
        nodes.push(
            item(t('Plugins ({0})', plugins.length), {
                iconPath: icon('plug'),
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                children: () =>
                    plugins.map((p) => {
                        const base = p.replace(/\.(dll|so)$/i, '');
                        const exists = ['.dll', '.so', ''].some((ext) => fs.existsSync(path.join(pluginsDir, base + ext)));
                        const pkg = owner(p);
                        return item(p, {
                            description: !exists ? t('file not found in plugins/') : pkg ? `${pkg.owner}/${pkg.repo}` : t('manual'),
                            iconPath: exists ? icon('plug') : icon('warning', 'problemsWarningIcon.foreground'),
                        });
                    }),
            }),
        );

        if (this.runtimeErrors.length) {
            nodes.push(
                item(t('Runtime errors ({0})', this.runtimeErrors.length), {
                    iconPath: icon('bug', 'problemsErrorIcon.foreground'),
                    contextValue: 'runtimeErrors',
                    children: () =>
                        this.runtimeErrors.map((r) => {
                            const top = r.frames.find((f) => f.resolved && f.line);
                            return item(r.err.title, {
                                description: `${top ? `${path.basename(top.resolved!)}:${top.line} · ` : ''}${r.at.toLocaleTimeString()}`,
                                tooltip: [r.err.title, ...r.err.details, '', ...r.frames.map((f) => `#${f.index} ${f.raw}`)].join('\n'),
                                iconPath: icon(r.err.kind === 'crash' ? 'flame' : r.err.kind === 'plugin' ? 'plug' : 'error', 'problemsErrorIcon.foreground'),
                                command: top ? openAt(top.resolved!, top.line! - 1) : undefined,
                                collapsibleState: r.frames.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                                children: r.frames.length
                                    ? () =>
                                          r.frames.map((f) =>
                                              item(`#${f.index} ${f.func}`, {
                                                  description: f.resolved && f.line ? `${path.basename(f.resolved)}:${f.line}` : f.native ? t('native') : '',
                                                  iconPath: icon(f.native ? 'symbol-method' : 'symbol-function'),
                                                  command: f.resolved && f.line ? openAt(f.resolved, f.line - 1) : undefined,
                                                  tooltip: f.raw,
                                              }),
                                          )
                                    : undefined,
                            });
                        }),
                }),
            );
        }
        return nodes;
    }
}
