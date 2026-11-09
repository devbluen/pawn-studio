/**
 * Symbol extraction from Pawn code (no VS Code dependency).
 */
import { t } from '../i18n';

export type SymbolKind =
    | 'native'
    | 'function'
    | 'public'
    | 'stock'
    | 'forward'
    | 'define'
    | 'macro'
    | 'enum'
    | 'enumMember'
    | 'variable'
    | 'constant';

export interface PawnSymbol {
    name: string;
    kind: SymbolKind;
    line: number; // 0-based
    col: number;
    /** human-readable signature, e.g.: `native SetPlayerPos(playerid, Float:x, Float:y, Float:z)` */
    signature: string;
    params?: string[];
    tag?: string;
    doc?: string;
    /** value of the #define / enum member */
    value?: string;
    /** parent (enum of a member) */
    parent?: string;
    /** end of the body (for functions in the outline), 0-based */
    endLine?: number;
    isStatic?: boolean;
    /** source file (filled in by the index) */
    file?: string;
}

const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return', 'break', 'continue', 'goto',
    'new', 'static', 'const', 'stock', 'public', 'native', 'forward', 'enum', 'sizeof', 'tagof', 'defined',
    'sleep', 'exit', 'state', 'operator', 'char', 'assert', 'foreach', 'hook', 'task', 'ptask', 'timer', 'inline',
]);

// Comments // and /* */, strings "..." and chars '...'. "\" + line break continues the string
// on the next line (SQL queries etc.); an unterminated string ends at the end of the line.
const BLANK_RE = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\\r?\n|\\[\s\S])*(?:"|(?=\r?\n)|$)|'(?:[^'\\\n]|\\\r?\n|\\[\s\S])*(?:'|(?=\r?\n)|$)/g;
const spaces = (s: string) => s.replace(/[^\n\r]/g, ' ');
let blankLastIn = '';
let blankLastOut = '';

/** Removes comments and string contents (keeps quotes and line breaks, preserves columns). */
export function blankCode(src: string): string {
    if (src === blankLastIn) return blankLastOut;
    const out = src.replace(BLANK_RE, (m) => {
        const q = m[0];
        if (q !== '"' && q !== "'") return spaces(m);
        const closed = m.length > 1 && m[m.length - 1] === q && m[m.length - 2] !== '\\';
        return q + spaces(m.slice(1, closed ? -1 : undefined)) + (closed ? q : '');
    });
    blankLastIn = src;
    blankLastOut = out;
    return out;
}

/** Doc comment immediately above line `line` (/** *\/, /* *\/ or //). */
function docAbove(rawLines: string[], line: number): string | undefined {
    let i = line - 1;
    while (i >= 0 && rawLines[i].trim() === '') i--;
    if (i < 0) return undefined;
    const t = rawLines[i].trim();
    if (t.endsWith('*/')) {
        const end = i;
        while (i >= 0 && !rawLines[i].includes('/*')) i--;
        if (i < 0) return undefined;
        const block = rawLines.slice(i, end + 1).join('\n');
        return cleanDoc(block.replace(/^\s*\/\*+!?/, '').replace(/\*+\/\s*$/, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n'));
    }
    if (t.startsWith('//')) {
        const lines: string[] = [];
        while (i >= 0 && rawLines[i].trim().startsWith('//')) {
            lines.unshift(rawLines[i].trim().replace(/^\/\/\/?\s?/, ''));
            i--;
        }
        return cleanDoc(lines.join('\n'));
    }
    return undefined;
}

function cleanDoc(s: string): string | undefined {
    // Converts common XML tags from Pawn docs (<summary>, <param name="x">) into simple markdown.
    const out = s
        .replace(/<summary>\s*/g, '')
        .replace(/\s*<\/summary>/g, '\n')
        .replace(/<param name="([^"]+)">\s*/g, '\n`$1` — ')
        .replace(/<\/param>/g, '')
        .replace(/<returns>\s*/g, () => '\n**' + t('Returns:') + '** ')
        .replace(/<\/returns>/g, '')
        .replace(/<remarks>\s*/g, '\n')
        .replace(/<\/remarks>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return out || undefined;
}

export function splitParams(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of s) {
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) {
            out.push(cur.trim());
            cur = '';
        } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

const FUNC_DECL = /^([ \t]*)((?:(?:static|stock|public|native|forward)[ \t]+)*)(?:([A-Za-z_@][\w@]*):)?([A-Za-z_@][\w@.:]*?)[ \t]*\(/;
const DEFINE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_@][\w@]*)(\([^)]*\))?(?=[ \t(]|$)[ \t]*(.*)$/;
const ENUM_START = /^[ \t]*enum[ \t]*(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)?[ \t]*(?:\([^)]*\))?[ \t]*(\{)?/;
const PREFIX_DEFINE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_@][\w@]*):%0\S*[ \t]*(.*)$/;
const TIMER_DECL =/^[ \t]*(timer|task|ptask|remotefunc)[ \t]+([A-Za-z_@][\w@]*)[ \t]*\[([^\]]*)\][ \t]*\(([^)]*)\)/;
const VAR_DECL =/^[ \t]*(static[ \t]+const|new[ \t]+const|stock[ \t]+const|new|static|const)[ \t]+(.+)$/;

/** Extracts the symbols of a file. `locals` also includes local variables. */
export function parseSymbols(src: string, opts: { locals?: boolean } = {}): PawnSymbol[] {
    const code = blankCode(src);
    const lines = code.split('\n');
    const raw = src.split('\n');
    const syms: PawnSymbol[] = [];
    let depth = 0;
    let enumCtx: { name: string; depth: number } | undefined;
    let pendingEnum: string | undefined;
    let fnStack: PawnSymbol | undefined;

    for (let ln = 0; ln < lines.length; ln++) {
        const line = lines[ln].replace(/\r$/, '');
        const rawLine = raw[ln].replace(/\r$/, '');
        const depthAtStart = depth;

        // Prefix macro: #define Inventory:%0(%1) forward IV_%0(%1); public IV_%0(%1)
        const pm = PREFIX_DEFINE.test(line) ? PREFIX_DEFINE.exec(rawLine) : null;
        if (pm) {
            let body = pm[2].trim();
            let k = ln;
            while (body.endsWith('\\') && k + 1 < raw.length) {
                k++;
                body = body.slice(0, -1).trim() + ' ' + raw[k].trim();
            }
            syms.push({
                name: pm[1] + ':',
                kind: 'macro',
                line: ln,
                col: rawLine.indexOf(pm[1]),
                signature: `#define ${pm[1]}:%0 ${body.length > 120 ? body.slice(0, 120) + '…' : body}`,
                value: body,
            });
            continue;
        }
        // #define (uses the original line: the body may contain strings)
        const dm = DEFINE.exec(line);
        if (dm) {
            const name = dm[1];
            const rawDef = DEFINE.exec(rawLine);
            let value = (rawDef?.[3] ?? dm[3]).trim();
            // continues on lines ending with "\"
            let k = ln;
            while (value.endsWith('\\') && k + 1 < raw.length) {
                k++;
                value = value.slice(0, -1).trim() + ' ' + raw[k].trim();
            }
            const params = dm[2] ? splitParams(dm[2].slice(1, -1)) : undefined;
            syms.push({
                name,
                kind: params ? 'macro' : 'define',
                line: ln,
                col: rawLine.indexOf(name),
                signature: `#define ${name}${dm[2] ?? ''} ${value.length > 120 ? value.slice(0, 120) + '…' : value}`.trim(),
                params,
                value,
                doc: docAbove(raw, ln),
            });
            continue;
        }
        if (/^[ \t]*#/.test(line)) continue;

        // enum
        if (depth === 0) {
            const em = ENUM_START.exec(line);
            if (em && /^\s*enum\b/.test(line)) {
                const name = em[2] ?? '';
                if (name) {
                    syms.push({ name, kind: 'enum', line: ln, col: line.indexOf(name), signature: `enum ${name}`, doc: docAbove(raw, ln) });
                }
                pendingEnum = name || t('(anonymous)');
                if (!em[3]) {
                    // the brace may come on the next line
                    depth += count(line, '{') - count(line, '}');
                    continue;
                }
            }
        }
        if (pendingEnum !== undefined && line.includes('{')) {
            enumCtx = { name: pendingEnum, depth: depth + 1 };
            pendingEnum = undefined;
            const after = line.slice(line.indexOf('{') + 1);
            collectEnumMembers(after, ln, line.indexOf('{') + 1, enumCtx.name, syms);
            depth += count(line, '{') - count(line, '}');
            if (depth < enumCtx.depth) enumCtx = undefined;
            continue;
        }
        if (enumCtx) {
            const close = line.indexOf('}');
            collectEnumMembers(close >= 0 ? line.slice(0, close) : line, ln, 0, enumCtx.name, syms);
            depth += count(line, '{') - count(line, '}');
            if (depth < enumCtx.depth) enumCtx = undefined;
            continue;
        }

        if (depthAtStart === 0) {
            // y_timers: timer Name[1000](playerid) / task Name[500]() / ptask Name[1000](playerid)
            const tm = TIMER_DECL.exec(line);
            if (tm) {
                const params = splitParams(tm[4]);
                const sym: PawnSymbol = {
                    name: tm[2],
                    kind: 'function',
                    line: ln,
                    col: line.indexOf(tm[2]),
                    signature: `${tm[1]} ${tm[2]}[${tm[3].trim()}](${params.join(', ')})`,
                    params,
                    doc: docAbove(raw, ln),
                };
                syms.push(sym);
                depth += count(line, '{') - count(line, '}');
                if (depth > 0) fnStack = sym;
                continue;
            }
            const fm = FUNC_DECL.exec(line);
            if (fm && !KEYWORDS.has(fm[4]) && !/^\s*(new|const|static\s+const)\b/.test(line)) {
                const mods = fm[2].trim().split(/\s+/).filter(Boolean);
                const indent = fm[1].length;
                const name = fm[4];
                const close = matchParen(code, lineOffset(lines, ln) + fm[0].length - 1);
                const paramsText = close ? code.slice(lineOffset(lines, ln) + fm[0].length, close.index) : '';
                const rest = close ? code.slice(close.index + 1, close.index + 200) : '';
                const isProto = /^\s*;/.test(rest) || mods.includes('native') || mods.includes('forward');
                let kind: SymbolKind | undefined;
                if (mods.includes('native')) kind = 'native';
                else if (mods.includes('forward')) kind = 'forward';
                else if (mods.includes('public')) kind = 'public';
                else if (mods.includes('stock')) kind = 'stock';
                else if (indent === 0 && !isProto && /^\s*(\{|$)/.test(rest.split('\n')[0]) && /^\s*\{/.test(rest)) kind = 'function';
                else if (indent === 0 && mods.includes('static') && !isProto) kind = 'function';
                if (kind) {
                    const params = splitParams(paramsText.replace(/\s+/g, ' '));
                    const rawParams = close ? extractRawParams(src, lineOffset(raw, ln) + fm[0].length, close.index - (lineOffset(lines, ln) - lineOffset(raw, ln))) : params.join(', ');
                    const prefix = mods.length ? mods.join(' ') + ' ' : '';
                    const sym: PawnSymbol = {
                        name,
                        kind,
                        line: ln,
                        col: line.indexOf(name, indent),
                        signature: `${prefix}${fm[3] ? fm[3] + ':' : ''}${name}(${rawParams})`,
                        params: splitParams(rawParams),
                        tag: fm[3],
                        doc: docAbove(raw, ln),
                        isStatic: mods.includes('static'),
                    };
                    syms.push(sym);
                    if (!isProto && kind !== 'native' && kind !== 'forward') fnStack = sym;
                }
            } else {
                const vm = VAR_DECL.exec(line);
                if (vm) collectVars(vm[2], ln, line, syms, vm[1].includes('const') ? 'constant' : 'variable', raw);
            }
        } else if (opts.locals) {
            const vm = VAR_DECL.exec(line);
            if (vm) collectVars(vm[2], ln, line, syms, 'variable', raw, true);
        }

        depth += count(line, '{') - count(line, '}');
        if (depth < 0) depth = 0;
        if (fnStack && depth === 0 && depthAtStart > 0) {
            fnStack.endLine = ln;
            fnStack = undefined;
        }
    }
    return syms;
}

function count(s: string, ch: string): number {
    let n = 0;
    for (const c of s) if (c === ch) n++;
    return n;
}

const offsetCache = new WeakMap<string[], number[]>();
function lineOffset(lines: string[], ln: number): number {
    let offs = offsetCache.get(lines);
    if (!offs) {
        offs = [0];
        for (let i = 0; i < lines.length; i++) offs.push(offs[i] + lines[i].length + 1);
        offsetCache.set(lines, offs);
    }
    return offs[ln];
}

function matchParen(code: string, openIdx: number): { index: number } | undefined {
    let depth = 0;
    for (let i = openIdx; i < code.length && i < openIdx + 4000; i++) {
        const c = code[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return { index: i };
        }
    }
    return undefined;
}

function extractRawParams(src: string, start: number, end: number): string {
    return src
        .slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function collectEnumMembers(text: string, ln: number, colBase: number, parent: string, syms: PawnSymbol[]): void {
    const re = /(?:^|,)\s*(?:[A-Za-z_]\w*:)?([A-Za-z_@][\w@]*)\s*(\[[^\]]*\])?\s*(=\s*[^,]+)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (!m[1] || KEYWORDS.has(m[1])) continue;
        syms.push({
            name: m[1],
            kind: 'enumMember',
            line: ln,
            col: colBase + text.indexOf(m[1], m.index),
            signature: `${parent} :: ${m[1]}${m[2] ?? ''}`,
            parent,
        });
        if (m[0].length === 0) re.lastIndex++;
    }
}

function collectVars(text: string, ln: number, line: string, syms: PawnSymbol[], kind: 'variable' | 'constant', raw: string[], local = false): void {
    const decl = text.replace(/;.*$/, '');
    for (const part of splitParams(decl)) {
        const m = /^(?:([A-Za-z_]\w*):)?([A-Za-z_@][\w@]*)\s*((?:\[[^\]]*\])*)/.exec(part.trim());
        if (!m || KEYWORDS.has(m[2])) continue;
        const valueMatch = /=\s*(.+)$/.exec(part);
        syms.push({
            name: m[2],
            kind,
            line: ln,
            col: Math.max(0, line.indexOf(m[2])),
            signature: `${kind === 'constant' ? 'const' : local ? 'new' : 'new'} ${m[1] ? m[1] + ':' : ''}${m[2]}${m[3] ?? ''}`,
            tag: m[1],
            value: valueMatch?.[1].trim(),
            doc: local ? undefined : docAbove(raw, ln),
        });
    }
}

/** "Clean" name of a parameter: `const Float:pos[3] = {0.0, ...}` → `pos`. */
export function paramName(p: string): string {
    const noDefault = p.replace(/=.*$/, '').trim();
    const noArr = noDefault.replace(/\[.*$/, '').trim();
    const m = /([A-Za-z_@%][\w@]*)\s*$/.exec(noArr.replace(/^(const\s+)?&?/, ''));
    return m ? m[1] : noArr;
}

export type ParamMode = 'required' | 'all' | 'none';

/**
 * Call snippet with the parameters as fields (Tab jumps between them):
 *   SetPlayerPos(${1:playerid}, ${2:x}, ${3:y}, ${4:z})
 * 'required' stops at the last parameter without a default value; variadics (...) are never included.
 */
export function callSnippet(name: string, params: string[] | undefined, kind: SymbolKind, mode: ParamMode = 'required'): string {
    const list = (params ?? []).filter((p) => !p.includes('...'));
    if (mode === 'none' || !list.length) return `${name}(${params?.length ? '$0' : ''})`;
    let count = list.length;
    if (mode === 'required') {
        count = 0;
        list.forEach((p, i) => {
            if (!p.includes('=')) count = i + 1;
        });
        if (!count) return `${name}($0)`;
    }
    const esc = (s: string) => s.replace(/[$}\\]/g, '\\$&');
    const fields = list.slice(0, count).map((p, i) => (kind === 'macro' ? `\${${i + 1}}` : `\${${i + 1}:${esc(paramName(p))}}`));
    const more = count < (params ?? []).length ? '$0' : '';
    return `${name}(${fields.join(', ')}${more})`;
}

/**
 * Finds the function call the cursor is in and the index of the current parameter.
 * `text` = document content up to the cursor.
 */
export function callContext(text: string): { name: string; paramIndex: number } | undefined {
    const code = blankCode(text);
    let depth = 0;
    let commas = 0;
    for (let i = code.length - 1; i >= 0 && i > code.length - 4000; i--) {
        const c = code[i];
        if (c === ')' || c === ']' || c === '}') depth++;
        else if (c === '[' || c === '{') {
            if (depth === 0) return undefined;
            depth--;
        } else if (c === '(') {
            if (depth === 0) {
                const m = /([A-Za-z_@][\w@:]*)\s*$/.exec(code.slice(Math.max(0, i - 80), i));
                if (!m || KEYWORDS.has(m[1])) return undefined;
                return { name: m[1].replace(/^.*:/, ''), paramIndex: commas };
            }
            depth--;
        } else if (c === ',' && depth === 0) commas++;
        else if (c === ';' && depth === 0) return undefined;
    }
    return undefined;
}
