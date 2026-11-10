/**
 * npm-style package manager on top of GitHub, using Pawn Studio's own pawn.json format.
 * Works with any repository: what a package's pawn.json does not say is detected (detect.ts).
 * No VS Code dependency — testable in plain Node.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractTo, readArchive, stripCommonRoot } from './archive';
import {
    caretFor,
    compareVersions,
    depKey,
    displayName,
    latestTag,
    PackageName,
    parsePackageInput,
    parsePackageName,
    parseRequirement,
    refSatisfies,
    Requirement,
    resolveTag,
} from './deps';
import { applyLayout, BinaryLayout, classifyBinaries, detectIncludeDirs, globMatch, includeDirsInAsset, onlyOtherServerFolder, pickAsset, serverFolder } from './detect';
import { GitHub, GitHubError, Release, TagInfo } from './github';
import { includeFor, InstallTarget, localOs, resolveTarget, resolveTargets, supportsOf, targetLabel } from './target';
import { t } from '../i18n';
import {
    LockEntry,
    LockFile,
    ManifestError,
    PawnJson,
    pluginConfigName,
    readLock,
    readManifest,
    readPackageManifest,
    ServerInfo,
    setServerPlugin,
    writeLock,
    writeManifest,
} from './manifest';

export interface ManagerOptions {
    root: string; // folder containing pawn.json
    server?: ServerInfo; // where plugins/ and server.cfg live
    depsDir?: string; // default: <root>/.pawn-studio/dependencies
    /** Packages skipped when they come as transitive dependencies (e.g. the stdlib, already in pawno/include). */
    skipTransitive?: string[];
    /**
     * Also copy each package's .inc files to this folder (the server's pawno/include or qawno/include),
     * so pawno/qawno and other tools find them. Default: detected from the server; false = do not copy.
     */
    copyIncludesTo?: string | false;
    log?: (msg: string) => void;
}

/**
 * up-to-date — nothing newer;
 * outdated   — a newer version fulfills the requirement (safe update);
 * major      — newer versions exist only outside the requirement (pawn.json must change);
 * pinned     — fixed commit/tag; unknown — the check failed.
 */
export type UpdateState = 'up-to-date' | 'outdated' | 'major' | 'unknown' | 'pinned';

export interface UpdateInfo {
    key: string;
    state: UpdateState;
    current: string;
    /** newest version allowed by the requirement */
    wanted?: string;
    /** newest version overall */
    latest?: string;
    error?: string;
}

export interface PackageStatus {
    key: string;
    name: string;
    requirement: string;
    direct: boolean;
    dev: boolean;
    installed?: LockEntry;
    missingOnDisk: boolean;
}

interface Resolved {
    refType: LockEntry['refType'];
    ref: string;
    commit: string;
}

export const STDLIBS = ['pawn-lang/samp-stdlib', 'pawn-lang/pawn-stdlib', 'openmultiplayer/omp-stdlib'];

const FIELDS = ['dependencies', 'devDependencies'] as const;

/** Does a package's pawn.json say how to install it (the Pawn Studio fields)? */
function hasStudioFields(pkg: PawnJson | undefined): boolean {
    return !!pkg && (pkg.supports !== undefined || pkg.plugins !== undefined || pkg.components !== undefined || pkg.layout !== undefined);
}

/** sampctl packages: "include_path": "src" (Pawn Studio's own field is "include"). */
function sampctlIncludePath(pkg: PawnJson | undefined): string | undefined {
    const v = pkg?.['include_path'];
    return typeof v === 'string' && v ? v : undefined;
}

/**
 * Dependencies of an installed package: the Pawn Studio object { "user/repo": "^1.0" }, or the sampctl
 * list [ "user/repo", "user/repo:tag", "user/repo@branch", "user/repo#commit" ].
 */
export function packageDependencies(pkg: PawnJson | undefined): Array<[string, string]> {
    const d = pkg?.dependencies as unknown;
    if (Array.isArray(d)) {
        const out: Array<[string, string]> = [];
        for (const item of d) {
            if (typeof item !== 'string') continue;
            const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:([:@#])(.+))?$/.exec(item.trim());
            if (!m) continue;
            const req = !m[2] ? 'latest' : m[2] === ':' ? `tag:${m[3]}` : m[2] === '@' ? `branch:${m[3]}` : `commit:${m[3]}`;
            out.push([m[1], req]);
        }
        return out;
    }
    return Object.entries((d as Record<string, string>) ?? {}).filter(([, v]) => typeof v === 'string');
}

/** Folder of everything Pawn Studio downloads or generates for a project (git-ignored on its own). */
export const STUDIO_DIR = '.pawn-studio';
/** Where packages were installed before 1.4 (moved on the first read of the lock). */
const LEGACY_DEPS = 'dependencies';

export class PackageManager {
    readonly root: string;
    readonly depsDir: string;
    private log: (m: string) => void;
    private skip: Set<string>;

    constructor(
        private gh: GitHub,
        private opts: ManagerOptions,
    ) {
        this.root = path.resolve(opts.root);
        this.depsDir = opts.depsDir ?? path.join(this.root, STUDIO_DIR, 'dependencies');
        this.log = opts.log ?? (() => undefined);
        this.skip = new Set((opts.skipTransitive ?? STDLIBS).map((s) => s.toLowerCase()));
    }

    get server(): ServerInfo | undefined {
        return this.opts.server;
    }

    /** The project's pawn.json (throws ManifestError when it exists but is unusable). */
    manifest(): PawnJson | undefined {
        return readManifest(this.root);
    }

    hasManifest(): boolean {
        return fs.existsSync(path.join(this.root, 'pawn.json'));
    }

    /** The reason pawn.json cannot be used, if any. */
    manifestError(): ManifestError | undefined {
        try {
            this.manifest();
            return undefined;
        } catch (e) {
            if (e instanceof ManifestError) return e;
            throw e;
        }
    }

    lock(): LockFile {
        const lock = readLock(this.root);
        if (this.migrateLegacy(lock)) writeLock(this.root, lock);
        return lock;
    }

    /**
     * Packages installed in dependencies/ by older versions move to .pawn-studio/dependencies/.
     * Only the folders listed in pawn-lock.json move (a sampctl dependencies/ folder is left alone).
     */
    private migrateLegacy(lock: LockFile): boolean {
        const target = path.relative(this.root, this.depsDir).split(path.sep).join('/');
        if (target === LEGACY_DEPS) return false;
        let moved = false;
        for (const e of Object.values(lock.packages)) {
            if (!e.dir.startsWith(LEGACY_DEPS + '/')) continue;
            const from = path.resolve(this.root, e.dir);
            const toRel = target + e.dir.slice(LEGACY_DEPS.length);
            const to = path.resolve(this.root, toRel);
            try {
                if (fs.existsSync(from) && !fs.existsSync(to)) {
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    fs.renameSync(from, to);
                } else if (!fs.existsSync(to)) continue; // not on disk: reinstalled into the new folder later
            } catch {
                continue; // a file in use: try again next time
            }
            const swap = (p: string) => (p === e.dir || p.startsWith(e.dir + '/') ? toRel + p.slice(e.dir.length) : p);
            e.includePaths = e.includePaths.map(swap);
            e.dir = toRel;
            moved = true;
        }
        if (moved) {
            this.ensureStudioDir();
            const old = path.join(this.root, LEGACY_DEPS);
            try {
                if (fs.existsSync(old) && !fs.readdirSync(old).length) fs.rmdirSync(old);
            } catch {
                /* keep it */
            }
            this.log(`· ${t('Packages moved from dependencies/ to {0}/', target)}`);
        }
        return moved;
    }

    /** .pawn-studio/ with a .gitignore of its own, so nobody commits the downloads. */
    private ensureStudioDir(): void {
        const dir = path.join(this.root, STUDIO_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const gi = path.join(dir, '.gitignore');
        if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Pawn Studio downloads (packages): installed again from pawn.json + pawn-lock.json\n*\n');
    }

    ensureManifest(defaults: Partial<PawnJson> = {}): PawnJson {
        let m = this.manifest();
        if (!m) {
            m = { name: path.basename(this.root), version: '1.0.0', ...defaults, dependencies: {} };
            writeManifest(this.root, m);
            this.log(t('Created {0}', path.join(this.root, 'pawn.json')));
        }
        return m;
    }

    /** Direct requirements of the project: key → { name, requirement, dev }. */
    private directDeps(m = this.manifest()): Map<string, { name: PackageName; requirement: string; dev: boolean }> {
        const out = new Map<string, { name: PackageName; requirement: string; dev: boolean }>();
        for (const f of FIELDS) {
            for (const [n, req] of Object.entries(m?.[f] ?? {})) {
                const name = parsePackageName(n);
                if (!name) {
                    this.log(`⚠ ${t('Invalid package name ignored: {0}', n)}`);
                    continue;
                }
                if (!out.has(depKey(name))) out.set(depKey(name), { name, requirement: req, dev: f === 'devDependencies' });
            }
        }
        return out;
    }

    /** Include folders (absolute) of all installed packages. */
    includeDirs(): string[] {
        const out: string[] = [];
        for (const e of Object.values(this.lock().packages)) {
            for (const p of e.includePaths) {
                const abs = path.resolve(this.root, p);
                if (fs.existsSync(abs)) out.push(abs);
            }
        }
        return [...new Set(out)];
    }

    status(): PackageStatus[] {
        const lock = this.lock();
        const out: PackageStatus[] = [];
        const onDisk = (e?: LockEntry) => !!e && fs.existsSync(path.resolve(this.root, e.dir));
        for (const [key, d] of this.directDeps()) {
            const e = lock.packages[key];
            out.push({ key, name: displayName(d.name), requirement: d.requirement, direct: true, dev: d.dev, installed: e, missingOnDisk: !!e && !onDisk(e) });
        }
        for (const [key, e] of Object.entries(lock.packages)) {
            if (out.some((s) => s.key === key)) continue;
            out.push({ key, name: displayName(e), requirement: e.requirement, direct: false, dev: false, installed: e, missingOnDisk: !onDisk(e) });
        }
        return out;
    }

    // ───────────────────────── installation ─────────────────────────

    /** `npm install`: installs what is missing or no longer fulfills pawn.json. The lock is respected. */
    async installAll(force = false): Promise<void> {
        const m = this.manifest();
        if (!m) throw new Error(t('pawn.json not found'));
        const lock = this.lock();
        const ctx = { lock, done: new Map<string, string>(), force };
        for (const [, d] of this.directDeps(m)) {
            await this.installOne(d.name, d.requirement, true, d.dev, ctx);
        }
        this.prune(lock);
        writeLock(this.root, lock);
    }

    /**
     * `npm install user/repo[@requirement]`: adds to pawn.json and installs.
     * No requirement → "^<latest tag>" (or "branch:<default>" when the repo has no version tags).
     */
    async add(input: string, opts: { requirement?: string; dev?: boolean } = {}): Promise<LockEntry> {
        const parsed = parsePackageInput(input);
        if (!parsed) throw new Error(t('"{0}" is not a valid package (use user/repository)', input));
        const { name } = parsed;
        let requirement = opts.requirement ?? parsed.requirement;
        if (requirement !== undefined && !parseRequirement(requirement)) throw new Error(t('Invalid version requirement: {0}', requirement));
        if (requirement === undefined) {
            const tag = latestTag((await this.tags(name)).map((x) => x.name));
            requirement = tag ? caretFor(tag) : `branch:${(await this.gh.repo(name.owner, name.repo)).default_branch}`;
        }
        const key = depKey(name);
        const m = this.ensureManifest();
        for (const f of FIELDS) {
            for (const k of Object.keys(m[f] ?? {})) if (parsePackageName(k) && depKey(parsePackageName(k)!) === key) delete m[f]![k];
        }
        const field = opts.dev ? 'devDependencies' : 'dependencies';
        m[field] = { ...(m[field] ?? {}), [displayName(name)]: requirement };
        writeManifest(this.root, m);

        const lock = this.lock();
        await this.installOne(name, requirement, true, !!opts.dev, { lock, done: new Map(), force: true });
        writeLock(this.root, lock);
        return lock.packages[key];
    }

    async remove(key: string): Promise<void> {
        key = key.toLowerCase();
        const m = this.manifest();
        if (m) {
            for (const f of FIELDS) {
                for (const k of Object.keys(m[f] ?? {})) {
                    const n = parsePackageName(k);
                    if (n && depKey(n) === key) delete m[f]![k];
                }
            }
            writeManifest(this.root, m);
        }
        const lock = this.lock();
        this.prune(lock);
        writeLock(this.root, lock);
    }

    /**
     * Updates packages (all when `keys` is empty).
     * Default: newest version the requirement allows (like `npm update`).
     * `toLatest`: newest version overall, rewriting the requirement in pawn.json to "^<new>".
     */
    async update(keys?: string[], opts: { toLatest?: boolean } = {}): Promise<string[]> {
        const m = this.manifest();
        if (!m) throw new Error(t('pawn.json not found'));
        const lock = this.lock();
        const direct = this.directDeps(m);
        const changed: string[] = [];
        const targets = keys?.map((k) => k.toLowerCase()) ?? Object.keys(lock.packages);
        for (const key of targets) {
            const e = lock.packages[key];
            if (!e) continue;
            let requirement = direct.get(key)?.requirement ?? e.requirement;
            const req = parseRequirement(requirement);
            if (!req) continue;
            if (req.kind === 'commit' || req.kind === 'tag') {
                this.log(t('{0}: pinned to {1}, skipped', key, requirement));
                continue;
            }
            const before = e.refType === 'branch' ? `${e.ref}@${(e.commit ?? '').slice(0, 7)}` : e.ref;
            if (opts.toLatest && req.kind === 'range') {
                const latest = latestTag((await this.tags(e)).map((x) => x.name));
                if (latest && compareVersions(latest, e.ref) > 0) {
                    requirement = caretFor(latest);
                    const d = direct.get(key);
                    if (d) {
                        const field = d.dev ? 'devDependencies' : 'dependencies';
                        for (const k of Object.keys(m[field] ?? {})) if (depKey(parsePackageName(k)!) === key) delete m[field]![k];
                        m[field] = { ...(m[field] ?? {}), [displayName(d.name)]: requirement };
                    }
                }
            }
            const target = await this.resolve(e, requirement, undefined, true);
            if (target.commit === e.commit && target.ref === e.ref) {
                this.log(t('{0}: already at the newest version allowed by {1} ({2})', key, requirement, before));
                continue;
            }
            await this.installOne(e, requirement, e.direct, !!e.dev, { lock, done: new Map(), force: true, pinned: target });
            const after = target.refType === 'branch' ? `${target.ref}@${target.commit.slice(0, 7)}` : target.ref;
            changed.push(`${key} ${before} → ${after}`);
        }
        writeManifest(this.root, m);
        this.prune(lock);
        writeLock(this.root, lock);
        return changed;
    }

    async checkUpdates(): Promise<Map<string, UpdateInfo>> {
        const lock = this.lock();
        const direct = this.directDeps();
        const result = new Map<string, UpdateInfo>();
        await Promise.all(
            Object.entries(lock.packages).map(async ([key, e]) => {
                const requirement = direct.get(key)?.requirement ?? e.requirement;
                const req = parseRequirement(requirement);
                try {
                    if (!req || req.kind === 'commit' || req.kind === 'tag') {
                        result.set(key, { key, state: 'pinned', current: e.refType === 'commit' ? e.ref.slice(0, 7) : e.ref });
                    } else if (req.kind === 'branch' || e.refType === 'branch') {
                        const sha = await this.gh.commitSha(e.owner, e.repo, e.ref);
                        const outdated = !!e.commit && sha !== e.commit;
                        result.set(key, {
                            key,
                            state: outdated ? 'outdated' : 'up-to-date',
                            current: `${e.ref}@${(e.commit ?? '?').slice(0, 7)}`,
                            wanted: `${e.ref}@${sha.slice(0, 7)}`,
                            latest: `${e.ref}@${sha.slice(0, 7)}`,
                        });
                    } else {
                        const tags = (await this.tags(e, false)).map((x) => x.name);
                        const wanted = resolveTag(tags, req) ?? e.ref;
                        const latest = latestTag(tags) ?? wanted;
                        const state: UpdateState =
                            compareVersions(wanted, e.ref) > 0 ? 'outdated' : compareVersions(latest, e.ref) > 0 ? 'major' : 'up-to-date';
                        result.set(key, { key, state, current: e.ref, wanted, latest });
                    }
                } catch (err) {
                    result.set(key, { key, state: 'unknown', current: e.ref, error: (err as Error).message });
                    if (err instanceof GitHubError && err.rateLimited) throw err;
                }
            }),
        );
        return result;
    }

    private tags(n: PackageName, useCache = true): Promise<TagInfo[]> {
        return this.gh.api<TagInfo[]>(`/repos/${n.owner}/${n.repo}/tags?per_page=100`, useCache);
    }

    /** Turns a requirement into a concrete ref + commit. */
    private async resolve(n: PackageName, requirement: string, previous?: LockEntry, fresh = false): Promise<Resolved> {
        const req = parseRequirement(requirement);
        if (!req) throw new Error(t('{0}: invalid version requirement "{1}"', displayName(n), requirement));
        if (req.kind === 'commit') {
            const commit = req.commit.length === 40 ? req.commit : await this.gh.commitSha(n.owner, n.repo, req.commit);
            return { refType: 'commit', ref: req.commit, commit };
        }
        if (req.kind === 'branch') return this.resolveBranch(n, req.branch, previous, fresh);
        const tags = await this.tags(n, !fresh);
        const tag = resolveTag(tags.map((x) => x.name), req);
        if (tag) return { refType: 'tag', ref: tag, commit: tags.find((x) => x.name === tag)!.commit.sha };
        if (req.kind === 'latest') {
            // no version tags at all → follow the default branch
            return this.resolveBranch(n, (await this.gh.repo(n.owner, n.repo)).default_branch, previous, fresh);
        }
        throw new Error(t('{0}: no version matches "{1}" (versions: {2})', displayName(n), requirement, describeTags(tags)));
    }

    private async resolveBranch(n: PackageName, branch: string, previous: LockEntry | undefined, fresh: boolean): Promise<Resolved> {
        // Reproducible: keep the locked commit unless updating
        if (!fresh && previous?.refType === 'branch' && previous.ref === branch && previous.commit) {
            return { refType: 'branch', ref: branch, commit: previous.commit };
        }
        return { refType: 'branch', ref: branch, commit: await this.gh.commitSha(n.owner, n.repo, branch) };
    }

    private async installOne(
        n: PackageName,
        requirement: string,
        direct: boolean,
        dev: boolean,
        ctx: { lock: LockFile; done: Map<string, string>; force: boolean; pinned?: Resolved },
    ): Promise<void> {
        const key = depKey(n);
        const { lock } = ctx;
        const req = parseRequirement(requirement);
        if (!req) {
            this.log(`⚠ ${t('{0}: invalid version requirement "{1}"', displayName(n), requirement)}`);
            return;
        }
        if (ctx.done.has(key)) {
            const e = lock.packages[key];
            if (e && direct) e.direct = true;
            if (e && !refSatisfies({ type: e.refType, ref: e.ref, commit: e.commit }, req)) {
                this.log(`⚠ ${t('Conflict: {0} is required as "{1}" and "{2}"; keeping {3}', displayName(n), ctx.done.get(key)!, requirement, e.ref)}`);
            }
            return;
        }
        ctx.done.set(key, requirement);

        const existing = lock.packages[key];
        const onDisk = !!existing && fs.existsSync(path.resolve(this.root, existing.dir));
        const stillOk = !!existing && refSatisfies({ type: existing.refType, ref: existing.ref, commit: existing.commit }, req);

        let entry: LockEntry;
        if (!ctx.force && !ctx.pinned && onDisk && stillOk) {
            entry = existing;
            entry.requirement = requirement;
            this.log(`✓ ${t('{0} ({1}) already installed', displayName(n), entry.ref)}`);
            this.copyIncludes(entry, lock); // installs from older versions get their copies too
        } else {
            const target = ctx.pinned ?? (await this.resolve(n, requirement, stillOk ? existing : undefined, ctx.force));
            entry = await this.fetchAndInstall(n, requirement, target, existing, lock);
            lock.packages[key] = entry;
            this.copyIncludes(entry, lock);
            this.log(this.summary(n, entry));
        }
        entry.direct = direct;
        entry.dev = dev || undefined;

        // Dependencies of the package (recursive)
        const pkg = readPackageManifest(path.resolve(this.root, entry.dir));
        const childKeys: string[] = [];
        const projectDirect = this.directDeps();
        for (const [cn, creq] of packageDependencies(pkg)) {
            const child = parsePackageName(cn);
            if (!child) continue;
            const ck = depKey(child);
            if (this.skip.has(ck) && !projectDirect.has(ck)) continue;
            childKeys.push(ck);
            const d = projectDirect.get(ck);
            // the project's own requirement wins over the package's
            await this.installOne(child, d?.requirement ?? creq, !!d, d?.dev ?? false, { lock, done: ctx.done, force: false });
        }
        entry.dependencies = childKeys;
    }

    private async fetchAndInstall(n: PackageName, requirement: string, target: Resolved, previous: LockEntry | undefined, lock: LockFile): Promise<LockEntry> {
        const label = target.refType === 'branch' ? `${target.ref}@${target.commit.slice(0, 7)}` : target.ref;
        this.log(`↓ ${displayName(n)} (${label})`);
        const zip = await this.gh.downloadSource(n.owner, n.repo, target.commit);
        if (this.depsDir.startsWith(path.join(this.root, STUDIO_DIR))) this.ensureStudioDir();
        const dir = path.join(this.depsDir, this.dirNameFor(n, previous, lock));
        if (previous) this.uninstallFiles(previous, lock);
        fs.rmSync(dir, { recursive: true, force: true });
        extractTo(stripCommonRoot(readArchive(zip)), dir);

        let pkg = readPackageManifest(dir);
        // the author updated pawn.json on the main branch but not yet in a tag: use those install fields
        if (!hasStudioFields(pkg) && typeof (this.gh as { rawFile?: unknown }).rawFile === 'function') {
            const buf = await this.gh.rawFile(n.owner, n.repo, 'HEAD', 'pawn.json');
            let main: PawnJson | undefined;
            try {
                main = buf ? (JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')) as PawnJson) : undefined;
            } catch {
                main = undefined;
            }
            if (main && hasStudioFields(main)) {
                const { supports, plugins, components, layout, include } = main;
                pkg = { ...(pkg ?? {}), supports, plugins, components, layout, ...(include !== undefined ? { include } : {}) };
                this.log(`  · ${t('Using the install settings of pawn.json from the main branch ({0} has none yet)', target.ref)}`);
            }
        }
        const rel = (p: string) => path.relative(this.root, p).split(path.sep).join('/');
        const entry: LockEntry = {
            owner: n.owner,
            repo: n.repo,
            requirement,
            ref: target.ref,
            refType: target.refType,
            commit: target.commit,
            dir: rel(dir),
            includePaths: detectIncludeDirs(dir, includeFor(pkg?.include ?? sampctlIncludePath(pkg), this.target().server)).map((p) => rel(path.join(dir, p))),
            plugins: [],
            files: [],
            dependencies: [],
            direct: false,
            installedAt: new Date().toISOString(),
        };
        if (pkg?.plugins !== false) await this.installBinaries(n, target, pkg, entry, dir);
        return entry;
    }

    private dirNameFor(n: PackageName, previous: LockEntry | undefined, lock: LockFile): string {
        if (previous) return path.basename(previous.dir);
        const taken = Object.values(lock.packages).some((e) => path.basename(e.dir).toLowerCase() === n.repo.toLowerCase() && depKey(e) !== depKey(n));
        return taken ? `${n.owner}-${n.repo}` : n.repo;
    }

    /** Server, os, arch and variant packages are installed for (project pawn.json "target" + detection). */
    target(): InstallTarget {
        let spec;
        try {
            spec = this.manifest()?.target;
        } catch {
            spec = undefined;
        }
        return resolveTarget(spec, this.opts.server);
    }

    /**
     * Downloads the release asset(s) for every target system, then places plugins in plugins/
     * (registered in server.cfg / config.json for the server that runs here), components in
     * components/ (open.mp) and runtime libraries next to the server executable. .inc folders inside
     * the assets are added to the include path.
     */
    private async installBinaries(n: PackageName, target: Resolved, pkg: PawnJson | undefined, entry: LockEntry, pkgDir: string): Promise<void> {
        let spec;
        try {
            spec = this.manifest()?.target;
        } catch {
            spec = undefined;
        }
        const targets = resolveTargets(spec, this.opts.server);
        const kind = targets[0].server;
        const supports = supportsOf(pkg?.supports);
        const server = this.opts.server;
        if (kind && !supports.includes(kind)) {
            if (kind === 'samp') {
                // a component-only package cannot run on SA-MP
                this.log(`  ⚠ ${t('{0} is made for open.mp only: its binaries are not installed on a SA-MP server', displayName(n))}`);
                return;
            }
            this.log(`  · ${t('{0} is made for SA-MP: open.mp loads it as a legacy plugin', displayName(n))}`);
        }
        const declared = !!pkg?.plugins || !!pkg?.components;
        let release: Release | undefined;
        if (target.refType === 'tag') release = await this.gh.releaseByTag(n.owner, n.repo, target.ref);
        else if (declared) release = await this.gh.latestRelease(n.owner, n.repo);
        if (!release?.assets.length) {
            if (declared) this.log(`  ⚠ ${t('{0} declares plugins but its release has no files', displayName(n))}`);
            return;
        }

        const resDir = path.join(pkgDir, '.resources');
        fs.rmSync(resDir, { recursive: true, force: true });
        const serverDir = server?.dir ?? this.root;
        const rel = (p: string) => path.relative(this.root, p).split(path.sep).join('/');
        const copy = (src: string, destDir: string) => {
            fs.mkdirSync(destDir, { recursive: true });
            const dest = path.join(destDir, path.basename(src));
            try {
                fs.copyFileSync(src, dest);
            } catch {
                this.log(`  ⚠ ${t('Could not write {0} (is the server running?)', rel(dest))}`);
            }
            if (!entry.files.includes(rel(dest))) entry.files.push(rel(dest));
            return dest;
        };
        // one download per release file, even when it serves several systems
        const extracted = new Map<string, { dir: string; files: string[] }>();
        const fetchAsset = async (asset: (typeof release.assets)[number]) => {
            let x = extracted.get(asset.name);
            if (x) return x;
            this.log(`  ↓ ${asset.name} (${(asset.size / 1024).toFixed(0)} KB, release ${release!.tag_name})`);
            const buf = await this.gh.download(asset.browser_download_url);
            const dir = extracted.size || targets.length > 1 || (pkg?.components && pkg.plugins) ? path.join(resDir, String(extracted.size)) : resDir;
            let files: string[];
            if (/\.(zip|tar\.gz|tgz)$/i.test(asset.name)) files = extractTo(readArchive(buf), dir);
            else {
                fs.mkdirSync(dir, { recursive: true });
                const f = path.join(dir, asset.name);
                fs.writeFileSync(f, buf);
                files = [f];
            }
            // an archive inside the archive (e.g. linux.zip → linux.tar.gz) and no binaries outside it
            if (!files.some((f) => /\.(dll|so)$/i.test(f))) {
                for (const inner of files.filter((f) => /\.(zip|tar\.gz|tgz)$/i.test(f))) {
                    try {
                        files.push(...extractTo(readArchive(fs.readFileSync(inner)), path.join(dir, path.basename(inner).replace(/\.(zip|tar\.gz|tgz)$/i, ''))));
                    } catch {
                        /* not an archive we can read */
                    }
                }
            }
            x = { dir, files };
            extracted.set(asset.name, x);
            return x;
        };

        const assetIncludes: string[] = [];
        let anyBinary = false;
        const labels: string[] = [];
        for (const [i, tgt] of targets.entries()) {
            const runsHere = i === 0 && tgt.os === localOs(server);
            if (targets.length > 1) this.log(`  [${targetLabel(tgt)}${runsHere ? '' : ' — ' + t('files only, for another machine')}]`);
            // which files: the open.mp component asset when the author ships one, else the plugins asset
            const wantComponents = !!pkg?.components && tgt.server !== 'samp';
            const wantPlugins = pkg?.plugins !== false && (!wantComponents || !tgt.server);
            const picks: Array<{ asset: (typeof release.assets)[number]; role: 'plugin' | 'component' }> = [];
            if (wantComponents) {
                const c = pickAsset(release.assets, tgt, pkg!.components);
                if (c) picks.push({ asset: c, role: 'component' });
                else this.log(`  ⚠ ${t('No open.mp component file in release {0} for {1}', release.tag_name, targetLabel(tgt))}`);
            }
            if (wantPlugins) {
                // a file declared as the open.mp component is never taken as the plugin (patterns may overlap)
                const componentFiles = new Set(pkg?.components ? release.assets.filter((x) => Object.values(pkg.components!).flat().some((g) => globMatch(g, x.name))).map((x) => x.name) : []);
                const p = pickAsset(release.assets.filter((x) => !componentFiles.has(x.name)), tgt, pkg?.plugins);
                if (p && !picks.some((x) => x.asset === p)) picks.push({ asset: p, role: 'plugin' });
                else if (!p && pkg?.plugins) this.log(`  ⚠ ${t('No file in release {0} for {1} (pawn.json keys: {2})', release.tag_name, targetLabel(tgt), Object.keys(pkg.plugins).join(', '))}`);
            }
            for (const { asset, role } of picks) {
                const got = await fetchAsset(asset);
                let dir = got.dir;
                let files = got.files;
                let layout: BinaryLayout;
                let includeDirs: string[];
                if (pkg?.layout) {
                    // the author said where everything is
                    const l = applyLayout(got.dir, got.files, pkg.layout, tgt.server, tgt.os);
                    for (const m of l.missing) this.log(`  ⚠ ${t('"layout": {0} not found in {1}', m, asset.name)}`);
                    layout = l;
                    includeDirs = l.includes;
                } else {
                // one folder per server inside the archive (samp/…, open.mp/…): only this server's folder
                if (tgt.server) {
                    const own = serverFolder(got.dir, tgt.server);
                    if (own) {
                        dir = own;
                        files = got.files.filter((f) => f.startsWith(own + path.sep));
                        this.log(`  · ${t('Using the {0} folder of the archive', rel(own).split('/').pop()!)}`);
                    } else if (onlyOtherServerFolder(got.dir, tgt.server)) {
                        this.log(`  ⚠ ${t('{0} has no folder for this server', asset.name)}`);
                        continue;
                    }
                }
                const flatAs = role === 'component' || (supports.length === 1 && supports[0] === 'openmp') ? 'component' : 'plugin';
                layout = classifyBinaries(dir, files, tgt.os, tgt.server, { arch: tgt.arch, flatAs });
                includeDirs = includeDirsInAsset(dir).map((inc) => path.relative(got.dir, path.join(dir, inc)).split(path.sep).join('/'));
                }
                if (!layout.plugins.length && !layout.components.length) {
                    if (declared) this.log(`  ⚠ ${t('No .dll/.so for {0} inside {1}', tgt.os, asset.name)}`);
                    continue;
                }
                anyBinary = true;
                if (!labels.includes(targetLabel(tgt))) labels.push(targetLabel(tgt));
                for (const p of layout.plugins) {
                    const dest = copy(p, path.join(serverDir, 'plugins'));
                    if (server) {
                        const name = pluginConfigName(dest, server.kind, tgt.os);
                        if (runsHere) {
                            if (fs.existsSync(server.configFile) || server.kind === 'samp') setServerPlugin(server, name, true);
                            if (!entry.plugins.includes(name)) entry.plugins.push(name);
                        } else if (server.kind === 'samp') {
                            // one server.cfg cannot name both: Linux needs the .so in the name
                            this.log(`  · ${t('On the {0} server, server.cfg needs: plugins {1}', tgt.os, name)}`);
                        }
                    }
                    this.log(`  + plugin ${path.basename(dest)}`);
                }
                for (const c of layout.components) {
                    copy(c, path.join(serverDir, 'components'));
                    this.log(`  + component ${path.basename(c)}`);
                }
                for (const l of layout.libraries) {
                    copy(l, serverDir);
                    this.log(`  + ${path.basename(l)}`);
                }
                for (const sk of layout.skipped) {
                    this.log(
                        tgt.server === 'samp'
                            ? `  · ${t('{0} skipped: open.mp component, this is a SA-MP server', path.basename(sk))}`
                            : `  · ${t('{0} skipped: the open.mp component version is used instead', path.basename(sk))}`,
                    );
                }
                if (i === 0) for (const inc of includeDirs) assetIncludes.push(rel(path.join(got.dir, inc)));
            }
        }
        if (!anyBinary && !assetIncludes.length) {
            // a source/include-only asset: the repository source is already installed
            fs.rmSync(resDir, { recursive: true, force: true });
            return;
        }
        entry.asset = [...extracted.keys()].join(', ');
        entry.target = labels.join(' + ') || targetLabel(targets[0]);
        // the .inc files of the release match its binaries: they come first, and the repository source
        // (SDKs, C++ code…) is not kept when the release brings everything
        if (assetIncludes.length) {
            entry.includePaths = [...new Set(assetIncludes)];
            for (const keep of fs.readdirSync(pkgDir)) {
                if (keep === '.resources' || /^(pawn\.json|readme.*|license.*|licence.*|changelog.*)$/i.test(keep)) continue;
                fs.rmSync(path.join(pkgDir, keep), { recursive: true, force: true });
            }
        }
    }

    /** One line saying what a package put in the project. */
    summary(n: PackageName, e: LockEntry): string {
        const incs = new Set<string>();
        for (const p of e.includePaths) {
            try {
                for (const f of fs.readdirSync(path.resolve(this.root, p))) if (/\.inc$/i.test(f)) incs.add(f);
            } catch {
                /* folder gone */
            }
        }
        const parts: string[] = [];
        const comps = e.files.filter((f) => /(^|\/)components\//i.test(f)).map((f) => path.basename(f));
        if (e.plugins.length) parts.push(t('plugin {0}', e.plugins.join(', ')) + (this.opts.server?.kind === 'samp' ? ` (${t('added to server.cfg')})` : this.opts.server ? ` (${t('added to config.json')})` : ''));
        if (comps.length) parts.push(t('component {0}', comps.join(', ')));
        if (incs.size) parts.push(t('include {0}', [...incs].slice(0, 6).join(', ') + (incs.size > 6 ? '…' : '')));
        return `✔ ${displayName(n)} ${e.ref}${e.target ? ` [${e.target}]` : ''}: ${parts.length ? parts.join(' · ') : t('installed (no plugin or include found)')}`;
    }

    /** The compiler include folder of the server (pawno/include or qawno/include), or undefined. */
    includeCopyDir(): string | undefined {
        if (this.opts.copyIncludesTo === false) return undefined;
        if (this.opts.copyIncludesTo) return this.opts.copyIncludesTo;
        const server = this.opts.server;
        if (!server) return undefined;
        const order = server.kind === 'openmp' ? ['qawno', 'pawno'] : ['pawno', 'qawno'];
        for (const c of order) if (fs.existsSync(path.join(server.dir, c))) return path.join(server.dir, c, 'include');
        return path.join(server.dir, order[0], 'include');
    }

    /**
     * Copies the package's .inc files (keeping sub-folders, e.g. YSI_Coding/y_hooks.inc) into the
     * server's include folder. Files already there that no package put there are never overwritten.
     */
    private copyIncludes(e: LockEntry, lock: LockFile): void {
        const dest = this.includeCopyDir();
        if (!dest) return;
        const rel = (p: string) => path.relative(this.root, p).split(path.sep).join('/');
        const ownedByAny = new Set(Object.values(lock.packages).flatMap((o) => o.files.map((f) => f.toLowerCase())));
        const SKIP = /^(\.git|\.github|tests?|examples?|docs?|src|deps|lib|libs|third_party|external|cmake|build|samp-sdk|omp-sdk|sdk|\.resources)$/i;
        const pkgDir = path.resolve(this.root, e.dir);
        let copied = 0;
        const kept: string[] = [];
        for (const inc of e.includePaths) {
            const base = path.resolve(this.root, inc);
            // the package root as include folder: only its own .inc files and include-like folders, not its source tree
            const walk = (dir: string, depth: number) => {
                let items: fs.Dirent[];
                try {
                    items = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return;
                }
                for (const it of items) {
                    const abs = path.join(dir, it.name);
                    if (it.isDirectory()) {
                        if (depth < 4 && !(SKIP.test(it.name) && dir !== base) && !(base === pkgDir && SKIP.test(it.name))) walk(abs, depth + 1);
                        continue;
                    }
                    if (!/\.inc$/i.test(it.name)) continue;
                    const target = path.join(dest, path.relative(base, abs));
                    const key = rel(target).toLowerCase();
                    if (fs.existsSync(target) && !ownedByAny.has(key) && !e.files.some((f) => f.toLowerCase() === key)) {
                        // the same file (an earlier manual copy): it becomes the package's; a different one is kept
                        let same = false;
                        try {
                            same = fs.readFileSync(target).equals(fs.readFileSync(abs));
                        } catch {
                            same = false;
                        }
                        if (!same) {
                            kept.push(path.relative(dest, target).split(path.sep).join('/'));
                            continue;
                        }
                    }
                    try {
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.copyFileSync(abs, target);
                        if (!e.files.some((f) => f.toLowerCase() === key)) e.files.push(rel(target));
                        copied++;
                    } catch {
                        this.log(`  ⚠ ${t('Could not write {0}', rel(target))}`);
                    }
                }
            };
            walk(base, 0);
        }
        if (copied) this.log(`  + ${t('{0} include file(s) in {1}', copied, rel(dest) || dest)}`);
        if (kept.length) this.log(`  ⚠ ${t('Kept the existing {0} in {1}: it is different from the package\'s and was not installed by Pawn Studio (delete it to use the package\'s)', kept.slice(0, 3).join(', ') + (kept.length > 3 ? '…' : ''), rel(dest))}`);
    }

    private uninstallFiles(e: LockEntry, lock: LockFile): void {
        const server = this.opts.server;
        const others = Object.values(lock.packages).filter((o) => depKey(o) !== depKey(e));
        for (const name of e.plugins) {
            if (server && !others.some((o) => o.plugins.includes(name))) setServerPlugin(server, name, false);
        }
        const incDir = this.includeCopyDir();
        for (const f of e.files) {
            if (others.some((o) => o.files.includes(f))) continue; // shared runtime library
            const abs = path.resolve(this.root, f);
            try {
                fs.rmSync(abs, { force: true });
            } catch {
                this.log(`  ⚠ ${t('Could not delete {0} (is the server running?)', f)}`);
                continue;
            }
            // empty folders left in the include folder (YSI_Coding/…)
            for (let d = path.dirname(abs); incDir && d.startsWith(incDir + path.sep); d = path.dirname(d)) {
                try {
                    if (fs.readdirSync(d).length) break;
                    fs.rmdirSync(d);
                } catch {
                    break;
                }
            }
        }
    }

    /** Removes packages that are neither direct nor reachable from a direct one. */
    private prune(lock: LockFile): void {
        const direct = this.directDeps();
        for (const [k, e] of Object.entries(lock.packages)) {
            e.direct = direct.has(k);
            if (e.direct) e.dev = direct.get(k)!.dev || undefined;
        }
        const reachable = new Set<string>();
        const visit = (k: string) => {
            if (reachable.has(k) || !lock.packages[k]) return;
            reachable.add(k);
            lock.packages[k].dependencies.forEach(visit);
        };
        direct.forEach((_, k) => visit(k));
        for (const [k, e] of Object.entries(lock.packages)) {
            if (reachable.has(k)) continue;
            this.log(`− ${t('Removing {0}', k)}`);
            this.uninstallFiles(e, lock);
            fs.rmSync(path.resolve(this.root, e.dir), { recursive: true, force: true });
            delete lock.packages[k];
        }
    }
}

function describeTags(tags: TagInfo[]): string {
    if (!tags.length) return '—';
    const names = tags.map((x) => x.name);
    return names.slice(0, 8).join(', ') + (names.length > 8 ? '…' : '');
}

export type { Requirement };
