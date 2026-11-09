/**
 * Server log parser (crashdetect + native SA-MP/open.mp errors). No VS Code dependency.
 *
 * Example (crashdetect):
 *   [12:00:01] [debug] Run time error 4: "Array index out of bounds"
 *   [12:00:01] [debug]  Attempted to read/write array element at index 10 in array of size 5
 *   [12:00:01] [debug] AMX backtrace:
 *   [12:00:01] [debug] #0 00000a28 in public OnPlayerConnect (playerid=0) at C:\srv\gamemodes\main.pwn:25
 *   [12:00:01] [debug] #1 native SendClientMessage () in samp-server.exe
 */
import { t } from '../i18n';

export interface FrameArg {
    name: string;
    value: string;
}

export interface RuntimeFrame {
    index: number;
    address?: string;
    func: string;
    args: FrameArg[];
    file?: string;
    line?: number;
    native: boolean;
    raw: string;
}

export type RuntimeErrorKind = 'runtime' | 'crash' | 'hang' | 'script' | 'plugin';

export interface RuntimeError {
    kind: RuntimeErrorKind;
    code?: number;
    title: string;
    details: string[];
    frames: RuntimeFrame[];
    /** .amx script (when known) */
    script?: string;
}

const RUNTIME_RE = /^Run time error (\d+):\s*"?(.*?)"?\s*$/;
const CRASH_RE = /^Server crashed while executing (.+?)\s*$/;
const HANG_RE = /^Long callback execution detected/;
const FRAME_RE = /^#(\d+)\s+(.*)$/;
const SCRIPT_ERR_RE = /Script\[(.+?)\]:\s*Run time error (\d+):\s*"?(.*?)"?\s*$/;
const PLUGIN_FAIL_RE = /(?:Failed to load plugin|Loading plugin:\s*(\S+).*Failed|plugin\s+"?(.+?)"?\s+failed to load)/i;

/** Hints per AMX error code; built at call time so the current language applies. */
function errorHints(): Record<number, string> {
    return {
        1: t('End of program without return (exit/forced).'),
        3: t('Stack/heap overflow: use fewer large local variables or increase it with #pragma dynamic.'),
        4: t('Array index out of bounds.'),
        5: t('Invalid memory access.'),
        6: t('Invalid instruction.'),
        7: t('Stack corrupted.'),
        10: t('Native function failed.'),
        11: t('Division by zero.'),
        19: t('Function/native not found — a plugin is missing or an include is outdated.'),
        20: t('Invalid script (compiled for another version?).'),
        27: t('Script is not in a valid AMX format.'),
    };
}

export function errorHint(code?: number): string | undefined {
    return code === undefined ? undefined : errorHints()[code];
}

/** Extracts the useful part of a log line (strips the timestamp and [Info]/[debug] prefixes). */
export function debugPayload(line: string): string | undefined {
    const i = line.indexOf('[debug]');
    if (i < 0) return undefined;
    let s = line.slice(i + 7);
    if (s.startsWith(' ')) s = s.slice(1);
    return s.replace(/\s+$/, '');
}

export function splitArgs(s: string): FrameArg[] {
    const parts: string[] = [];
    let depth = 0;
    let inStr = false;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            cur += c;
            if (c === '\\') cur += s[++i] ?? '';
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) {
            parts.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.map((p) => {
        const eq = p.indexOf('=');
        return eq < 0 ? { name: p, value: '' } : { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
    });
}

export function parseFrame(index: number, rest: string): RuntimeFrame {
    let s = rest.trim();
    const frame: RuntimeFrame = { index, func: '', args: [], native: false, raw: rest };
    const addr = /^([0-9a-fA-F]{6,16})\s+in\s+/.exec(s);
    if (addr) {
        frame.address = addr[1];
        s = s.slice(addr[0].length);
    }
    if (/^native\s+/.test(s)) {
        frame.native = true;
        s = s.replace(/^native\s+/, '');
    }
    const at = /\s+at\s+(.+?):(\d+)\s*$/.exec(s);
    if (at) {
        frame.file = at[1];
        frame.line = parseInt(at[2], 10);
        s = s.slice(0, at.index);
    }
    s = s.replace(/\s+(?:in|from)\s+\S+\s*$/, '');
    const fn = /^(?:(?:public|stock|static|forward)\s+)*([^\s(]+)\s*(?:\((.*)\))?\s*$/.exec(s);
    if (fn) {
        frame.func = fn[1];
        frame.args = fn[2] ? splitArgs(fn[2]) : [];
    } else {
        frame.func = s;
    }
    return frame;
}

/**
 * Incremental parser: feed it line by line; complete errors are returned when the next one
 * starts, when a non-crashdetect line arrives, or on flush().
 */
export class LogParser {
    private current: RuntimeError | undefined;
    private section: 'none' | 'amx' | 'other' = 'none';

    feed(line: string): RuntimeError[] {
        const out: RuntimeError[] = [];
        const payload = debugPayload(line);

        if (payload === undefined) {
            const done = this.flush();
            if (done) out.push(done);
            const se = SCRIPT_ERR_RE.exec(line);
            if (se) {
                const code = parseInt(se[2], 10);
                out.push({ kind: 'script', code, title: `Run time error ${code}: "${se[3]}"`, details: [], frames: [], script: se[1] });
            } else if (PLUGIN_FAIL_RE.test(line)) {
                out.push({ kind: 'plugin', title: line.replace(/^\[[^\]]*\]\s*/, '').trim(), details: [], frames: [] });
            }
            return out;
        }

        let m: RegExpExecArray | null;
        if ((m = RUNTIME_RE.exec(payload))) {
            const prev = this.flush();
            if (prev) out.push(prev);
            const code = parseInt(m[1], 10);
            this.current = { kind: 'runtime', code, title: `Run time error ${code}: "${m[2]}"`, details: [], frames: [] };
            return out;
        }
        if ((m = CRASH_RE.exec(payload))) {
            const prev = this.flush();
            if (prev) out.push(prev);
            this.current = { kind: 'crash', title: t('Server crashed while executing {0}', m[1]), details: [], frames: [], script: m[1] };
            return out;
        }
        if (HANG_RE.test(payload)) {
            const prev = this.flush();
            if (prev) out.push(prev);
            this.current = { kind: 'hang', title: t('Callback took too long (infinite loop or very slow code)'), details: [], frames: [] };
            return out;
        }
        if (!this.current) {
            // Standalone backtrace (e.g. crashdetect without a recognized header)
            if (/^AMX backtrace:/.test(payload)) {
                this.current = { kind: 'runtime', title: t('Runtime error'), details: [], frames: [] };
                this.section = 'amx';
            }
            return out;
        }
        if (/^AMX backtrace:/.test(payload)) {
            this.section = 'amx';
            return out;
        }
        if (/^(Native backtrace|Registers|Stack|Loaded modules|System backtrace)/i.test(payload)) {
            this.section = 'other';
            return out;
        }
        if ((m = FRAME_RE.exec(payload))) {
            if (this.section === 'amx') this.current.frames.push(parseFrame(parseInt(m[1], 10), m[2]));
            return out;
        }
        if (this.section === 'none' && payload.trim()) this.current.details.push(payload.trim());
        return out;
    }

    flush(): RuntimeError | undefined {
        const c = this.current;
        this.current = undefined;
        this.section = 'none';
        return c;
    }

    get pending(): boolean {
        return !!this.current;
    }
}
