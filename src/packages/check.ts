/**
 * "Pawn: Check my package": for package authors. Reads the pawn.json of the open repository and its
 * latest GitHub release, and shows what each server / system would get when someone installs it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Pawn } from '../context';
import { t } from '../i18n';
import { extractTo, readArchive } from './archive';
import { classifyBinaries, includeDirsInAsset, pickAsset } from './detect';
import { Release } from './github';
import { PawnJson, readPackageManifest, ServerKind } from './manifest';
import { InstallTarget, SERVER_NAME, supportsOf, targetLabel } from './target';

/** owner/repo from the git remote of a folder. */
function gitRemote(dir: string): string | undefined {
    for (let d = dir, i = 0; i < 4; i++, d = path.dirname(d)) {
        const cfgFile = path.join(d, '.git', 'config');
        if (fs.existsSync(cfgFile)) {
            const m = /url\s*=\s*.*github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?\s*$/m.exec(fs.readFileSync(cfgFile, 'utf8'));
            return m ? `${m[1]}/${m[2]}` : undefined;
        }
    }
    return undefined;
}

export async function checkPackage(pawn: Pawn): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return;
    const local = readPackageManifest(folder);
    let repo = gitRemote(folder);
    repo = await vscode.window.showInputBox({
        title: t('Check my package'),
        prompt: t('GitHub repository of the package (user/repo)'),
        value: repo ?? '',
        validateInput: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v.trim()) ? undefined : t('Use user/repository')),
    });
    if (!repo) return;
    const [owner, name] = repo.trim().split('/');
    const log = (s = '') => pawn.output.appendLine(s);
    void vscode.commands.executeCommand('pawnStudio.console.focus');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `$(sync~spin) ${t('Checking {0}…', repo)}` }, async () => {
        log('');
        log(`[${new Date().toLocaleTimeString()}] ${t('Check my package: {0}', repo)}`);
        try {
            await run(pawn, owner, name, local, log);
        } catch (e) {
            log(`✖ ${(e as Error).message}`);
        }
    });
}

export async function run(pawn: Pick<Pawn, "github">, owner: string, name: string, local: PawnJson | undefined, log: (s?: string) => void): Promise<void> {
    const gh = pawn.github;
    log(local ? `• ${t('pawn.json of this folder: {0}', describeManifest(local))}` : `• ${t('This folder has no pawn.json: installers detect everything from the file names.')}`);
    const release: Release | undefined = await gh.latestRelease(owner, name).catch(() => undefined);
    if (!release) {
        log(`• ${t('No GitHub release: the package installs as include-only (the .inc files of the repository).')}`);
        return;
    }
    log(`• ${t('Latest release {0}: {1}', release.tag_name, release.assets.map((a) => a.name).join(', ') || t('no files'))}`);

    // what the installers really read: the pawn.json inside the released tag
    let tagged: PawnJson | undefined;
    try {
        const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(release.tag_name)}/pawn.json`);
        tagged = res.ok ? (JSON.parse(await res.text()) as PawnJson) : undefined;
    } catch {
        tagged = undefined;
    }
    if (!tagged && local) log(`⚠ ${t('The tag {0} has no pawn.json: installers use automatic detection until you publish a tag that contains it.', release.tag_name)}`);
    const pkg = tagged ?? local;
    const supports = supportsOf(pkg?.supports);
    log(`• ${t('Made for: {0}', supports.map((s) => SERVER_NAME[s]).join(' + '))}${pkg?.supports ? '' : ` (${t('default, "supports" not set')})`}`);

    // rows: 32-bit Windows/Linux + every extra key the author declared
    const keys = new Set<string>(['windows', 'linux']);
    for (const map of [pkg?.plugins || undefined, pkg?.components]) for (const k of Object.keys(map ?? {})) keys.add(k.toLowerCase());
    if (release.assets.some((a) => /x64|win64|amd64/i.test(a.name))) keys.add('windows-x64').add('linux-x64');
    const targets = [...keys].map((k) => {
        const [osName, ...rest] = k.split('-');
        const arch = rest[0] === 'x64' || rest[0] === 'x86' ? (rest.shift() as 'x86' | 'x64') : 'x86';
        return { os: osName === 'linux' ? 'linux' : 'windows', arch, variant: rest.join('-') || undefined } as InstallTarget;
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pawn-check-'));
    const cache = new Map<string, string[]>();
    const filesOf = async (assetName: string) => {
        if (cache.has(assetName)) return cache.get(assetName)!;
        const a = release.assets.find((x) => x.name === assetName)!;
        const dir = path.join(tmp, String(cache.size));
        let files: string[] = [];
        if (a.size < 60 * 1024 * 1024) {
            const buf = await gh.download(a.browser_download_url);
            if (/\.(zip|tar\.gz|tgz)$/i.test(a.name)) files = extractTo(readArchive(buf), dir);
            else {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, a.name), buf);
                files = [path.join(dir, a.name)];
            }
        }
        cache.set(assetName, files);
        return files;
    };

    let problems = 0;
    log('');
    for (const server of ['samp', 'openmp'] as ServerKind[]) {
        for (const base of targets) {
            const tgt = { ...base, server };
            const label = targetLabel(tgt).padEnd(32);
            if (!supports.includes(server)) {
                log(`  ${label} — ${server === 'samp' ? t('not installed (open.mp only)') : t('uses the SA-MP plugin as a legacy plugin')}`);
                if (server === 'samp') continue;
            }
            const useComponents = !!pkg?.components && server === 'openmp';
            const asset = useComponents ? pickAsset(release.assets, tgt, pkg!.components) : pickAsset(release.assets, tgt, pkg?.plugins);
            if (!asset) {
                const declared = useComponents ? pkg?.components : pkg?.plugins;
                log(`  ${label} ✖ ${declared ? t('no file for this target in pawn.json') : t('no release file matches this system')}`);
                if (!base.variant && base.arch === 'x86' && supports.includes(server)) problems++;
                continue;
            }
            const files = await filesOf(asset.name);
            const root = path.join(tmp, String([...cache.keys()].indexOf(asset.name)));
            const flatAs = useComponents || (supports.length === 1 && supports[0] === 'openmp') ? 'component' : 'plugin';
            const layout = classifyBinaries(root, files, tgt.os, server, { arch: tgt.arch, flatAs });
            const what = [
                ...layout.plugins.map((p) => `plugins/${path.basename(p)}${server === 'samp' ? ' (server.cfg)' : ' (legacy_plugins)'}`),
                ...layout.components.map((c) => `components/${path.basename(c)}`),
                ...layout.libraries.map((l) => path.basename(l)),
            ];
            const incs = includeDirsInAsset(root).length ? ` + ${t('include from the release')}` : '';
            if (!what.length) {
                log(`  ${label} ⚠ ${asset.name}: ${t('no .dll/.so for this system inside')}`);
                problems++;
            } else log(`  ${label} ✔ ${asset.name} → ${what.join(', ')}${incs}`);
        }
    }
    log('');
    if (supports.includes('openmp') && !pkg?.components && [...cache.values()].every((f) => !f.some((x) => /[\\/]components[\\/]/i.test(x))))
        log(`• ${t('open.mp uses your plugin as a legacy plugin. To ship a native component, put it in components/ inside the archive, or publish a separate file and point "components" at it.')}`);
    log(problems ? `⚠ ${t('{0} target(s) need attention.', problems)}` : `✔ ${t('Every target gets its files.')}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}

function describeManifest(m: PawnJson): string {
    const parts: string[] = [];
    parts.push(`supports=${JSON.stringify(m.supports ?? 'both')}`);
    if (m.plugins === false) parts.push('plugins=false');
    else if (m.plugins) parts.push(`plugins: ${Object.keys(m.plugins).join(', ')}`);
    if (m.components) parts.push(`components: ${Object.keys(m.components).join(', ')}`);
    if (m.include) parts.push(`include=${JSON.stringify(m.include)}`);
    return parts.join(' · ');
}
