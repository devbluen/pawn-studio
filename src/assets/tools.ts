/**
 * "Tools" sidebar view + command wiring for the asset browser and Dialog Creator.
 */
import * as vscode from 'vscode';
import { t } from '../i18n';
import { parseDialogCall } from './dialogParse';
import { findAttachBlock } from './attachParse';
import { findZoneBlock } from './zoneParse';
import { AssetBrowser, AssetTab, AttachEditor, DialogCreator, DialogPrefill, EditorTracker, GangZoneCreator, pickGtaFolder } from './panels';
import { findGtaDir } from '../gta/install';
import { cfg } from '../context';

class ToolsView implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
        return e;
    }

    getChildren(): vscode.TreeItem[] {
        const item = (label: string, icon: string, command: string, tooltip: string) => {
            const i = new vscode.TreeItem(label);
            i.iconPath = new vscode.ThemeIcon(icon);
            i.command = { command, title: label };
            i.tooltip = tooltip;
            return i;
        };
        // where the finders read the game from: click to pick another folder
        const dir = findGtaDir(cfg().get<string>('gtaPath') || undefined);
        const gta = item(t('GTA San Andreas'), dir ? 'folder' : 'warning', 'pawnStudio.tools.selectGta', dir ? t('{0}\nClick to use another GTA San Andreas folder.', dir) : t('GTA San Andreas not found. Click to choose its folder.'));
        gta.description = dir ? dir : t('not found — click to choose');
        return [
            item(t('Objects'), 'symbol-class', 'pawnStudio.tools.objects', t('Search the 15,000+ GTA and SA-MP objects by ID or name, with a 3D preview')),
            item(t('Sprites'), 'file-media', 'pawnStudio.tools.sprites', t('TextDraw sprites (ld_beat:chit…) with image preview')),
            item(t('Animations'), 'person', 'pawnStudio.tools.animations', t('Every animation library with a 3D preview on any skin')),
            item(t('Sounds'), 'unmute', 'pawnStudio.tools.sounds', t('Sound IDs for PlayerPlaySound, with the game\'s names')),
            item(t('Attached Objects'), 'person-add', 'pawnStudio.tools.attach', t('Position objects on the player (SetPlayerAttachedObject) or on a vehicle (AttachObjectToVehicle) in 3D')),
            item(t('Dialog Creator'), 'comment-discussion', 'pawnStudio.tools.dialog', t('Build a dialog visually and generate the code')),
            item(t('GangZone Creator'), 'map', 'pawnStudio.tools.gangzone', t('Draw gang zones (rectangle, circle, polygon) on the map and generate the code, with streamer areas')),
            gta,
        ];
    }
}

export function registerTools(ctx: vscode.ExtensionContext): void {
    const editors = new EditorTracker();
    const assets = new AssetBrowser(ctx, editors);
    const dialogs = new DialogCreator(ctx, editors);
    const attach = new AttachEditor(ctx, editors);
    const zones = new GangZoneCreator(ctx, editors);
    const toolsView = new ToolsView();
    ctx.subscriptions.push(
        editors, assets, dialogs, attach, zones,
        vscode.window.registerTreeDataProvider('pawnStudio.tools', toolsView),
        vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('pawnStudio.gtaPath') && toolsView.refresh()),
    );
    const tab = (id: AssetTab) => () => assets.open(id);
    const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg('pawnStudio.tools.objects', tab('objects'));
    reg('pawnStudio.tools.sprites', tab('sprites'));
    reg('pawnStudio.tools.animations', tab('animations'));
    reg('pawnStudio.tools.sounds', tab('sounds'));
    // one entry point that works whatever the sidebar layout is (🧰 in the Pawn views' header)
    reg('pawnStudio.tools.open', async () => {
        type Item = vscode.QuickPickItem & { command: string };
        const items: Item[] = new ToolsView().getChildren().filter((i) => i.command?.command !== 'pawnStudio.tools.selectGta').map((i) => ({
            label: `$(${(i.iconPath as vscode.ThemeIcon).id}) ${String(i.label)}`,
            detail: String(i.tooltip ?? ''),
            command: i.command!.command,
        }));
        const pick = await vscode.window.showQuickPick(items, { title: t('Pawn tools'), matchOnDetail: true });
        if (pick) await vscode.commands.executeCommand(pick.command);
    });
    reg('pawnStudio.tools.selectGta', () => pickGtaFolder());
    reg('pawnStudio.tools.attach', () => {
        // the attachment lines under the cursor (or the selection) open in the editor
        const ed = vscode.window.activeTextEditor;
        const block =
            ed && ed.document.languageId === 'pawn'
                ? findAttachBlock(ed.document.getText().split(/\r?\n/), ed.selection.active.line, ed.selection.isEmpty ? undefined : ed.document.getText(ed.selection))
                : undefined;
        attach.open(block);
    });
    reg('pawnStudio.tools.gangzone', () => {
        // gang zone code under the cursor (or the selection) opens in the editor
        const ed = vscode.window.activeTextEditor;
        const code =
            ed && ed.document.languageId === 'pawn'
                ? findZoneBlock(ed.document.getText().split(/\r?\n/), ed.selection.active.line, ed.selection.isEmpty ? undefined : ed.document.getText(ed.selection))
                : undefined;
        zones.open(code);
    });
    reg('pawnStudio.tools.dialog', () => {
        const ed = vscode.window.activeTextEditor;
        let prefill: DialogPrefill | undefined;
        if (ed && ed.document.languageId === 'pawn') {
            // the call may span a few lines
            const line = ed.selection.active.line;
            const from = Math.max(0, line - 2);
            const chunk = ed.document.getText(new vscode.Range(from, 0, Math.min(ed.document.lineCount - 1, line + 6), 10000));
            const at = ed.document.offsetAt(ed.selection.active) - ed.document.offsetAt(new vscode.Position(from, 0));
            const calls = [...chunk.matchAll(/\b(ShowPlayerDialog|Dialog_Show)\s*\(/g)];
            const near = calls.filter((c) => c.index! <= at + 40).pop() ?? calls[0];
            if (near) prefill = parseDialogCall(chunk.slice(near.index));
        }
        dialogs.open(prefill);
    });
}
