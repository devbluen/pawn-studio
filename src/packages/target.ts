/**
 * Where a package is installed (server kind, operating system, architecture, build variant) and how a
 * package author maps release files to those targets in pawn.json.
 *
 *   "supports": ["samp", "openmp"]                     servers the package is made for (default: both)
 *   "plugins":    { "windows": "x-*-win32.zip", "linux-x86-dynamic": "x-*-linux-dynssl.tar.gz" }
 *   "components": { "windows": "x-omp-*-win.zip" }     open.mp components shipped as separate files
 *   "include":    "include"  or  { "samp": "include/samp", "openmp": "include/omp" }
 *
 * Asset keys: <os>, <os>-<arch>, <os>-<variant> or <os>-<arch>-<variant>; os = windows | linux,
 * arch = x86 | x64, variant = static | dynamic | any other word the author uses.
 */
import * as path from 'path';
import type { Platform, ServerInfo, ServerKind } from './manifest';

export type Arch = 'x86' | 'x64';

export interface InstallTarget {
    /** undefined = no server found: install what both servers use */
    server?: ServerKind;
    os: Platform;
    arch: Arch;
    /** build variant asked by the project (static, dynamic…); undefined = the default build */
    variant?: string;
}

/** "target" in the project's pawn.json. */
export interface TargetSpec {
    server?: ServerKind;
    /** one system, or several (e.g. ["windows", "linux"]: test on Windows, host on Linux) */
    os?: Platform | Platform[];
    arch?: Arch;
    variant?: string;
}

/** Release file glob(s) per target key. */
export type AssetMap = Record<string, string | string[]>;

/** Paths inside the release archive per role: a folder ("samp/plugins") or a pattern ("samp/plugins/*.dll"). */
export interface LayoutRoles {
    plugins?: string | string[];
    components?: string | string[];
    libraries?: string | string[];
    include?: string | string[];
}
/** "layout": roles per server; "all" applies to both. */
export type LayoutSpec = Partial<Record<'samp' | 'openmp' | 'all', LayoutRoles>>;

export type IncludeSpec = string | string[] | { samp?: string | string[]; openmp?: string | string[]; all?: string | string[] };

export const SERVER_NAME: Record<ServerKind, string> = { samp: 'SA-MP', openmp: 'open.mp' };

export function hostPlatform(): Platform {
    return process.platform === 'win32' ? 'windows' : 'linux';
}

/** System of the server found in the project (by its executable), else this machine. */
export function localOs(server: ServerInfo | undefined): Platform {
    const exe = server?.executable ? path.basename(server.executable) : undefined;
    return exe ? (/\.exe$/i.test(exe) ? 'windows' : 'linux') : hostPlatform();
}

/**
 * Every target to install for: one per system in "target.os". The first one is the server that runs
 * here (its config file is updated); the others only get their files (for a production host).
 */
export function resolveTargets(spec: TargetSpec | undefined, server: ServerInfo | undefined): InstallTarget[] {
    const local = localOs(server);
    const list = (Array.isArray(spec?.os) ? spec!.os : spec?.os ? [spec.os] : [local]).filter((o): o is Platform => o === 'windows' || o === 'linux');
    const unique = [...new Set(list.length ? list : [local])];
    unique.sort((a, b) => (a === local ? -1 : b === local ? 1 : 0));
    return unique.map((os) => ({ ...resolveTarget({ ...spec, os }, server) }));
}

/** The target from the project's pawn.json "target", the server found and the machine. */
export function resolveTarget(spec: TargetSpec | undefined, server: ServerInfo | undefined): InstallTarget {
    const os = Array.isArray(spec?.os) ? spec!.os[0] : spec?.os;
    return {
        server: spec?.server ?? server?.kind,
        os: os ?? localOs(server),
        arch: spec?.arch ?? 'x86', // SA-MP and open.mp load 32-bit Pawn plugins
        variant: spec?.variant?.toLowerCase() || undefined,
    };
}

export function targetLabel(t: InstallTarget): string {
    return [t.server ? SERVER_NAME[t.server] : undefined, `${t.os}-${t.arch}${t.variant ? '-' + t.variant : ''}`].filter(Boolean).join(' · ');
}

/** Asset keys to try, most specific first. A plain "windows"/"linux" key means the 32-bit build. */
export function targetKeys(t: InstallTarget): string[] {
    const keys: string[] = [];
    if (t.variant) keys.push(`${t.os}-${t.arch}-${t.variant}`);
    if (t.variant && t.arch === 'x86') keys.push(`${t.os}-${t.variant}`);
    keys.push(`${t.os}-${t.arch}`);
    if (t.arch === 'x86') keys.push(t.os);
    return keys;
}

/** The glob(s) a map gives for this target, and the key that matched. */
export function globsFor(map: AssetMap | undefined, t: InstallTarget): { key: string; globs: string[] } | undefined {
    if (!map) return undefined;
    const norm = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
    for (const k of targetKeys(t)) {
        const v = norm.get(k);
        if (v) return { key: k, globs: Array.isArray(v) ? v : [v] };
    }
    return undefined;
}

/** "supports" normalized; missing = both. */
export function supportsOf(v: unknown): ServerKind[] {
    const list = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((s) => String(s).toLowerCase().replace(/[^a-z]/g, ''));
    const out = new Set<ServerKind>();
    for (const s of list) {
        if (s === 'both' || s === 'all') { out.add('samp'); out.add('openmp'); }
        if (s === 'samp' || s === 'legacy') out.add('samp');
        if (s === 'openmp' || s === 'omp') out.add('openmp');
    }
    return out.size ? [...out] : ['samp', 'openmp'];
}

/** Include folders for the server (object form) or for everyone (string / array form). */
export function includeFor(spec: unknown, server: ServerKind | undefined): string | string[] | undefined {
    if (spec === undefined || typeof spec === 'string' || Array.isArray(spec)) return spec as string | string[] | undefined;
    if (spec && typeof spec === 'object') {
        const o = spec as { samp?: string | string[]; openmp?: string | string[]; all?: string | string[] };
        const arr = (x: string | string[] | undefined) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
        const list = [...arr(o.all), ...arr(server ? o[server] : [...arr(o.samp), ...arr(o.openmp)])];
        return list.length ? list : undefined;
    }
    return undefined;
}
