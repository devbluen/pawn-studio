/**
 * Reads an existing ShowPlayerDialog / Dialog_Show call into the Dialog Creator's fields.
 * No VS Code dependency (unit-tested in plain Node).
 */
export interface ParsedDialog {
    name?: string;
    style?: string;
    caption?: string;
    body?: string;
    button1?: string;
    button2?: string;
    codeStyle?: 'native' | 'easy';
}

/** Splits the arguments of a call, respecting strings and nested parentheses. */
export function splitArgs(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    let str = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (str) {
            cur += c;
            if (c === '\\') cur += s[++i] ?? '';
            else if (c === '"') str = false;
            continue;
        }
        if (c === '"') str = true;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) break;
            depth--;
        } else if (c === ',' && depth === 0) {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function unquote(a: string | undefined): string | undefined {
    if (!a) return undefined;
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(a.trim());
    if (!m) return undefined;
    return m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/** Reads ShowPlayerDialog(...) / Dialog_Show(...) under the cursor into the creator's fields. */
export function parseDialogCall(text: string): ParsedDialog | undefined {
    const m = /\b(ShowPlayerDialog|Dialog_Show)\s*\(/.exec(text);
    if (!m) return undefined;
    const a = splitArgs(text.slice(m.index + m[0].length));
    if (a.length < 7) return undefined;
    const style = /^DIALOG_STYLE_[A-Z_]+$/.test(a[2]) ? a[2] : undefined;
    return {
        name: a[1],
        style,
        caption: unquote(a[3]),
        body: unquote(a[4]),
        button1: unquote(a[5]),
        button2: unquote(a[6]),
        codeStyle: m[1] === 'Dialog_Show' ? 'easy' : 'native',
    };
}

