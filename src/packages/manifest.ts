/**
 * pawn.json (Pawn Studio format), pawn-lock.json and server configuration (server.cfg / config.json).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AssetMap, IncludeSpec, LayoutSpec, TargetSpec } from './target';

export type Platform = 'windows' | 'linux';

/** Release asset glob(s) per target key ("windows", "linux-x64", "linux-x86-dynamic"…), or false = no binaries. */
export type PluginAssets = false | AssetMap;

export interface PawnJson {
    name?: string;
    version?: string;
    description?: string;
    /** Main .pwn file of the project (e.g. gamemodes/main.pwn). */
    entry?: string;
    /** Generated .amx (default: next to the entry). */
    output?: string;
    /** "user/repo": "requirement" — see deps.ts for the requirement syntax. */
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    // ── for package authors ──
    /** Folder(s) with the .inc files the package exports, optionally per server (default: detected). */
    include?: IncludeSpec;
    /** Servers the package is made for: "samp", "openmp" or both (default: both). */
    supports?: string | string[];
    /** Release assets with the binaries (SA-MP plugins, or files with plugins/ and components/ inside). */
    plugins?: PluginAssets;
    /** Release assets with open.mp components, when they are separate files from "plugins". */
    components?: AssetMap;
    /** Where each kind of file is inside the release archive, per server (instead of detection). */
    layout?: LayoutSpec;
    // ── for projects ──
    /** Where packages are installed: server, os, arch, variant (default: detected). */
    target?: TargetSpec;
    /** Compiler for this project (wins over the pawnStudio.* settings). Paths are relative to pawn.json. */
    compiler?: { path?: string; args?: string[]; includes?: string[] };
    [k: string]: unknown;
}

export interface LockEntry {
    owner: string;
    repo: string;
    /** requirement as written in pawn.json (or in the parent package's pawn.json) */
    requirement: string;
    ref: string;
    refType: 'tag' | 'branch' | 'commit';
    commit?: string;
    dir: string; // relative to the project root
    includePaths: string[]; // relative to the project root
    plugins: string[]; // registered plugin names (as written in server.cfg / config.json)
    files: string[]; // files copied to the server (relative to the project root)
    asset?: string; // release asset the binaries came from (several: joined with ", ")
    target?: string; // what the binaries were chosen for, e.g. "SA-MP · windows-x86"
    dependencies: string[]; // keys (lowercase owner/repo) of this package's direct dependencies
    direct: boolean;
    dev?: boolean;
    installedAt: string;
}

export interface LockFile {
    lockVersion: 2;
    packages: Record<string, LockEntry>;
}

export const MANIFEST = 'pawn.json';
export const LOCKFILE = 'pawn-lock.json';

export function currentPlatform(): Platform {
    return process.platform === 'win32' ? 'windows' : 'linux';
}

function readJson<T>(file: string): T | undefined {
    try {
        const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
        return JSON.parse(txt) as T;
    } catch {
        return undefined;
    }
}

function writeJson(file: string, data: unknown): void {
    fs.writeFileSync(file, JSON.stringify(data, null, '\t') + '\n', 'utf8');
}

/** Why a pawn.json cannot be used (undefined = fine). */
export function manifestProblem(m: unknown): string | undefined {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not-object';
    for (const f of ['dependencies', 'devDependencies'] as const) {
        const d = (m as Record<string, unknown>)[f];
        if (d === undefined) continue;
        if (Array.isArray(d)) return 'array-dependencies';
        if (typeof d !== 'object' || d === null || Object.values(d).some((v) => typeof v !== 'string')) return 'bad-dependencies';
    }
    return undefined;
}

/** Reads the project's pawn.json. Throws a readable error when it exists but is unusable. */
export function readManifest(root: string): PawnJson | undefined {
    const file = path.join(root, MANIFEST);
    if (!fs.existsSync(file)) return undefined;
    const m = readJson<PawnJson>(file);
    if (m === undefined) throw new ManifestError(file, 'invalid-json');
    const problem = manifestProblem(m);
    if (problem) throw new ManifestError(file, problem);
    return m;
}

/** Reads a downloaded package's pawn.json; anything not in our format is ignored (auto-detection is used). */
export function readPackageManifest(dir: string): PawnJson | undefined {
    const m = readJson<PawnJson>(path.join(dir, MANIFEST));
    return m && !manifestProblem(m) ? m : undefined;
}

export class ManifestError extends Error {
    constructor(
        readonly file: string,
        readonly problem: string,
    ) {
        super(`${file}: ${problem}`);
    }
}

export function writeManifest(root: string, m: PawnJson): void {
    for (const f of ['dependencies', 'devDependencies'] as const) {
        const d = m[f];
        if (!d) continue;
        if (f === 'devDependencies' && !Object.keys(d).length) {
            delete m[f];
            continue;
        }
        const sorted: Record<string, string> = {};
        for (const k of Object.keys(d).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) sorted[k] = d[k];
        m[f] = sorted;
    }
    writeJson(path.join(root, MANIFEST), m);
}

export function readLock(root: string): LockFile {
    const l = readJson<LockFile>(path.join(root, LOCKFILE));
    return l && l.lockVersion === 2 && l.packages ? l : { lockVersion: 2, packages: {} };
}

export function writeLock(root: string, l: LockFile): void {
    const sorted: Record<string, LockEntry> = {};
    for (const k of Object.keys(l.packages).sort()) sorted[k] = l.packages[k];
    writeJson(path.join(root, LOCKFILE), { lockVersion: 2, packages: sorted });
}

// ───────────────────────── server ─────────────────────────

export type ServerKind = 'samp' | 'openmp';

export interface ServerInfo {
    dir: string;
    kind: ServerKind;
    executable?: string;
    configFile: string;
}

const SERVER_EXES: Array<[string, ServerKind]> = [
    ['omp-server.exe', 'openmp'],
    ['omp-server', 'openmp'],
    ['samp-server.exe', 'samp'],
    ['samp03svr', 'samp'],
];

/** Looks for the server walking up from `start` (up to the drive root). */
export function findServer(start: string, explicit?: string): ServerInfo | undefined {
    const check = (dir: string): ServerInfo | undefined => {
        for (const [exe, kind] of SERVER_EXES) {
            const p = path.join(dir, exe);
            if (fs.existsSync(p)) {
                return { dir, kind, executable: p, configFile: path.join(dir, kind === 'openmp' ? 'config.json' : 'server.cfg') };
            }
        }
        return undefined;
    };
    if (explicit) {
        if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
            const dir = path.dirname(explicit);
            const kind: ServerKind = /omp/i.test(path.basename(explicit)) ? 'openmp' : 'samp';
            return { dir, kind, executable: explicit, configFile: path.join(dir, kind === 'openmp' ? 'config.json' : 'server.cfg') };
        }
        return check(explicit);
    }
    let dir = path.resolve(start);
    for (;;) {
        const found = check(dir);
        if (found) return found;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // No executable: use the folder with server.cfg / config.json, if any.
    dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'gamemodes'))) {
            return { dir, kind: 'openmp', configFile: path.join(dir, 'config.json') };
        }
        if (fs.existsSync(path.join(dir, 'server.cfg'))) return { dir, kind: 'samp', configFile: path.join(dir, 'server.cfg') };
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** Plugin name as it must appear in the server configuration. */
export function pluginConfigName(file: string, kind: ServerKind, platform = currentPlatform()): string {
    const base = path.basename(file);
    if (kind === 'openmp') return base.replace(/\.(dll|so)$/i, '');
    return platform === 'windows' ? base.replace(/\.dll$/i, '') : base;
}

function samePlugin(a: string, b: string): boolean {
    const n = (s: string) => s.toLowerCase().replace(/\.(dll|so)$/, '');
    return n(a) === n(b);
}

export function readServerPlugins(server: ServerInfo): string[] {
    if (!fs.existsSync(server.configFile)) return [];
    if (server.kind === 'openmp') {
        const cfg = readJson<{ pawn?: { legacy_plugins?: string[] } }>(server.configFile);
        return cfg?.pawn?.legacy_plugins ?? [];
    }
    const txt = fs.readFileSync(server.configFile, 'latin1');
    const m = /^[ \t]*plugins[ \t]+(.*)$/m.exec(txt);
    return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

/** Adds/removes a plugin in the server configuration. Returns true if it changed. */
export function setServerPlugin(server: ServerInfo, name: string, enabled: boolean): boolean {
    if (server.kind === 'openmp') {
        const cfg = readJson<Record<string, any>>(server.configFile) ?? {};
        cfg.pawn = cfg.pawn ?? {};
        const list: string[] = cfg.pawn.legacy_plugins ?? [];
        const has = list.some((p) => samePlugin(p, name));
        if (has === enabled) return false;
        cfg.pawn.legacy_plugins = enabled ? [...list, name] : list.filter((p) => !samePlugin(p, name));
        fs.writeFileSync(server.configFile, JSON.stringify(cfg, null, 4) + '\n', 'utf8');
        return true;
    }
    let txt = fs.existsSync(server.configFile) ? fs.readFileSync(server.configFile, 'latin1') : '';
    const re = /^([ \t]*plugins[ \t]*)(.*)$/m;
    const m = re.exec(txt);
    const list = m ? m[2].trim().split(/\s+/).filter(Boolean) : [];
    const has = list.some((p) => samePlugin(p, name));
    if (has === enabled) return false;
    const next = enabled ? [...list, name] : list.filter((p) => !samePlugin(p, name));
    if (m) txt = txt.replace(re, `plugins ${next.join(' ')}`);
    else txt = txt.replace(/\s*$/, '') + `\nplugins ${next.join(' ')}\n`;
    fs.writeFileSync(server.configFile, txt, 'latin1');
    return true;
}

/** Reads a server.cfg key (e.g. rcon_password, port, gamemode0). */
export function readServerCfgValue(server: ServerInfo, key: string): string | undefined {
    if (!fs.existsSync(server.configFile)) return undefined;
    if (server.kind === 'openmp') {
        const cfg = readJson<Record<string, any>>(server.configFile);
        const map: Record<string, (c: any) => unknown> = {
            rcon_password: (c) => c?.rcon?.password,
            port: (c) => c?.network?.port,
            gamemode0: (c) => (c?.pawn?.main_scripts ?? [])[0],
        };
        const v = map[key]?.(cfg);
        return v === undefined ? undefined : String(v);
    }
    const txt = fs.readFileSync(server.configFile, 'latin1');
    const m = new RegExp(`^[ \\t]*${key}[ \\t]+(.*)$`, 'm').exec(txt);
    return m ? m[1].trim() : undefined;
}
