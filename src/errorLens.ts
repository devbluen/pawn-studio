/**
 * Error lens: shows the error/warning message at the end of the line and highlights the line.
 */
import * as vscode from 'vscode';
import { cfg } from './context';

const SEV_ORDER = [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information, vscode.DiagnosticSeverity.Hint];

export class ErrorLens implements vscode.Disposable {
    private types: Map<vscode.DiagnosticSeverity, vscode.TextEditorDecorationType>;
    private disposables: vscode.Disposable[] = [];
    private timer: NodeJS.Timeout | undefined;

    constructor() {
        const make = (fg: string, bg: string, icon: string) =>
            vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: new vscode.ThemeColor(bg),
                after: { color: new vscode.ThemeColor(fg), margin: '0 0 0 2.5em', fontStyle: 'italic', contentText: icon },
                overviewRulerColor: new vscode.ThemeColor(fg),
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            });
        this.types = new Map([
            [vscode.DiagnosticSeverity.Error, make('pawnStudio.errorLensErrorForeground', 'pawnStudio.errorLensErrorBackground', '')],
            [vscode.DiagnosticSeverity.Warning, make('pawnStudio.errorLensWarningForeground', 'pawnStudio.errorLensWarningBackground', '')],
            [vscode.DiagnosticSeverity.Information, make('pawnStudio.errorLensInfoForeground', 'pawnStudio.errorLensInfoBackground', '')],
        ]);
        this.disposables.push(
            vscode.languages.onDidChangeDiagnostics(() => this.schedule()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
            vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('pawnStudio.errorLens') && this.schedule()),
        );
        this.schedule();
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 60);
    }

    refresh(): void {
        const c = cfg();
        const enabled = c.get<boolean>('errorLens.enabled', true);
        const showWarnings = c.get<boolean>('errorLens.showWarnings', true);
        const allLanguages = c.get<boolean>('errorLens.allLanguages', false);
        for (const editor of vscode.window.visibleTextEditors) {
            const isPawn = editor.document.languageId === 'pawn';
            const perSev = new Map<vscode.DiagnosticSeverity, vscode.DecorationOptions[]>();
            if (enabled && (isPawn || allLanguages)) {
                const byLine = new Map<number, vscode.Diagnostic[]>();
                for (const d of vscode.languages.getDiagnostics(editor.document.uri)) {
                    if (d.severity === vscode.DiagnosticSeverity.Hint) continue;
                    if (d.severity === vscode.DiagnosticSeverity.Warning && !showWarnings) continue;
                    const ln = d.range.end.line;
                    if (!byLine.has(ln)) byLine.set(ln, []);
                    byLine.get(ln)!.push(d);
                }
                for (const [ln, list] of byLine) {
                    if (ln >= editor.document.lineCount) continue;
                    list.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
                    const top = list[0];
                    const sev = top.severity === vscode.DiagnosticSeverity.Information ? vscode.DiagnosticSeverity.Information : top.severity;
                    const icon = sev === vscode.DiagnosticSeverity.Error ? '✖' : sev === vscode.DiagnosticSeverity.Warning ? '⚠' : 'ℹ';
                    const code = typeof top.code === 'object' ? top.code.value : top.code;
                    const extra = list.length > 1 ? `  (+${list.length - 1})` : '';
                    const text = `${icon} ${code !== undefined ? `${code}: ` : ''}${top.message.split('\n')[0]}${extra}`;
                    const line = editor.document.lineAt(ln);
                    const opt: vscode.DecorationOptions = {
                        range: new vscode.Range(ln, line.range.end.character, ln, line.range.end.character),
                        renderOptions: { after: { contentText: text.length > 200 ? text.slice(0, 200) + '…' : text } },
                    };
                    if (!perSev.has(sev)) perSev.set(sev, []);
                    perSev.get(sev)!.push(opt);
                }
            }
            for (const [sev, type] of this.types) editor.setDecorations(type, perSev.get(sev) ?? []);
        }
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.disposables.forEach((d) => d.dispose());
        this.types.forEach((t) => t.dispose());
    }
}
