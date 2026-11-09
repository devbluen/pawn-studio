/**
 * Pawn #include graph — no VS Code dependency (testable in plain Node).
 *
 * Responsible for:
 *  - extracting the #include/#tryinclude directives of a file (ignoring comments);
 *  - resolving each include to a real path, mimicking pawncc;
 *  - finding which files are "entry" files (gamemodes/filterscripts);
 *  - answering "which entry files include this file, directly or indirectly?".
 */
import * as fs from 'fs';
import * as path from 'path';

export type EntryKind = 'gamemode' | 'filterscript' | 'unknown';

export interface RawInclude {
    name: string;
    style: 'angle' | 'quote' | 'bare';
}

export interface FileInfo {
    hasMain: boolean;
    hasGameModeInit: boolean;
    hasFilterScriptInit: boolean;
    definesFilterscript: boolean;
    /** Value of the `// @entry path` directive (if any). */
    directive?: string;
}

interface CacheEntry {
    mtimeMs: number;
    size: number;
    includes: RawInclude[];
    info: FileInfo;
}

const IS_WIN = process.platform === 'win32';
const EXTENSIONS = ['.inc', '.p', '.pwn'];

/** Normalized path key (case-insensitive on Windows). */
export function pathKey(p: string): string {
    const r = path.resolve(p);
    return IS_WIN ? r.toLowerCase() : r;
}

/** Removes // and /* *\/ comments while preserving line breaks and strings. */
export function stripComments(src: string): string {
    const out: string[] = [];
    const n = src.length;
    let i = 0;
    let start = 0;
    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 47 /* / */ && i + 1 < n) {
            const d = src.charCodeAt(i + 1);
            if (d === 47) {
                out.push(src.slice(start, i));
                while (i < n && src.charCodeAt(i) !== 10) i++;
                start = i;
                continue;
            }
            if (d === 42 /* * */) {
                out.push(src.slice(start, i));
                i += 2;
                while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) {
                    if (src.charCodeAt(i) === 10) out.push('\n');
                    i++;
                }
                i += 2;
                start = i;
                continue;
            }
        }
        if (c === 34 /* " */ || c === 39 /* ' */) {
            i++;
            while (i < n) {
                const e = src.charCodeAt(i);
                if (e === c || e === 10) break;
                if (e === 92 /* \ */ && (src.charCodeAt(i + 1) === c || src.charCodeAt(i + 1) === 92)) i++;
                i++;
            }
            i++;
            continue;
        }
        i++;
    }
    out.push(src.slice(start, Math.min(i, n)));
    return out.join('');
}

const INCLUDE_RE = /^[ \t]*#[ \t]*(?:include|tryinclude)[ \t]*(?:<([^>\r\n]+)>|"([^"\r\n]+)"|([^\s"<]+))/gm;
const DIRECTIVE_RE = /^[ \t]*\/\/[ \t]*@(?:entry|compile)[ \t]*:?[ \t]*(\S.*?)[ \t]*$/m;
const MAIN_RE = /(?:^|[^\w@.])main[ \t]*\([ \t]*\)/m;
const GM_INIT_RE = /\bpublic[ \t]+OnGameModeInit[ \t]*\(/;
const FS_INIT_RE = /\bpublic[ \t]+OnFilterScriptInit[ \t]*\(/;
const FS_DEFINE_RE = /^[ \t]*#[ \t]*define[ \t]+FILTERSCRIPT\b/m;

export function analyzeSource(src: string): { includes: RawInclude[]; info: FileInfo } {
    // The directive lives in a comment, so it is read before stripping comments
    // (only in the first ~40 lines, to avoid picking up random matches).
    const head = src.split('\n', 40).join('\n');
    const dm = DIRECTIVE_RE.exec(head);

    const code = stripComments(src);
    const includes: RawInclude[] = [];
    INCLUDE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_RE.exec(code))) {
        if (m[1] !== undefined) includes.push({ name: m[1].trim(), style: 'angle' });
        else if (m[2] !== undefined) includes.push({ name: m[2].trim(), style: 'quote' });
        else includes.push({ name: m[3].trim(), style: 'bare' });
    }
    return {
        includes,
        info: {
            hasMain: MAIN_RE.test(code),
            hasGameModeInit: GM_INIT_RE.test(code),
            hasFilterScriptInit: FS_INIT_RE.test(code),
            definesFilterscript: FS_DEFINE_RE.test(code),
            directive: dm ? dm[1].replace(/^["']|["']$/g, '') : undefined,
        },
    };
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

export class IncludeGraph {
    private cache = new Map<string, CacheEntry>();
    private resolveCache = new Map<string, string | null>();

    constructor(private includePaths: string[] = []) {}

    setIncludePaths(paths: string[]): void {
        const same = paths.length === this.includePaths.length && paths.every((p, i) => p === this.includePaths[i]);
        if (!same) {
            this.includePaths = paths.slice();
            this.resolveCache.clear();
        }
    }

    /** Call when files are created/deleted (include resolution may change). */
    invalidateResolution(): void {
        this.resolveCache.clear();
    }

    private load(file: string): CacheEntry | undefined {
        const k = pathKey(file);
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            this.cache.delete(k);
            return undefined;
        }
        const cached = this.cache.get(k);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
        let src: string;
        try {
            src = fs.readFileSync(file, 'latin1');
        } catch {
            return undefined;
        }
        const entry: CacheEntry = { mtimeMs: st.mtimeMs, size: st.size, ...analyzeSource(src) };
        this.cache.set(k, entry);
        return entry;
    }

    info(file: string): FileInfo | undefined {
        return this.load(file)?.info;
    }

    includesOf(file: string): RawInclude[] {
        return this.load(file)?.includes ?? [];
    }

    /**
     * Resolves an include the way pawncc would. To cover the differences between
     * pawncc 3.2 (SA-MP) and the community compiler 3.10, it tries: the current
     * file's folder, the entry file's folder (compiler cwd) and the include folders.
     */
    resolveInclude(inc: RawInclude, fromFile: string, entryDir: string): string | undefined {
        const name = IS_WIN ? inc.name : inc.name.replace(/\\/g, '/');
        const fromDir = path.dirname(fromFile);
        const cacheKey = `${inc.style}|${pathKey(fromDir)}|${pathKey(entryDir)}|${name}`;
        const hit = this.resolveCache.get(cacheKey);
        if (hit !== undefined) return hit ?? undefined;

        let bases: string[];
        if (path.isAbsolute(name)) bases = [''];
        else if (inc.style === 'angle') bases = [...this.includePaths, fromDir, entryDir];
        else bases = [fromDir, entryDir, ...this.includePaths];

        let found: string | undefined;
        outer: for (const base of bases) {
            const p = base ? path.resolve(base, name) : path.resolve(name);
            if (isFile(p)) {
                found = p;
                break;
            }
            for (const ext of EXTENSIONS) {
                if (isFile(p + ext)) {
                    found = p + ext;
                    break outer;
                }
            }
        }
        this.resolveCache.set(cacheKey, found ?? null);
        return found;
    }

    /** All files reachable from `entry` (including itself). Key = pathKey. */
    closure(entry: string): Map<string, string> {
        const entryDir = path.dirname(entry);
        const seen = new Map<string, string>();
        const stack = [path.resolve(entry)];
        seen.set(pathKey(entry), stack[0]);
        while (stack.length) {
            const file = stack.pop()!;
            for (const inc of this.includesOf(file)) {
                const r = this.resolveInclude(inc, file, entryDir);
                if (!r) continue;
                const k = pathKey(r);
                if (seen.has(k)) continue;
                seen.set(k, r);
                stack.push(r);
            }
        }
        return seen;
    }

    /**
     * A file is an entry candidate if:
     *  - it has `main()`, or `#define FILTERSCRIPT`; or
     *  - it sits directly in `gamemodes/` or `filterscripts/` and defines OnGameModeInit/OnFilterScriptInit.
     * Modules with ALS hooks (`public OnGameModeInit` inside modules/) do not count.
     */
    isEntryCandidate(file: string): boolean {
        const info = this.info(file);
        if (!info) return false;
        if (info.hasMain || info.definesFilterscript) return true;
        const dir = path.basename(path.dirname(file)).toLowerCase();
        if ((dir === 'gamemodes' || dir === 'filterscripts') && (info.hasGameModeInit || info.hasFilterScriptInit)) {
            return true;
        }
        return false;
    }

    /** Among the workspace .pwn files, which ones are actual entry files (graph roots). */
    findRoots(pwnFiles: string[]): { roots: string[]; closures: Map<string, Map<string, string>> } {
        const candidates = pwnFiles.filter((f) => this.isEntryCandidate(f));
        const closures = new Map<string, Map<string, string>>();
        for (const c of candidates) closures.set(pathKey(c), this.closure(c));
        const roots = candidates.filter((c) => {
            const k = pathKey(c);
            for (const [other, cl] of closures) {
                if (other !== k && cl.has(k)) return false; // included by another entry file
            }
            return true;
        });
        for (const k of [...closures.keys()]) {
            if (!roots.some((r) => pathKey(r) === k)) closures.delete(k);
        }
        return { roots, closures };
    }

    kind(file: string): EntryKind {
        const info = this.info(file);
        if (info?.definesFilterscript) return 'filterscript';
        const parts = path.resolve(file).toLowerCase().split(/[\\/]/);
        if (parts.includes('filterscripts')) return 'filterscript';
        if (parts.includes('gamemodes')) return 'gamemode';
        if (!info) return 'unknown';
        if (info.hasGameModeInit) return 'gamemode';
        if (info.hasFilterScriptInit) return 'filterscript';
        if (info.hasMain) return 'gamemode';
        return 'unknown';
    }
}
