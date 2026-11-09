/**
 * IntelliSense: completion, parameter hints, hover, go to definition and outline.
 * Symbols come from the #include tree of the file's target (a_samp natives, includes, modules).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Builder } from '../build';
import { t } from '../i18n';
import { cfg, Pawn } from '../context';
import { pathKey } from '../includeGraph';
import { callContext, callSnippet, ParamMode, parseSymbols, PawnSymbol, SymbolKind } from './symbols';

interface FileSymbols {
    mtimeMs: number;
    size: number;
    symbols: PawnSymbol[];
}

type Located = PawnSymbol & { file: string };

const SELECTOR: vscode.DocumentSelector = [{ language: 'pawn', scheme: 'file' }, { language: 'pawn', scheme: 'untitled' }];
const WORD = /[A-Za-z_@][\w@]*/;

export interface LintData {
    entry?: string;
    /** symbols from all visible files, by name (with `file`) */
    external: Map<string, PawnSymbol[]>;
    /** how many visible files each word appears in */
    wordFiles: Map<string, number>;
    /** some visible file has `#pragma semicolon 1` */
    pragmaSemicolon: boolean;
}

interface FileWords {
    mtimeMs: number;
    size: number;
    words: Set<string>;
    pragmaSemicolon: boolean;
}

export class SymbolIndex {
    private files = new Map<string, FileSymbols>();
    private wordCache = new Map<string, FileWords>();
    private closureCache = new Map<string, string[]>();
    private lintCache = new Map<string, Promise<LintData>>();

    constructor(
        private pawn: Pawn,
        private builder: Builder,
    ) {}

    /** Call when files are saved / created / deleted: the include tree may have changed. */
    invalidate(): void {
        this.closureCache.clear();
        this.lintCache.clear();
    }

    fileWords(file: string): FileWords | undefined {
        const k = pathKey(file);
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            this.wordCache.delete(k);
            return undefined;
        }
        const c = this.wordCache.get(k);
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
        let src = '';
        try {
            src = fs.readFileSync(file, 'latin1');
        } catch {
            return undefined;
        }
        const entry: FileWords = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            words: new Set(src.match(/[A-Za-z_@][\w@]*/g) ?? []),
            pragmaSemicolon: /^[ \t]*#[ \t]*pragma[ \t]+semicolon[ \t]+1/m.test(src),
        };
        this.wordCache.set(k, entry);
        return entry;
    }

    /** Data for the quick analysis of a document (cached per target until something is saved). */
    lintData(doc: vscode.TextDocument): Promise<LintData> {
        const key = doc.uri.scheme === 'file' ? pathKey(doc.fileName) : doc.uri.toString();
        let p = this.lintCache.get(key);
        if (!p) {
            p = this.buildLintData(doc);
            this.lintCache.set(key, p);
            p.catch(() => this.lintCache.delete(key));
        }
        return p;
    }

    private async buildLintData(doc: vscode.TextDocument): Promise<LintData> {
        let entry: string | undefined;
        if (doc.uri.scheme === 'file') {
            const r = await this.builder.resolve(doc.fileName);
            entry = 'target' in r ? r.target.entry : 'ambiguous' in r ? r.ambiguous[0] : undefined;
        }
        const files = await this.visibleFiles(doc);
        // includes the on-disk version of the document itself (excluded later per file)
        const all = doc.uri.scheme === 'file' && fs.existsSync(doc.fileName) ? [...files, doc.fileName] : files;
        const external = new Map<string, PawnSymbol[]>();
        const wordFiles = new Map<string, number>();
        let pragmaSemicolon = false;
        for (const f of all) {
            for (const s of this.fileSymbols(f)) {
                const located = s.file ? s : Object.assign(s, { file: f });
                const list = external.get(s.name);
                if (list) list.push(located);
                else external.set(s.name, [located]);
            }
            const w = this.fileWords(f);
            if (!w) continue;
            pragmaSemicolon ||= w.pragmaSemicolon;
            for (const word of w.words) wordFiles.set(word, (wordFiles.get(word) ?? 0) + 1);
        }
        return { entry, external, wordFiles, pragmaSemicolon };
    }

    fileSymbols(file: string): PawnSymbol[] {
        const k = pathKey(file);
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            this.files.delete(k);
            return [];
        }
        const c = this.files.get(k);
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.symbols;
        let symbols: PawnSymbol[] = [];
        try {
            symbols = parseSymbols(fs.readFileSync(file, 'latin1'));
        } catch {
            symbols = [];
        }
        this.files.set(k, { mtimeMs: st.mtimeMs, size: st.size, symbols });
        return symbols;
    }

    /** Files visible from a document: the target's tree + the file's own includes. */
    async visibleFiles(doc: vscode.TextDocument): Promise<string[]> {
        const key = doc.uri.toString();
        const hit = this.closureCache.get(key);
        if (hit) return hit;

        const files = new Map<string, string>();
        const graph = this.pawn.graph;
        if (doc.uri.scheme === 'file') {
            let entry: string | undefined;
            try {
                const r = await this.builder.resolve(doc.fileName);
                if ('target' in r) entry = r.target.entry;
                else if ('ambiguous' in r) entry = r.ambiguous[0];
            } catch {
                entry = undefined;
            }
            this.pawn.syncGraphIncludes(entry);
            if (entry) for (const [k, f] of graph.closure(entry)) files.set(k, f);
            for (const [k, f] of graph.closure(doc.fileName)) files.set(k, f);
        } else {
            this.pawn.syncGraphIncludes();
        }
        // a_samp/open.mp always available, even in an orphan file
        if (files.size <= 1) {
            for (const dir of this.pawn.includeDirs()) {
                for (const name of ['open.mp.inc', 'a_samp.inc']) {
                    const p = path.join(dir, name);
                    if (fs.existsSync(p)) for (const [k, f] of graph.closure(p)) files.set(k, f);
                }
            }
        }
        files.delete(pathKey(doc.fileName));
        const list = [...files.values()];
        this.closureCache.set(key, list);
        return list;
    }

    async symbolsFor(doc: vscode.TextDocument): Promise<{ own: Located[]; external: Located[] }> {
        const own = parseSymbols(doc.getText(), { locals: true }).map((s) => ({ ...s, file: doc.fileName }));
        const external: Located[] = [];
        for (const f of await this.visibleFiles(doc)) {
            for (const s of this.fileSymbols(f)) external.push({ ...s, file: f });
        }
        return { own, external };
    }

    async lookup(doc: vscode.TextDocument, name: string): Promise<Located[]> {
        const { own, external } = await this.symbolsFor(doc);
        return [...own.filter((s) => s.name === name), ...external.filter((s) => s.name === name)];
    }

    allIndexed(): Located[] {
        const out: Located[] = [];
        for (const [k] of this.files) {
            const entry = this.files.get(k)!;
            for (const s of entry.symbols) out.push({ ...s, file: k });
        }
        return out;
    }
}

// ───────────────────────── helpers ─────────────────────────

function completionKind(k: SymbolKind): vscode.CompletionItemKind {
    switch (k) {
        case 'native':
        case 'stock':
        case 'function':
        case 'public':
        case 'forward':
            return vscode.CompletionItemKind.Function;
        case 'define':
            return vscode.CompletionItemKind.Constant;
        case 'macro':
            return vscode.CompletionItemKind.Snippet;
        case 'enum':
            return vscode.CompletionItemKind.Enum;
        case 'enumMember':
            return vscode.CompletionItemKind.EnumMember;
        case 'constant':
            return vscode.CompletionItemKind.Constant;
        default:
            return vscode.CompletionItemKind.Variable;
    }
}

function symbolKind(k: SymbolKind): vscode.SymbolKind {
    switch (k) {
        case 'native':
        case 'stock':
        case 'function':
        case 'public':
        case 'forward':
            return vscode.SymbolKind.Function;
        case 'define':
        case 'constant':
            return vscode.SymbolKind.Constant;
        case 'macro':
            return vscode.SymbolKind.Operator;
        case 'enum':
            return vscode.SymbolKind.Enum;
        case 'enumMember':
            return vscode.SymbolKind.EnumMember;
        default:
            return vscode.SymbolKind.Variable;
    }
}

const KIND_RANK: Record<SymbolKind, number> = {
    native: 0, stock: 1, function: 1, public: 2, macro: 3, define: 3, enum: 4, enumMember: 4, constant: 5, variable: 5, forward: 9,
};

/** One symbol per name, preferring definitions over forwards. */
function dedupe(list: Located[]): Located[] {
    const map = new Map<string, Located>();
    for (const s of list) {
        const cur = map.get(s.name);
        if (!cur || KIND_RANK[s.kind] < KIND_RANK[cur.kind] || (!cur.doc && s.doc && KIND_RANK[s.kind] === KIND_RANK[cur.kind])) {
            map.set(s.name, s);
        }
    }
    return [...map.values()];
}

function markdownFor(s: Located): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendCodeblock(s.signature, 'pawn');
    if (s.doc) md.appendMarkdown('\n' + s.doc + '\n');
    if (s.kind === 'define' && s.value && !s.signature.includes(s.value)) md.appendCodeblock(s.value, 'pawn');
    md.appendMarkdown(`\n\n*${vscode.workspace.asRelativePath(s.file, false)}:${s.line + 1}*`);
    return md;
}

function sortText(s: Located, ownFile: boolean): string {
    return `${ownFile ? 0 : 1}${KIND_RANK[s.kind]}${s.name.toLowerCase()}`;
}

// ───────────────────────── registration ─────────────────────────

export function registerLanguageFeatures(pawn: Pawn, index: SymbolIndex): vscode.Disposable[] {
    const d: vscode.Disposable[] = [];

    d.push(
        vscode.languages.registerCompletionItemProvider(
            SELECTOR,
            {
                async provideCompletionItems(doc, pos) {
                    const linePrefix = doc.lineAt(pos.line).text.slice(0, pos.character);

                    // #include <...> / "..."
                    const inc = /^\s*#\s*(?:try)?include\s*([<"])([^>"]*)$/.exec(linePrefix);
                    if (inc) return includeCompletions(pawn, doc, inc[1], inc[2]);

                    // inside a string/comment: nothing
                    if (/\/\//.test(linePrefix.replace(/"[^"]*"/g, '')) || (linePrefix.split('"').length - 1) % 2 === 1) return undefined;

                    const { own, external } = await index.symbolsFor(doc);
                    const items: vscode.CompletionItem[] = [];
                    const ownNames = new Set(own.map((s) => s.name));
                    // Libraries like YSI have thousands of internal symbols with "_" — only shown if the user types "_".
                    const word = doc.getText(doc.getWordRangeAtPosition(pos, WORD) ?? new vscode.Range(pos, pos));
                    const showInternal = word.startsWith('_') || word.startsWith('@');
                    // Is there already a "(" after the cursor (editing a call)? Then complete only the name.
                    const wordEnd = doc.getWordRangeAtPosition(pos, WORD)?.end ?? pos;
                    const hasParen = /^\s*\(/.test(doc.lineAt(pos.line).text.slice(wordEnd.character));
                    const mode = cfg().get<ParamMode>('completion.parameters', 'required');
                    for (const s of dedupe([...own, ...external])) {
                        if (!showInternal && !ownNames.has(s.name) && (s.name.startsWith('_') || s.name.startsWith('@') || s.name.includes('@'))) continue;
                        const it = new vscode.CompletionItem({ label: s.name, description: path.basename(s.file) }, completionKind(s.kind));
                        it.detail = s.signature;
                        it.documentation = markdownFor(s);
                        it.sortText = sortText(s, ownNames.has(s.name));
                        if (['native', 'stock', 'function', 'public', 'forward', 'macro'].includes(s.kind) && s.params && !hasParen) {
                            it.insertText = new vscode.SnippetString(callSnippet(s.name, s.params, s.kind, mode));
                            if (s.params.length) it.command = { command: 'editor.action.triggerParameterHints', title: '' };
                        }
                        items.push(it);
                    }
                    return items;
                },
            },
            '<',
            '"',
            '/',
        ),
    );

    d.push(
        vscode.languages.registerSignatureHelpProvider(
            SELECTOR,
            {
                async provideSignatureHelp(doc, pos) {
                    const text = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - 40), 0), pos));
                    const ctx = callContext(text);
                    if (!ctx) return undefined;
                    const cands = (await index.lookup(doc, ctx.name)).filter((s) => s.params);
                    if (!cands.length) return undefined;
                    const best = dedupe(cands)[0];
                    const help = new vscode.SignatureHelp();
                    const sig = new vscode.SignatureInformation(best.signature, best.doc ? new vscode.MarkdownString(best.doc) : undefined);
                    sig.parameters = (best.params ?? []).map((p) => new vscode.ParameterInformation(p));
                    help.signatures = [sig];
                    help.activeSignature = 0;
                    const variadic = (best.params ?? []).some((p) => p.includes('...'));
                    help.activeParameter = variadic ? Math.min(ctx.paramIndex, (best.params?.length ?? 1) - 1) : ctx.paramIndex;
                    return help;
                },
            },
            '(',
            ',',
        ),
    );

    d.push(
        vscode.languages.registerHoverProvider(SELECTOR, {
            async provideHover(doc, pos) {
                const range = doc.getWordRangeAtPosition(pos, WORD);
                if (!range) return undefined;
                const line = doc.lineAt(pos.line).text;
                const inc = /^\s*#\s*(?:try)?include\s*[<"]?([^>"\s]+)/.exec(line);
                if (inc && doc.uri.scheme === 'file') {
                    const style = /</.test(line) ? 'angle' : /"/.test(line) ? 'quote' : 'bare';
                    pawn.syncGraphIncludes();
                    const r = pawn.graph.resolveInclude({ name: inc[1], style }, doc.fileName, path.dirname(doc.fileName));
                    return new vscode.Hover(r ? `\`${r}\`` : '⚠ ' + t('Include not found in the include folders'), range);
                }
                const found = dedupe(await index.lookup(doc, doc.getText(range)));
                if (!found.length) return undefined;
                return new vscode.Hover(markdownFor(found[0]), range);
            },
        }),
    );

    d.push(
        vscode.languages.registerDefinitionProvider(SELECTOR, {
            async provideDefinition(doc, pos) {
                const line = doc.lineAt(pos.line).text;
                const inc = /^\s*#\s*(?:try)?include\s*[<"]?([^>"\s]+)/.exec(line);
                if (inc && doc.uri.scheme === 'file') {
                    const style = /</.test(line) ? 'angle' : /"/.test(line) ? 'quote' : 'bare';
                    pawn.syncGraphIncludes();
                    const r = pawn.graph.resolveInclude({ name: inc[1], style }, doc.fileName, path.dirname(doc.fileName));
                    return r ? new vscode.Location(vscode.Uri.file(r), new vscode.Position(0, 0)) : undefined;
                }
                const range = doc.getWordRangeAtPosition(pos, WORD);
                if (!range) return undefined;
                const found = await index.lookup(doc, doc.getText(range));
                // Prefer definitions; show forwards only if there is nothing else
                const defs = found.filter((s) => s.kind !== 'forward');
                return (defs.length ? defs : found).map(
                    (s) => new vscode.Location(vscode.Uri.file(s.file), new vscode.Position(s.line, Math.max(0, s.col))),
                );
            },
        }),
    );

    d.push(
        vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
            provideDocumentSymbols(doc) {
                const syms = parseSymbols(doc.getText());
                const enums = new Map<string, vscode.DocumentSymbol>();
                const out: vscode.DocumentSymbol[] = [];
                for (const s of syms) {
                    const start = new vscode.Position(s.line, Math.max(0, s.col));
                    const end = s.endLine !== undefined ? doc.lineAt(Math.min(s.endLine, doc.lineCount - 1)).range.end : doc.lineAt(s.line).range.end;
                    const sel = new vscode.Range(start, start.translate(0, s.name.length));
                    const ds = new vscode.DocumentSymbol(s.name, s.kind === 'forward' ? 'forward' : s.signature.replace(s.name, '').trim(), symbolKind(s.kind), new vscode.Range(start, end), sel);
                    if (s.kind === 'enum') enums.set(s.name, ds);
                    if (s.kind === 'enumMember' && s.parent && enums.has(s.parent)) {
                        enums.get(s.parent)!.children.push(ds);
                        continue;
                    }
                    out.push(ds);
                }
                return out;
            },
        }),
    );

    d.push(
        vscode.languages.registerWorkspaceSymbolProvider({
            provideWorkspaceSymbols(query) {
                const q = query.toLowerCase();
                if (!q) return [];
                return index
                    .allIndexed()
                    .filter((s) => s.name.toLowerCase().includes(q) && s.kind !== 'variable')
                    .slice(0, 500)
                    .map(
                        (s) =>
                            new vscode.SymbolInformation(
                                s.name,
                                symbolKind(s.kind),
                                path.basename(s.file),
                                new vscode.Location(vscode.Uri.file(s.file), new vscode.Position(s.line, Math.max(0, s.col))),
                            ),
                    );
            },
        }),
    );

    return d;
}

function includeCompletions(pawn: Pawn, doc: vscode.TextDocument, quote: string, typed: string): vscode.CompletionItem[] {
    const sub = typed.replace(/\\/g, '/');
    const dirPart = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/') + 1) : '';
    const bases = quote === '<' ? pawn.includeDirs() : [path.dirname(doc.fileName), ...pawn.includeDirs()];
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const base of bases) {
        const dir = path.join(base, dirPart);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory()) {
                if (seen.has('d:' + e.name)) continue;
                seen.add('d:' + e.name);
                const it = new vscode.CompletionItem(e.name + '/', vscode.CompletionItemKind.Folder);
                it.insertText = e.name + '/';
                it.command = { command: 'editor.action.triggerSuggest', title: '' };
                items.push(it);
            } else if (/\.(inc|pwn|p)$/i.test(e.name)) {
                const label = quote === '<' || /\.inc$/i.test(e.name) ? e.name.replace(/\.inc$/i, '') : e.name;
                if (seen.has('f:' + label)) continue;
                seen.add('f:' + label);
                const it = new vscode.CompletionItem(label, vscode.CompletionItemKind.File);
                it.detail = path.join(dir, e.name);
                items.push(it);
            }
        }
    }
    return items;
}
