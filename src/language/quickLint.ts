/**
 * Fast analysis (milliseconds) while the user types — without calling pawncc.
 * Only reports what can be known for sure; pawncc in the background does the full check.
 */
import { t } from '../i18n';
import { blankCode, PawnSymbol, splitParams } from './symbols';

export interface LintIssue {
    line: number; // 0-based
    col: number;
    endCol: number;
    message: string;
    severity: 'error' | 'warning';
    code: string;
}

export interface LintContext {
    /** Does the name exist somewhere visible (symbol, macro, text of another file)? */
    isKnown(name: string): boolean;
    /** Function symbol with known parameters (to count arguments). */
    functionSymbol(name: string): PawnSymbol | undefined;
    /** Is there a #define/macro with this name (it may redefine the function)? */
    isMacro(name: string): boolean;
    /** Does the include exist? */
    includeExists(name: string, style: 'angle' | 'quote' | 'bare'): boolean;
    /** Is `#pragma semicolon 1` / `-;+` active? */
    semicolonRequired: boolean;
    /** Suggestions for "did you mean". */
    suggest?(name: string): string | undefined;
}

const NOT_CALLS = new Set([
    'if', 'for', 'while', 'switch', 'return', 'sizeof', 'tagof', 'defined', 'else', 'do', 'case', 'new', 'static',
    'const', 'stock', 'public', 'native', 'forward', 'operator', 'char', 'assert', 'sleep', 'exit', 'state', 'goto',
    'foreach', 'inline', 'using', 'hook', 'task', 'ptask', 'timer', 'remotefunc', 'yield', 'main', 'enum', 'default',
]);

const CONTROL_START = /^\s*(if|else|for|while|do|switch|case|default|foreach|inline|hook|task|ptask|timer|using)\b/;

/** Lines that are preprocessor directives (including "\" continuations). */
function preprocessorLines(lines: string[]): Set<number> {
    const set = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*#/.test(lines[i])) {
            set.add(i);
            while (/\\\s*$/.test(lines[i]) && i + 1 < lines.length) set.add(++i);
        }
    }
    return set;
}

export function quickLint(src: string, ctx: LintContext): LintIssue[] {
    const issues: LintIssue[] = [];
    const rawLines = src.split('\n').map((l) => l.replace(/\r$/, ''));
    const code = blankCode(src);
    const lines = code.split('\n').map((l) => l.replace(/\r$/, ''));
    const pp = preprocessorLines(rawLines);

    checkStrings(src, rawLines, pp, issues);
    checkIncludes(rawLines, pp, ctx, issues);
    const depthAt = checkBrackets(lines, pp, issues);
    checkCalls(code, lines, pp, depthAt, ctx, issues);
    if (ctx.semicolonRequired) checkSemicolons(lines, pp, depthAt, ctx, issues);
    return issues;
}

// ───────────────────────── strings ─────────────────────────

function checkStrings(src: string, rawLines: string[], pp: Set<number>, issues: LintIssue[]): void {
    let i = 0;
    let line = 0;
    let lineStart = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\n') {
            line++;
            lineStart = i + 1;
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') {
                    line++;
                    lineStart = i + 1;
                }
                i++;
            }
            i += 2;
            continue;
        }
        if (c === '"' || c === "'") {
            const startCol = i - lineStart;
            i++;
            let closed = false;
            while (i < n && src[i] !== '\n') {
                if (src[i] === '\\' && i + 1 < n) {
                    // "\" at the end of the line: the string continues on the next line
                    const nl = src[i + 1] === '\n' ? 1 : src[i + 1] === '\r' && src[i + 2] === '\n' ? 2 : 0;
                    if (nl) {
                        i += 1 + nl;
                        line++;
                        lineStart = i;
                        continue;
                    }
                    i += 2;
                    continue;
                }
                if (src[i] === c) {
                    closed = true;
                    i++;
                    break;
                }
                i++;
            }
            if (!closed && !pp.has(line) && !/\\\s*$/.test(rawLines[line] ?? '')) {
                issues.push({
                    line,
                    col: startCol,
                    endCol: (rawLines[line] ?? '').length,
                    message: c === '"' ? t('unterminated string (missing ")') : t('unterminated character literal (missing \')'),
                    severity: 'error',
                    code: 'QL-string',
                });
            }
            continue;
        }
        i++;
    }
}

// ───────────────────────── includes ─────────────────────────

function checkIncludes(rawLines: string[], pp: Set<number>, ctx: LintContext, issues: LintIssue[]): void {
    rawLines.forEach((l, ln) => {
        if (!pp.has(ln)) return;
        const m = /^(\s*#\s*include\s*)(?:<([^>]+)>|"([^"]+)"|([^\s/]+))/.exec(l);
        if (!m) return; // #tryinclude is optional by definition
        const name = (m[2] ?? m[3] ?? m[4]).trim();
        if (/^[A-Z_][A-Z0-9_]*$/.test(name) && m[4]) return; // include through a macro
        const style = m[2] !== undefined ? 'angle' : m[3] !== undefined ? 'quote' : 'bare';
        if (!ctx.includeExists(name, style)) {
            const col = l.indexOf(name, m[1].length);
            issues.push({
                line: ln,
                col,
                endCol: col + name.length,
                message: t('include not found: "{0}" (check the path or install the package)', name),
                severity: 'error',
                code: 'QL-include',
            });
        }
    });
}

// ───────────────────────── braces / parentheses ─────────────────────────

/** Returns the brace depth at the start of each line. */
function checkBrackets(lines: string[], pp: Set<number>, issues: LintIssue[]): number[] {
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const names: Record<string, string> = { '(': t('parenthesis'), '[': t('bracket'), '{': t('brace') };
    const stack: Array<{ ch: string; line: number; col: number }> = [];
    const depthAt: number[] = [];
    let reported = false;
    for (let ln = 0; ln < lines.length; ln++) {
        depthAt.push(stack.filter((s) => s.ch === '{').length);
        if (pp.has(ln)) continue;
        const l = lines[ln];
        for (let c = 0; c < l.length; c++) {
            const ch = l[c];
            if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, line: ln, col: c });
            else if (ch === ')' || ch === ']' || ch === '}') {
                const top = stack[stack.length - 1];
                if (top && top.ch === pairs[ch]) {
                    stack.pop();
                } else if (!reported) {
                    reported = true;
                    if (top) {
                        issues.push({
                            line: top.line,
                            col: top.col,
                            endCol: top.col + 1,
                            message: t('{0} \'{1}\' is never closed (found \'{2}\' on line {3})', names[top.ch], top.ch, ch, ln + 1),
                            severity: 'error',
                            code: 'QL-brackets',
                        });
                    } else {
                        issues.push({ line: ln, col: c, endCol: c + 1, message: t('\'{0}\' has no matching opening bracket', ch), severity: 'error', code: 'QL-brackets' });
                    }
                    // try to recover: discard until the matching pair is found
                    const idx = stack.map((s) => s.ch).lastIndexOf(pairs[ch]);
                    if (idx >= 0) stack.length = idx;
                }
            }
        }
    }
    if (!reported && stack.length) {
        const top = stack.find((s) => s.ch === '{') ?? stack[stack.length - 1];
        issues.push({
            line: top.line,
            col: top.col,
            endCol: top.col + 1,
            message: t('{0} \'{1}\' is not closed before the end of the file', names[top.ch], top.ch),
            severity: 'error',
            code: 'QL-brackets',
        });
    }
    return depthAt;
}

// ───────────────────────── calls ─────────────────────────

function lineCol(code: string, idx: number, lineStarts: number[]): { line: number; col: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, col: idx - lineStarts[lo] };
}

function checkCalls(code: string, lines: string[], pp: Set<number>, depthAt: number[], ctx: LintContext, issues: LintIssue[]): void {
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
    const re = /([A-Za-z_@][\w@]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
        const name = m[1];
        if (NOT_CALLS.has(name)) continue;
        const { line, col } = lineCol(code, m.index, lineStarts);
        if (pp.has(line)) continue;
        if (depthAt[line] === 0 && !/[;{]\s*$/.test(lines[line].slice(0, col))) continue; // top-level declaration/definition
        const before = code.slice(Math.max(0, m.index - 30), m.index);
        if (/[.:#%>]$/.test(before) || /\b(public|stock|forward|native|static|operator|new|const|inline|timer|task|ptask|remotefunc|hook)\s+(?:[A-Za-z_]\w*:)?$/.test(before)) continue;
        if (/\w$/.test(before)) continue; // part of another token

        if (!ctx.isKnown(name)) {
            const s = ctx.suggest?.(name);
            issues.push({
                line,
                col,
                endCol: col + name.length,
                message: s ? t('undefined symbol "{0}"; did you mean "{1}"?', name, s) : t('undefined symbol "{0}"', name),
                severity: 'error',
                code: 'QL-undefined',
            });
            continue;
        }

        // argument count
        const sym = ctx.functionSymbol(name);
        if (!sym?.params || ctx.isMacro(name)) continue;
        if (sym.params.some((p) => p.includes('...'))) continue;
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let close = -1;
        for (let i = open; i < code.length && i < open + 5000; i++) {
            const ch = code[i];
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth === 0) {
                    close = i;
                    break;
                }
            } else if (ch === ';' && depth === 1) break;
        }
        if (close < 0) continue;
        const inner = code.slice(open + 1, close);
        if (/[#%]/.test(inner)) continue;
        const args = inner.trim() ? splitParams(inner).length : 0;
        const max = sym.params.length;
        const required = sym.params.filter((p) => !p.includes('=')).length;
        if (args > max || args < required) {
            issues.push({
                line,
                col,
                endCol: col + name.length,
                message:
                    args > max
                        ? t('too many arguments to {0}: got {1}, accepts {2} — {3}', name, args, max, sym.signature)
                        : t('not enough arguments to {0}: got {1}, needs {2} — {3}', name, args, required, sym.signature),
                severity: 'error',
                code: 'QL-args',
            });
        }
    }
}

// ───────────────────────── semicolons ─────────────────────────

function checkSemicolons(lines: string[], pp: Set<number>, depthAt: number[], ctx: LintContext, issues: LintIssue[]): void {
    const nextCode = (from: number): { ln: number; text: string } | undefined => {
        for (let k = from; k < lines.length; k++) {
            if (pp.has(k)) continue;
            const trimmed = lines[k].trim();
            if (trimmed) return { ln: k, text: trimmed };
        }
        return undefined;
    };
    for (let ln = 0; ln < lines.length; ln++) {
        if (pp.has(ln) || depthAt[ln] === 0) continue;
        const raw = lines[ln];
        const stmt = raw.trim();
        if (!stmt) continue;
        // ends with something that terminates/continues the statement
        if (/[;{}\[,(&|+\-*/%=<>!?:^~\\.]$/.test(stmt)) continue;
        if (CONTROL_START.test(stmt)) continue;
        if (/^(else|do)$/.test(stmt)) continue;
        if (/^\w+:$/.test(stmt)) continue; // label
        if (/^((new|static|const|stock)\s*)+$/.test(stmt)) continue; // bare `new`, variables on the following lines
        // unbalanced parentheses on the line = statement continues
        let bal = 0;
        for (const ch of stmt) {
            if (ch === '(' || ch === '[') bal++;
            else if (ch === ')' || ch === ']') bal--;
        }
        if (bal !== 0) continue;
        // must look like a statement: call, assignment, return, new, ++/--
        if (!/^(return\b|new\b|static\b|break$|continue$|[A-Za-z_@][\w@.]*\s*(\(|\[|=|\+\+|--|[+\-*/%&|^]=|<<=|>>=))|^(\+\+|--)/.test(stmt)) continue;
        // loops/blocks made with macros: Loop(i, 10), foreach2(...), etc.
        const first = /^([A-Za-z_@][\w@]*)\s*\(/.exec(stmt);
        if (first && ctx.isMacro(first[1])) continue;
        const next = nextCode(ln + 1);
        if (next && /^[{)\]},.?:;&|+\-*/%=<>!^]/.test(next.text)) continue; // continues on the next line (includes a bare `;`)
        // `return` alone with its value on the next lines (return\n    Dialog_Create(...)\n;)
        if (stmt === 'return' && next && !/^[}]/.test(next.text) && !CONTROL_START.test(next.text) && !/^(return|break|continue|new|static)\b/.test(next.text)) continue;
        issues.push({
            line: ln,
            col: raw.length - raw.trimStart().length + stmt.length,
            endCol: raw.length - raw.trimStart().length + stmt.length,
            message: t('missing \';\' at the end of the line'),
            severity: 'error',
            code: 'QL-semicolon',
        });
    }
}

// ───────────────────────── context ─────────────────────────

export interface ContextInput {
    src: string;
    /** symbols of the document itself (including locals) */
    own: PawnSymbol[];
    /** symbols of other visible files, by name */
    external: Map<string, PawnSymbol[]>;
    /** does the name appear in the text of some other visible file? */
    inOtherFiles(name: string): boolean;
    includeExists(name: string, style: 'angle' | 'quote' | 'bare'): boolean;
    semicolonRequired: boolean;
    /** names pawncc already confirmed as valid (generated by macros etc.) */
    knownGood?: Set<string>;
    /** ignores `external` symbols coming from this file (the on-disk version of the edited document) */
    excludeFile?: string;
}

const FUNC_KINDS = new Set(['native', 'stock', 'function', 'public']);
const BUILTIN_TAGS = new Set(['Float', 'bool', 'File', 'Text', 'PlayerText', 'Text3D', 'PlayerText3D', 'DB', 'DBResult', 'Menu', 'Cache', 'ORM', '_']);

export function makeContext(rawInput: ContextInput): LintContext {
    const input = rawInput.excludeFile ? { ...rawInput, external: excluding(rawInput.external, rawInput.excludeFile) } : rawInput;
    const ownByName = new Map<string, PawnSymbol[]>();
    for (const s of input.own) {
        if (!ownByName.has(s.name)) ownByName.set(s.name, []);
        ownByName.get(s.name)!.push(s);
    }
    // Prefix macros (#define Inventory:%0(%1) ... IV_%0 ...): the name "Inventory:Vest" generates "IV_Vest".
    const ext = externalInfo(rawInput.external);
    const prefixes = new Set(ext.prefixes);
    const generated = [...ext.generated];
    for (const s of input.own) collectPrefix(s, prefixes, generated);
    const isEnum = (tag: string) =>
        [...(ownByName.get(tag) ?? []), ...(input.external.get(tag) ?? [])].some((s) => s.kind === 'enum');
    /** Return tag that is actually a macro (CMD:, Dialog:, Action:...) — the symbol is not callable by that name. */
    const realFunction = (s: PawnSymbol) => !s.tag || BUILTIN_TAGS.has(s.tag) || (!prefixes.has(s.tag) && isEnum(s.tag));
    // occurrences of each word in the file itself (a name used 2+ times is probably declared by a macro here)
    const counts = new Map<string, number>();
    for (const w of blankCode(input.src).match(/[A-Za-z_@][\w@]*/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);

    return {
        isKnown: (n) =>
            ownByName.has(n) ||
            input.external.has(n) ||
            (counts.get(n) ?? 0) >= 2 ||
            !!input.knownGood?.has(n) ||
            input.inOtherFiles(n) ||
            generated.some((rx) => rx.test(n)),
        functionSymbol: (n) => {
            const own = (ownByName.get(n) ?? []).filter((s) => FUNC_KINDS.has(s.kind));
            if (own.length) return own.every(realFunction) ? own[0] : undefined;
            // `static` is file-private: only the document's own definition counts
            const ext = (input.external.get(n) ?? []).filter((s) => FUNC_KINDS.has(s.kind) && !s.isStatic);
            if (!ext.every(realFunction)) return undefined;
            if (!ext.length) return undefined;
            const sig = ext[0].params?.length;
            return ext.every((s) => s.params?.length === sig) ? ext[0] : undefined;
        },
        isMacro: (n) =>
            [...(ownByName.get(n) ?? []), ...(input.external.get(n) ?? [])].some((s) => s.kind === 'define' || s.kind === 'macro'),
        includeExists: input.includeExists,
        semicolonRequired: input.semicolonRequired,
        suggest: (n) => {
            const pool = [...ext.callable];
            for (const [k, list] of ownByName) if (list.some((s) => FUNC_KINDS.has(s.kind))) pool.push(k);
            return closest(n, pool);
        },
    };
}

function collectPrefix(s: PawnSymbol, prefixes: Set<string>, generated: RegExp[]): void {
    if (s.kind !== 'macro' || !s.name.endsWith(':')) return;
    prefixes.add(s.name.slice(0, -1));
    for (const tok of (s.value ?? '').match(/[A-Za-z_@][\w@]*%0[\w@]*|%0[\w@]+/g) ?? []) {
        const rx = '^' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('%0', '([A-Za-z_@][\\w@]*)') + '$';
        generated.push(new RegExp(rx));
    }
}

/** Info derived from the external index — computed once per index, not on every keystroke. */
const extCache = new WeakMap<Map<string, PawnSymbol[]>, { prefixes: Set<string>; generated: RegExp[]; callable: string[] }>();
function externalInfo(map: Map<string, PawnSymbol[]>) {
    let info = extCache.get(map);
    if (!info) {
        info = { prefixes: new Set(), generated: [], callable: [] };
        for (const [name, list] of map) {
            if (name.endsWith(':')) list.forEach((s) => collectPrefix(s, info!.prefixes, info!.generated));
            else if (list.some((s) => FUNC_KINDS.has(s.kind) || s.kind === 'macro')) info.callable.push(name);
        }
        extCache.set(map, info);
    }
    return info;
}

/** View of `map` without one file's symbols (without copying the whole map). */
function excluding(map: Map<string, PawnSymbol[]>, file: string): Map<string, PawnSymbol[]> {
    const norm = (f?: string) => (f ?? '').toLowerCase().replace(/\//g, '\\');
    const ex = norm(file);
    const filt = (list: PawnSymbol[] | undefined) => (list ?? []).filter((s) => norm(s.file) !== ex);
    return {
        get: (k: string) => {
            const l = filt(map.get(k));
            return l.length ? l : undefined;
        },
        has: (k: string) => filt(map.get(k)).length > 0,
        *[Symbol.iterator]() {
            for (const [k, v] of map) {
                const l = filt(v);
                if (l.length) yield [k, l] as [string, PawnSymbol[]];
            }
        },
    } as unknown as Map<string, PawnSymbol[]>;
}

// ───────────────────────── suggestions ─────────────────────────

export function levenshtein(a: string, b: string, max = 3): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        let rowMin = prev[0];
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
            diag = tmp;
            if (prev[j] < rowMin) rowMin = prev[j];
        }
        if (rowMin > max) return max + 1;
    }
    return prev[b.length];
}

export function closest(name: string, candidates: Iterable<string>, max = 2): string | undefined {
    let best: string | undefined;
    let bestD = max + 1;
    for (const c of candidates) {
        if (c === name) continue;
        const d = levenshtein(name, c, max);
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return best;
}
