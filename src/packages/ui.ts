/**
 * Package manager commands (GitHub search, install, update, remove).
 */
import * as vscode from 'vscode';
import { cfg, Pawn } from '../context';
import { caretFor, depKey, displayName, latestTag, parsePackageInput } from './deps';
import { GitHubError, RepoInfo } from './github';
import { UpdateInfo } from './manager';
import { ManifestError } from './manifest';
import { t } from '../i18n';

/** Readable explanation of an unusable pawn.json. */
export function manifestErrorMessage(e: ManifestError): string {
    switch (e.problem) {
        case 'invalid-json':
            return t('pawn.json is not valid JSON.');
        case 'array-dependencies':
            return t('"dependencies" in pawn.json is a list (sampctl format). Pawn Studio uses an object: {0}', '{ "user/repo": "^1.0.0" }');
        case 'bad-dependencies':
            return t('"dependencies" in pawn.json must map "user/repo" to a version requirement (text).');
        default:
            return t('pawn.json must contain a JSON object.');
    }
}

export class PackagesController implements vscode.Disposable {
    private _updates = new Map<string, UpdateInfo>();
    private _checking = false;
    private _busy = false;
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    lastCheck: Date | undefined;
    lastError: string | undefined;

    constructor(private pawn: Pawn) {}

    dispose(): void {
        this._onDidChange.dispose();
    }

    get updates(): Map<string, UpdateInfo> {
        return this._updates;
    }

    get checking(): boolean {
        return this._checking;
    }

    get busy(): boolean {
        return this._busy;
    }

    refresh(): void {
        this._onDidChange.fire();
    }

    private handleError(e: unknown, action: string): void {
        const msg = (e as Error).message ?? String(e);
        this.pawn.output.appendLine(`✖ ${action}: ${msg}`);
        if (e instanceof ManifestError) {
            const openLabel = t('Open pawn.json');
            vscode.window.showErrorMessage(`Pawn: ${manifestErrorMessage(e)}`, openLabel).then((a) => {
                if (a === openLabel) void vscode.window.showTextDocument(vscode.Uri.file(e.file));
            });
        } else if (e instanceof GitHubError && e.rateLimited) {
            const signInLabel = t('Sign in to GitHub');
            vscode.window.showErrorMessage(`Pawn: ${msg}`, signInLabel).then((a) => {
                if (a === signInLabel) vscode.commands.executeCommand('pawnStudio.packages.signIn');
            });
        } else {
            const showOutputLabel = t('Show Output');
            vscode.window.showErrorMessage(`Pawn: ${t('{0} failed — {1}', action, msg)}`, showOutputLabel).then((a) => a === showOutputLabel && this.pawn.output.show());
        }
    }

    private async run<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
        if (this._busy) {
            vscode.window.showWarningMessage(`Pawn: ${t('Wait for the package operation in progress to finish.')}`);
            return undefined;
        }
        this._busy = true;
        this.refresh();
        this.pawn.output.appendLine('');
        this.pawn.output.appendLine(`[${new Date().toLocaleTimeString()}] ${title}`);
        try {
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pawn: ${title}`, cancellable: false }, fn);
        } catch (e) {
            this.handleError(e, title);
            return undefined;
        } finally {
            this._busy = false;
            this.pawn.github.clearCache();
            this.pawn.fireProjectChanged();
            this.refresh();
        }
    }

    // ───────────────────────── commands ─────────────────────────

    async signIn(): Promise<void> {
        const token = await this.pawn.githubToken(true);
        if (token) {
            this.pawn.github.clearCache();
            vscode.window.showInformationMessage(`Pawn: ${t('Connected to GitHub — rate limit raised.')}`);
        }
    }

    async initManifest(): Promise<void> {
        const pm = this.pawn.packages();
        if (!pm) {
            vscode.window.showWarningMessage(t('Open the server/project folder first.'));
            return;
        }
        if (pm.hasManifest()) {
            vscode.window.showTextDocument(vscode.Uri.file(`${pm.root}/pawn.json`));
            return;
        }
        const me = this.pawn.manifestEntry();
        const files = await vscode.workspace.findFiles('gamemodes/*.pwn', undefined, 20);
        const entry = me.entry ?? files[0]?.fsPath;
        const relEntry = entry ? vscode.workspace.asRelativePath(entry, false).replace(/\\/g, '/') : 'gamemodes/main.pwn';
        pm.ensureManifest({ entry: relEntry, output: relEntry.replace(/\.pwn$/i, '.amx') });
        this.pawn.fireProjectChanged();
        this.refresh();
        vscode.window.showTextDocument(vscode.Uri.file(`${pm.root}/pawn.json`));
    }

    /** Interactive GitHub search (debounced) → pick version → install. */
    async install(preset?: string): Promise<void> {
        const pm = this.pawn.packages();
        if (!pm) {
            vscode.window.showWarningMessage(t('Open the server/project folder first.'));
            return;
        }
        const repo = preset ?? (await this.searchPick());
        if (!repo) return;
        const parsed = parsePackageInput(repo);
        if (!parsed) {
            vscode.window.showErrorMessage(t('"{0}" is not a valid package.', repo));
            return;
        }
        const name = displayName(parsed.name);
        let requirement = parsed.requirement;
        if (requirement === undefined) {
            const v = await this.pickVersion(parsed.name.owner, parsed.name.repo);
            if (v === null) return;
            requirement = v;
        }
        const res = await this.run(t('Installing {0}', name), () => pm.add(name, { requirement }));
        if (res) {
            const pkg = `${name} (${res.ref})`;
            const msg = res.plugins.length ? t('{0} installed + plugin(s) {1}.', pkg, res.plugins.join(', ')) : t('{0} installed.', pkg);
            vscode.window.showInformationMessage(`Pawn: ${msg}`);
            this._updates.delete(depKey(res));
        }
    }

    private async searchPick(): Promise<string | undefined> {
        type Item = vscode.QuickPickItem & { repo?: string };
        const qp = vscode.window.createQuickPick<Item>();
        qp.title = t('Install Pawn package (GitHub)');
        qp.placeholder = t('Search by name (e.g. streamer, mysql, crashdetect, YSI) or type user/repository');
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        let timer: NodeJS.Timeout | undefined;
        let seq = 0;
        const toItem = (r: RepoInfo & { pawnPackage: boolean }): Item => ({
            label: `${r.pawnPackage ? '$(package)' : '$(repo)'} ${r.full_name}`,
            description: `$(star-full) ${r.stargazers_count}${r.archived ? `  · ${t('archived')}` : ''}`,
            detail: r.description ?? '',
            repo: r.full_name,
        });
        const search = (q: string) => {
            const my = ++seq;
            qp.busy = true;
            this.pawn.github
                .searchRepos(q)
                .then((list) => {
                    if (my !== seq) return;
                    const direct = parsePackageInput(q)?.name;
                    const items = list.map(toItem);
                    if (direct && !items.some((i) => i.repo?.toLowerCase() === `${direct.owner}/${direct.repo}`.toLowerCase())) {
                        items.unshift({ label: `$(cloud-download) ${q.trim()}`, description: t('install directly'), repo: q.trim() });
                    }
                    qp.items = items;
                })
                .catch((e) => {
                    if (my !== seq) return;
                    const direct = parsePackageInput(q)?.name;
                    qp.items = [
                        ...(direct ? [{ label: `$(cloud-download) ${q.trim()}`, description: t('install directly'), repo: q.trim() }] : []),
                        { label: `$(error) ${(e as Error).message}`, alwaysShow: true },
                    ];
                })
                .finally(() => my === seq && (qp.busy = false));
        };
        qp.onDidChangeValue((v) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => search(v), 450);
        });
        search('');
        qp.show();
        return new Promise((resolve) => {
            qp.onDidAccept(() => {
                const sel = qp.selectedItems[0];
                if (sel?.repo) {
                    resolve(sel.repo);
                    qp.hide();
                } else if (parsePackageInput(qp.value)) {
                    resolve(qp.value.trim());
                    qp.hide();
                }
            });
            qp.onDidHide(() => {
                resolve(undefined);
                qp.dispose();
            });
        });
    }

    /** Returns the requirement to write in pawn.json, or null if cancelled. */
    private async pickVersion(owner: string, repo: string): Promise<string | null> {
        type Item = vscode.QuickPickItem & { value: string };
        let tags: string[] = [];
        let branch = 'main';
        try {
            const [tagList, r] = await Promise.all([this.pawn.github.tags(owner, repo), this.pawn.github.repo(owner, repo)]);
            tags = tagList.map((x) => x.name);
            branch = r.default_branch;
        } catch (e) {
            this.handleError(e, t('Fetching versions of {0}', `${owner}/${repo}`));
            return null;
        }
        const latest = latestTag(tags);
        const items: Item[] = [];
        if (latest) {
            const caret = caretFor(latest);
            if (caret !== latest) {
                items.push({ label: `$(tag) ${caret}`, description: t('{0} + compatible updates (recommended)', latest), value: caret });
            }
            items.push({ label: `$(pinned) ${latest}`, description: t('exactly this version'), value: latest });
        }
        items.push({ label: `$(git-branch) branch:${branch}`, description: t('latest commit of the branch (may break)'), value: `branch:${branch}` });
        for (const tag of tags) if (tag !== latest) items.push({ label: `$(tag) ${tag}`, description: t('exactly this version'), value: tag });
        if (items.length === 1) return items[0].value;
        const pick = await vscode.window.showQuickPick(items, { title: t('{0} — choose the version', `${owner}/${repo}`) });
        return pick ? pick.value : null;
    }

    async installAll(): Promise<void> {
        const pm = this.pawn.packages();
        if (!pm?.hasManifest()) {
            const createLabel = t('Create pawn.json');
            const a = await vscode.window.showWarningMessage(t('No pawn.json in the project.'), createLabel);
            if (a === createLabel) await this.initManifest();
            return;
        }
        await this.run(t('Installing pawn.json dependencies'), () => pm.installAll());
    }

    async update(keys?: string[]): Promise<void> {
        const pm = this.pawn.packages();
        if (!pm) return;
        // A single package whose only newer versions are outside its requirement: confirm the jump.
        let toLatest = false;
        if (keys?.length === 1) {
            const u = this._updates.get(keys[0].toLowerCase());
            if (u?.state === 'major') {
                const yes = t('Update to {0}', u.latest ?? '');
                const a = await vscode.window.showWarningMessage(
                    t('{0}: {1} is outside the version range in pawn.json and may have breaking changes. Update and change pawn.json?', keys[0], u.latest ?? ''),
                    { modal: true },
                    yes,
                );
                if (a !== yes) return;
                toLatest = true;
            }
        }
        const title = keys?.length === 1 ? t('Updating {0}', keys[0]) : t('Updating packages');
        const changed = await this.run(title, () => pm.update(keys, { toLatest }));
        if (changed === undefined) return;
        for (const k of keys ?? [...this._updates.keys()]) this._updates.delete(k.toLowerCase());
        if (changed.length) vscode.window.showInformationMessage(`Pawn: ${t('Updated — {0}', changed.join('; '))}`);
        else vscode.window.showInformationMessage(`Pawn: ${t('Everything was already at the newest allowed version.')}`);
        void this.checkUpdates(true);
    }

    async updateAllOutdated(): Promise<void> {
        const outdated = [...this._updates.values()].filter((u) => u.state === 'outdated').map((u) => u.key);
        if (!outdated.length) {
            await this.checkUpdates();
            const again = [...this._updates.values()].filter((u) => u.state === 'outdated').map((u) => u.key);
            if (!again.length) {
                vscode.window.showInformationMessage(`Pawn: ${t('All packages are up to date.')}`);
                return;
            }
            return this.update(again);
        }
        return this.update(outdated);
    }

    async remove(key: string): Promise<void> {
        const pm = this.pawn.packages();
        if (!pm) return;
        const removeLabel = t('Remove');
        const ok = await vscode.window.showWarningMessage(t('Remove {0}? The package files and its plugins will be deleted.', key), { modal: true }, removeLabel);
        if (ok !== removeLabel) return;
        await this.run(t('Removing {0}', key), () => pm.remove(key));
        this._updates.delete(key.toLowerCase());
    }

    async checkUpdates(silent = false): Promise<void> {
        const pm = this.pawn.packages();
        if (!pm || !Object.keys(pm.lock().packages).length || this._checking) return;
        this._checking = true;
        this.refresh();
        try {
            this.pawn.github.clearCache();
            this._updates = await pm.checkUpdates();
            this.lastCheck = new Date();
            this.lastError = undefined;
            const outdated = [...this._updates.values()].filter((u) => u.state === 'outdated');
            if (outdated.length && !silent) {
                const updateAllLabel = t('Update all');
                vscode.window
                    .showInformationMessage(
                        `Pawn: ${t('{0} package(s) with updates: {1}', outdated.length, outdated.map((u) => `${u.key} → ${u.wanted}`).join(', '))}`,
                        updateAllLabel,
                    )
                    .then((a) => (a === updateAllLabel ? this.updateAllOutdated() : undefined));
            }
        } catch (e) {
            this.lastError = (e as Error).message;
            if (!silent) this.handleError(e, t('Check for updates'));
        } finally {
            this._checking = false;
            this.refresh();
        }
    }

    autoCheckOnStartup(): void {
        if (cfg().get<boolean>('packages.checkUpdatesOnStartup', true)) {
            setTimeout(() => this.checkUpdates(true), 4000);
        }
    }
}
