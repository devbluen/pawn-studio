/**
 * Auto-detection for packages that have no pawn.json (or leave fields out):
 *  - which folders export .inc files;
 *  - which release asset holds the plugin for this platform;
 *  - inside that asset: plugins, open.mp components, extra runtime libraries (e.g. libmariadb.dll).
 * Pure functions over the file system — no network, no VS Code.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Platform, PluginAssets } from './manifest';
import { AssetMap, globsFor, InstallTarget, LayoutRoles, LayoutSpec } from './target';

const SKIP_DIRS = /^(\.git|\.github|\.resources|node_modules|tests?|examples?|samples?|docs?|\.vscode|build|cmake|lib|libs|external|vendor|dependencies)$/i;
const INCLUDE_DIR = /^(include|includes|inc)$/i;

function walk(dir: string, depth: number, visit: (abs: string, rel: string, isDir: boolean) => boolean | void, rel = ''): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const abs = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
            if (visit(abs, r, true) === false || depth <= 0) continue;
            walk(abs, depth - 1, visit, r);
        } else visit(abs, r, false);
    }
}

function hasInc(dir: string): boolean {
    try {
        return fs.readdirSync(dir).some((f) => /\.inc$/i.test(f));
    } catch {
        return false;
    }
}

/**
 * Include folders (relative, "/"-separated; "" = the folder itself) exported by a package source tree.
 * Priority: explicit `include` → folders named include/includes (pawno/include, qawno/include…) → the root.
 */
export function detectIncludeDirs(root: string, explicit?: string | string[]): string[] {
    if (explicit !== undefined) {
        const list = (Array.isArray(explicit) ? explicit : [explicit]).map((p) => p.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, ''));
        return list.filter((p) => fs.existsSync(path.join(root, p)));
    }
    const found: string[] = [];
    walk(root, 3, (abs, rel, isDir) => {
        if (!isDir) return;
        if (SKIP_DIRS.test(path.basename(abs))) return false;
        if (INCLUDE_DIR.test(path.basename(abs)) && hasInc(abs)) {
            found.push(rel);
            return false;
        }
    });
    // .inc files at the root win over nested include folders (e.g. YSI, streamer source)
    if (hasInc(root) || !found.length) return [''];
    return found;
}

const SERVER_DIRS: Record<'samp' | 'openmp', RegExp> = {
    samp: /^(samp|sa-mp|sa_mp|legacy)$/i,
    openmp: /^(open\.mp|openmp|open-mp|omp)$/i,
};

/**
 * Archives that keep one folder per server ("samp/plugins/x.dll" + "open.mp/components/x.dll"): the
 * folder for `server`, looked up in the first two levels. undefined = the archive is not split that way.
 */
export function serverFolder(root: string, server: 'samp' | 'openmp'): string | undefined {
    const levels = [root];
    try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) levels.push(path.join(root, e.name));
    } catch {
        return undefined;
    }
    for (const dir of levels) {
        let subs: string[];
        try {
            subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
            continue;
        }
        const mine = subs.find((n) => SERVER_DIRS[server].test(n));
        const other = subs.find((n) => SERVER_DIRS[server === 'samp' ? 'openmp' : 'samp'].test(n));
        if (mine) return path.join(dir, mine);
        if (other) return undefined; // split per server, but nothing for this one
    }
    return undefined;
}

/** True when the archive has a folder for the other server only (nothing for `server`). */
export function onlyOtherServerFolder(root: string, server: 'samp' | 'openmp'): boolean {
    if (serverFolder(root, server)) return false;
    return !!serverFolder(root, server === 'samp' ? 'openmp' : 'samp');
}

export interface LayoutResult extends BinaryLayout {
    /** include folders (relative to the archive root) */
    includes: string[];
    /** declared paths that matched nothing in the archive */
    missing: string[];
}

/**
 * Applies a package's "layout": the files of each role for one server (plus "all"), from folders or
 * patterns relative to the archive root. A single top folder in the archive (e.g. "name-1.0/") is
 * looked through when the declared paths are not found at the root.
 */
export function applyLayout(root: string, files: string[], spec: LayoutSpec, server: 'samp' | 'openmp' | undefined, platform: Platform): LayoutResult {
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
    // "." (or "") = the root of the archive
    const list = (v: string | string[] | undefined) =>
        (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((p) => p.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')).map((p) => (p === '.' ? '' : p));
    const roles: LayoutRoles[] = [spec.all ?? {}, ...(server ? [spec[server] ?? {}] : [spec.samp ?? {}, spec.openmp ?? {}])];
    const all = (k: keyof LayoutRoles) => roles.flatMap((r) => list(r[k]));
    // the archive may wrap everything in one folder
    let base = '';
    const tops = [...new Set(files.map((f) => rel(f).split('/')[0]))];
    const declared = [...all('plugins'), ...all('components'), ...all('libraries'), ...all('include')];
    const found = (p: string, b: string) =>
        p === ''
            ? !b || files.some((f) => rel(f).startsWith(b + '/'))
            : files.some((f) => { const r = rel(f); const q = b ? b + '/' + p : p; return r === q || r.startsWith(q + '/') || (/[*?]/.test(p) && globToRegex(q).test(r)); });
    if (tops.length === 1 && declared.length && !declared.some((p) => found(p, '')) && declared.some((p) => found(p, tops[0]))) base = tops[0];
    const full = (p: string) => (base ? (p ? base + '/' + p : base) : p);
    // plugins are loaded by name (x.dll / x.so); components and libraries may be versioned (libboost.so.1.74.0)
    const ext = platform === 'windows' ? /\.dll$/i : /\.so$/i;
    const libExt = platform === 'windows' ? /\.dll$/i : /\.so(\.\d+)*$/i;
    const missing: string[] = [];
    const pick = (k: 'plugins' | 'components' | 'libraries') => {
        const out: string[] = [];
        for (const p of all(k)) {
            const q = full(p);
            const hit = files.filter((f) => {
                const r = rel(f);
                return /[*?]/.test(p) ? globToRegex(q).test(r) : r === q || r.startsWith(q + '/');
            });
            if (!hit.length) missing.push(p);
            out.push(...hit.filter((f) => (k === 'plugins' ? ext : libExt).test(f)));
        }
        return [...new Set(out)];
    };
    const plugins = pick('plugins');
    const components = pick('components');
    const libraries = pick('libraries');
    const includes: string[] = [];
    for (const p of all('include')) {
        const q = full(p);
        const has = q === '' ? files.some((f) => /\.inc$/i.test(f) && !rel(f).includes('/')) : files.some((f) => rel(f).startsWith(q + '/'));
        if (has) includes.push(q);
        else missing.push(p || '.');
    }
    return { plugins, components, libraries, skipped: [], includes, missing };
}

/** Folders inside an extracted release asset that hold .inc files (any name). */
export function includeDirsInAsset(root: string): string[] {
    const out: string[] = [];
    if (hasInc(root)) out.push('');
    walk(root, 4, (abs, rel, isDir) => {
        if (isDir && hasInc(abs)) out.push(rel);
    });
    return out;
}

// ───────────────────────── release assets ─────────────────────────

const ARCHIVE = /\.(zip|tar\.gz|tgz)$/i;
const BINARY = /\.(dll|so)$/i;
const WIN = /(win|windows|w32|msvc|\.dll$)/i;
const LINUX = /(linux|ubuntu|debian|centos|\.so$)/i;
const BAD = /(debug|pdb|symbols?|source|src\b|sources|dbg)/i;
const X64 = /(x64|x86_64|amd64|win64|64bit|-64\b)/i;
const DYNAMIC = /(dyn(amic|ssl)?|shared)/i;

function globToRegex(glob: string): RegExp {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${esc}$`, 'i');
}

/** File name matches a pawn.json pattern (* and ? wildcards, case-insensitive). */
export function globMatch(glob: string, name: string): boolean {
    return globToRegex(glob).test(name);
}

export interface AssetLike {
    name: string;
}

/**
 * Picks the release asset with the binaries for a target (or just a platform = 32-bit default build).
 * `map` from the package's pawn.json wins ("plugins"/"components": glob per target key, or false = none).
 * Otherwise names are scored by system, architecture and variant tokens; neutral archives (no system
 * in the name) are accepted as a fallback — they often ship both .dll and .so (e.g. streamer).
 */
export function pickAsset<T extends AssetLike>(assets: T[], target: InstallTarget | Platform, map?: AssetMap | false): T | undefined {
    if (map === false) return undefined;
    const t: InstallTarget = typeof target === 'string' ? { os: target, arch: 'x86' } : target;
    const explicit = globsFor(map, t);
    if (explicit) {
        for (const g of explicit.globs) {
            const a = assets.find((x) => globToRegex(g).test(x.name));
            if (a) return a;
        }
        return undefined;
    }
    // a map that has no key for this target: nothing was published for it
    if (map && Object.keys(map).length) return undefined;
    const platform = t.os;
    const mine = platform === 'windows' ? WIN : LINUX;
    const other = platform === 'windows' ? LINUX : WIN;
    let best: { a: T; score: number } | undefined;
    for (const a of assets) {
        const n = a.name;
        const isBin = BINARY.test(n);
        if (!ARCHIVE.test(n) && !isBin) continue;
        if (isBin && !(platform === 'windows' ? /\.dll$/i : /\.so$/i).test(n)) continue;
        if (BAD.test(n)) continue;
        const hasMine = mine.test(n);
        const hasOther = other.test(n.replace(/\.(zip|tar\.gz|tgz)$/i, ''));
        if (hasOther && !hasMine) continue;
        let score = hasMine ? 10 : 1;
        const is64 = X64.test(n.replace(/win64/i, 'x64'));
        if (t.arch === 'x64') score += is64 ? 6 : -2;
        else if (is64) score -= 6; // SA-MP and open.mp legacy plugins are 32-bit
        const dyn = DYNAMIC.test(n);
        if (t.variant === 'dynamic') score += dyn ? 3 : 0;
        else if (t.variant && new RegExp(t.variant.replace(/[^a-z0-9]/gi, ''), 'i').test(n)) score += 3;
        else if (dyn) score -= 1; // the default build is the static one
        if (platform === 'linux' && /\.tar\.gz$|\.tgz$/i.test(n)) score += 1;
        if (!best || score > best.score) best = { a, score };
    }
    return best?.a;
}

export interface BinaryLayout {
    /** .dll/.so loaded by the server as plugins (→ plugins/, registered in the config). */
    plugins: string[];
    /** open.mp components (→ components/, loaded automatically). */
    components: string[];
    /** Runtime libraries the plugins need (→ server root, e.g. libmariadb.dll, log-core.dll). */
    libraries: string[];
    /** binaries left out because the project's server does not use them */
    skipped: string[];
}

/**
 * Classifies the binaries of an extracted asset (absolute paths in, absolute paths out).
 * Archives with a plugins/ folder: only what is inside it is a plugin, other binaries are libraries.
 * Without one: every binary is a plugin. 64-bit duplicates are dropped when a 32-bit build exists.
 */
/**
 * Sorts the binaries of an extracted asset. `server` = the project's server: a package that ships the
 * same library as a SA-MP plugin and as an open.mp component gets the one that server loads.
 */
export function classifyBinaries(
    root: string,
    files: string[],
    platform: Platform,
    server?: 'samp' | 'openmp',
    opts: { arch?: 'x86' | 'x64'; flatAs?: 'plugin' | 'component' } = {},
): BinaryLayout {
    const ext = platform === 'windows' ? /\.dll$/i : /\.so$/i;
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
    let bins = files.filter((f) => ext.test(f));
    // Prefer 32-bit when the same file name exists in several builds (a plugin and a component with
    // the same name are not builds of each other: they are told apart below)
    const isComponent = (b: string) => /(^|\/)components\//i.test(rel(b));
    const byName = new Map<string, string[]>();
    for (const b of bins) {
        const k = (isComponent(b) ? 'c:' : 'p:') + path.basename(b).toLowerCase();
        byName.set(k, [...(byName.get(k) ?? []), b]);
    }
    const want64 = opts.arch === 'x64';
    bins = [...byName.values()].map((list) => list.find((b) => X64.test(rel(b)) === want64) ?? list[0]);
    bins = bins.filter((b) => !/(^|\/)(tests?|examples?)\//i.test(rel(b)));

    const inDir = (b: string, d: string) => new RegExp(`(^|/)${d}/`, 'i').test(rel(b));
    // components/ = open.mp; a flat archive of a package made only for open.mp holds components too
    const components = bins.filter((b) => inDir(b, 'components') || (opts.flatAs === 'component' && !inDir(b, 'plugins')));
    const rest = bins.filter((b) => !components.includes(b));
    const hasPluginsDir = rest.some((b) => inDir(b, 'plugins'));
    const plugins = hasPluginsDir ? rest.filter((b) => inDir(b, 'plugins')) : rest;
    const libraries = hasPluginsDir ? rest.filter((b) => !inDir(b, 'plugins')) : [];
    const skipped: string[] = [];
    if (server === 'samp') {
        // SA-MP has no components
        skipped.push(...components);
        return { plugins, components: [], libraries, skipped };
    }
    if (server === 'openmp') {
        // the component replaces the legacy plugin of the same name (loading both runs it twice)
        const names = new Set(components.map((c) => path.basename(c).toLowerCase()));
        const dup = plugins.filter((p) => names.has(path.basename(p).toLowerCase()));
        skipped.push(...dup);
        return { plugins: plugins.filter((p) => !dup.includes(p)), components, libraries, skipped };
    }
    return { plugins, components, libraries, skipped };
}
