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

function globToRegex(glob: string): RegExp {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${esc}$`, 'i');
}

export interface AssetLike {
    name: string;
}

/**
 * Picks the release asset with the binaries for `platform`.
 * `plugins` from the package's pawn.json wins (glob, or false = none). Otherwise: scores names by
 * platform tokens; neutral archives (no platform in the name) are accepted as a fallback — they
 * often ship both .dll and .so (e.g. streamer).
 */
export function pickAsset<T extends AssetLike>(assets: T[], platform: Platform, plugins?: PluginAssets): T | undefined {
    if (plugins === false) return undefined;
    const glob = plugins?.[platform];
    if (glob) return assets.find((a) => globToRegex(glob).test(a.name));
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
        if (X64.test(n)) score -= 5; // SA-MP and open.mp legacy plugins are 32-bit
        if (/static/i.test(n)) score -= 1;
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
}

/**
 * Classifies the binaries of an extracted asset (absolute paths in, absolute paths out).
 * Archives with a plugins/ folder: only what is inside it is a plugin, other binaries are libraries.
 * Without one: every binary is a plugin. 64-bit duplicates are dropped when a 32-bit build exists.
 */
export function classifyBinaries(root: string, files: string[], platform: Platform): BinaryLayout {
    const ext = platform === 'windows' ? /\.dll$/i : /\.so$/i;
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
    let bins = files.filter((f) => ext.test(f));
    // Prefer 32-bit when the same file name exists in several builds
    const byName = new Map<string, string[]>();
    for (const b of bins) {
        const k = path.basename(b).toLowerCase();
        byName.set(k, [...(byName.get(k) ?? []), b]);
    }
    bins = [...byName.values()].map((list) => list.find((b) => !X64.test(rel(b))) ?? list[0]);
    bins = bins.filter((b) => !/(^|\/)(tests?|examples?)\//i.test(rel(b)));

    const inDir = (b: string, d: string) => new RegExp(`(^|/)${d}/`, 'i').test(rel(b));
    const components = bins.filter((b) => inDir(b, 'components'));
    const rest = bins.filter((b) => !components.includes(b));
    const hasPluginsDir = rest.some((b) => inDir(b, 'plugins'));
    const plugins = hasPluginsDir ? rest.filter((b) => inDir(b, 'plugins')) : rest;
    const libraries = hasPluginsDir ? rest.filter((b) => !inDir(b, 'plugins')) : [];
    return { plugins, components, libraries };
}
