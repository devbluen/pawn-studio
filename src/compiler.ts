/**
 * Locating and running pawncc + parsing its output. No VS Code dependency.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'pawncc.exe' : 'pawncc';

export interface PawnDiagnostic {
    file: string;
    line: number; // 1-based
    endLine: number; // 1-based
    severity: 'warning' | 'error' | 'fatal';
    code: string;
    message: string;
}

// Examples:
//   C:\srv\gamemodes\main.pwn(12) : error 017: undefined symbol "foo"
//   ..\modules\x.pwn(10 -- 14) : warning 203: symbol is never used: "a"
//   main.pwn(1) : fatal error 100: cannot read from file: "y_hooks"
const DIAG_RE = /^(.+?)\((\d+)(?:\s*--\s*(\d+))?\)\s*:\s*(fatal error|error|warning)\s+(\d+)\s*:\s*(.*?)\s*$/;

export function parseOutput(text: string, cwd: string): PawnDiagnostic[] {
    const result: PawnDiagnostic[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = DIAG_RE.exec(raw.trim());
        if (!m) continue;
        const start = parseInt(m[2], 10);
        const end = m[3] ? parseInt(m[3], 10) : start;
        result.push({
            file: path.resolve(cwd, m[1].trim()),
            line: Math.min(start, end),
            endLine: Math.max(start, end),
            severity: m[4] === 'warning' ? 'warning' : m[4] === 'error' ? 'error' : 'fatal',
            code: m[5],
            message: m[6],
        });
    }
    return result;
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Walks up from `start` and returns every folder up to the drive root. */
function ancestors(start: string): string[] {
    const out: string[] = [];
    let dir = path.resolve(start);
    for (;;) {
        out.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return out;
}

/**
 * Looks for pawncc: configured path → pawno/qawno/pawncc walking up from the
 * entry file and the workspace folders → PATH.
 */
export function findCompiler(configured: string | undefined, searchFrom: string[]): string | undefined {
    if (configured) {
        if (isFile(configured)) return path.resolve(configured);
        if (isDir(configured) && isFile(path.join(configured, EXE))) return path.join(configured, EXE);
        return undefined;
    }
    const seen = new Set<string>();
    for (const start of searchFrom) {
        for (const dir of ancestors(start)) {
            if (seen.has(dir)) continue;
            seen.add(dir);
            for (const sub of ['pawno', 'qawno', path.join('compiler', 'bin'), 'compiler', '']) {
                const p = path.join(dir, sub, EXE);
                if (isFile(p)) return p;
            }
        }
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir.replace(/^"|"$/g, ''), EXE);
        if (isFile(p)) return p;
    }
    return undefined;
}

/**
 * Automatic include folders: `include/` next to pawncc (pawno/include, qawno/include)
 * and `include/` at the server root (the folder containing gamemodes/).
 */
export function autoIncludeDirs(compilerPath: string | undefined, entry: string): string[] {
    const dirs: string[] = [];
    if (compilerPath) {
        const d = path.dirname(compilerPath);
        for (const p of [path.join(d, 'include'), path.join(d, '..', 'include')]) {
            if (isDir(p)) dirs.push(path.resolve(p));
        }
    }
    for (const dir of ancestors(path.dirname(entry))) {
        const inc = path.join(dir, 'include');
        if (isDir(path.join(dir, 'gamemodes')) || isDir(path.join(dir, 'filterscripts'))) {
            if (isDir(inc)) dirs.push(inc);
            break;
        }
    }
    return [...new Set(dirs)];
}

export interface RunOptions {
    compiler: string;
    entry: string;
    output: string;
    includeDirs: string[];
    args: string[];
}

export interface RunResult {
    exitCode: number | null;
    output: string;
    commandLine: string;
    durationMs: number;
    killed: boolean;
}

export function buildArgs(o: RunOptions): string[] {
    // Absolute .pwn path: crashdetect then shows absolute paths in the stack trace.
    // No trailing slash: `"-iC:\x\"` breaks the Windows argument parser.
    const inc = o.includeDirs.map((d) => '-i' + path.resolve(d));
    return [path.resolve(o.entry), ...inc, ...o.args, '-o' + path.resolve(o.output)];
}

function decode(buf: Buffer): string {
    const utf8 = buf.toString('utf8');
    return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

export function runCompiler(o: RunOptions): { promise: Promise<RunResult>; kill: () => void; commandLine: string } {
    const args = buildArgs(o);
    const commandLine = [o.compiler, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    const started = Date.now();
    let killed = false;
    const proc = cp.spawn(o.compiler, args, { cwd: path.dirname(o.entry), windowsHide: true });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (b: Buffer) => chunks.push(b));
    proc.stderr.on('data', (b: Buffer) => chunks.push(b));
    const promise = new Promise<RunResult>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code) =>
            resolve({
                exitCode: code,
                output: decode(Buffer.concat(chunks)),
                commandLine,
                durationMs: Date.now() - started,
                killed,
            }),
        );
    });
    return {
        promise,
        commandLine,
        kill: () => {
            killed = true;
            proc.kill();
        },
    };
}
