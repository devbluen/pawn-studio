/**
 * Asset browser (objects, sprites, animations, sounds) and Dialog Creator webview panels.
 * Game data comes from the user's GTA SA installation (src/gta), never bundled.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg } from '../context';
import { findGtaDir, GtaInstall, isGtaDir, LoadedModel } from '../gta/install';
import { objectRotation } from '../gta/ipl';
import { encodeWav } from '../gta/sfx';
import { BANK_NAMES } from '../gta/soundMap';
import { t } from '../i18n';

let sharedGta: GtaInstall | undefined;

/** Lets the user pick the GTA San Andreas folder (validated) and saves it in pawnStudio.gtaPath. */
export async function pickGtaFolder(): Promise<boolean> {
    const current = findGtaDir(cfg().get<string>('gtaPath') || undefined);
    const sel = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        defaultUri: current ? vscode.Uri.file(current) : undefined,
        openLabel: t('Use this folder'),
        title: t('Select the GTA San Andreas folder (the one with gta_sa.exe)'),
    });
    if (!sel?.length) return false;
    if (!isGtaDir(sel[0].fsPath)) {
        vscode.window.showErrorMessage(t('{0} does not look like a GTA San Andreas folder (gta_sa.exe and models/gta3.img are required).', sel[0].fsPath));
        return false;
    }
    await cfg().update('gtaPath', sel[0].fsPath, vscode.ConfigurationTarget.Global);
    sharedGta = undefined;
    vscode.window.setStatusBarMessage(t('$(check) GTA San Andreas: {0}', sel[0].fsPath), 4000);
    return true;
}

/** The GTA installation from the setting / registry / common folders, shared by every panel. */
export function gtaInstall(): GtaInstall {
    const dir = findGtaDir(cfg().get<string>('gtaPath') || undefined);
    if (!dir) throw Object.assign(new Error(t('GTA San Andreas not found.')), { code: 'NO_GTA' });
    if (sharedGta?.dir !== dir) sharedGta = new GtaInstall(dir);
    return sharedGta;
}

export type AssetTab = 'objects' | 'sprites' | 'animations' | 'sounds';

function nonce(): string {
    let s = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

/** Remembers the last Pawn editor: the webview steals focus, but code goes where the user was typing. */
export class EditorTracker implements vscode.Disposable {
    private last: vscode.TextEditor | undefined;
    private sub: vscode.Disposable;

    constructor() {
        this.last = this.pick(vscode.window.activeTextEditor);
        this.sub = vscode.window.onDidChangeActiveTextEditor((e) => {
            this.last = this.pick(e) ?? this.last;
        });
    }

    private pick(e: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
        return e && e.document.uri.scheme !== 'output' ? e : undefined;
    }

    async insert(code: string, asSnippet: boolean): Promise<boolean> {
        let editor = this.last && vscode.window.visibleTextEditors.find((v) => v.document === this.last!.document);
        if (!editor && this.last) editor = await vscode.window.showTextDocument(this.last.document, { preserveFocus: false, viewColumn: this.last.viewColumn });
        if (!editor) {
            await vscode.env.clipboard.writeText(code);
            vscode.window.showInformationMessage(t('No editor open — the code was copied to the clipboard.'));
            return false;
        }
        await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
        if (asSnippet) await editor.insertSnippet(new vscode.SnippetString(code));
        else await editor.edit((b) => editor!.selections.forEach((s) => b.replace(s, code)));
        return true;
    }

    dispose(): void {
        this.sub.dispose();
    }
}

abstract class Panel implements vscode.Disposable {
    protected panel: vscode.WebviewPanel | undefined;
    protected disposables: vscode.Disposable[] = [];

    constructor(
        protected ctx: vscode.ExtensionContext,
        protected editors: EditorTracker,
        private viewType: string,
    ) {}

    protected abstract title(): string;
    protected abstract script(): string;
    protected abstract onMessage(msg: any): Promise<void> | void;
    protected styles(): string[] {
        return ['ui.css'];
    }

    protected reveal(): vscode.WebviewPanel {
        if (this.panel) {
            this.panel.reveal(undefined, false);
            return this.panel;
        }
        const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
        const panel = vscode.window.createWebviewPanel(this.viewType, this.title(), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [media],
        });
        panel.iconPath = vscode.Uri.joinPath(media, 'pawn.svg');
        const w = panel.webview;
        const n = nonce();
        const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
        const strings = JSON.stringify(this.strings()).replace(/</g, '\\u003c');
        panel.webview.html = `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data: blob:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${n}' ${w.cspSource}; connect-src data: blob:; worker-src blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${this.styles().map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n')}
<script nonce="${n}" type="importmap">{"imports":{"three":"${uri('vendor/three.module.min.js')}","three/addons/":"${uri('vendor/')}"}}</script>
</head>
<body>
<div id="app"></div>
<script nonce="${n}">window.L10N = ${strings};</script>
<script nonce="${n}" type="module" src="${uri(this.script())}"></script>
</body>
</html>`;
        panel.webview.onDidReceiveMessage(
            (m) =>
                Promise.resolve(this.onMessage(m)).catch((e) => {
                    void panel.webview.postMessage({ type: 'error', message: (e as Error).message ?? String(e), request: m?.type, reqId: m?.reqId });
                }),
            undefined,
            this.disposables,
        );
        panel.onDidDispose(() => (this.panel = undefined), undefined, this.disposables);
        this.panel = panel;
        return panel;
    }

    /** UI strings for the webview (translated here, so the webview has no i18n logic). */
    protected abstract strings(): Record<string, string>;

    protected post(msg: unknown): void {
        void this.panel?.webview.postMessage(msg);
    }

    dispose(): void {
        this.panel?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}

// ───────────────────────── asset browser ─────────────────────────

export class AssetBrowser extends Panel {
    private install: GtaInstall | undefined;
    private installDir: string | undefined;
    private pendingTab: AssetTab = 'objects';

    constructor(ctx: vscode.ExtensionContext, editors: EditorTracker) {
        super(ctx, editors, 'pawnStudio.assets');
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pawnStudio.gtaPath')) {
                    this.install = undefined;
                    this.post({ type: 'reset' });
                }
            }),
        );
    }

    protected title(): string {
        return t('Pawn: GTA assets');
    }

    protected script(): string {
        return 'assets.js';
    }

    open(tab: AssetTab): void {
        this.pendingTab = tab;
        const existed = !!this.panel;
        this.reveal();
        if (existed) this.post({ type: 'tab', tab });
    }

    private gta(): GtaInstall {
        if (!this.install) {
            this.install = gtaInstall();
            this.installDir = this.install.dir;
        }
        return this.install;
    }

    protected async onMessage(m: any): Promise<void> {
        switch (m.type) {
            case 'init': {
                let dir: string | undefined;
                let error: string | undefined;
                try {
                    dir = this.gta().dir;
                } catch (e) {
                    error = (e as Error).message;
                }
                this.post({ type: 'init', tab: this.pendingTab, gtaDir: dir, error });
                return;
            }
            case 'pickGta':
                // the settings listener resets the panel
                await pickGtaFolder();
                return;
            case 'objects': {
                // how often each model is placed on the map (and how often as a far-away LOD)
                const placed = new Map<number, number>();
                const lods = new Map<number, number>();
                for (const pl of this.gta().placements()) {
                    placed.set(pl.id, (placed.get(pl.id) ?? 0) + 1);
                    if (pl.isLod) lods.set(pl.id, (lods.get(pl.id) ?? 0) + 1);
                }
                this.post({
                    type: 'objects',
                    items: this.gta()
                        .objects()
                        .map((o) => [o.id, o.model, o.txd, o.group, Math.round(o.drawDist), o.archive, o.section, placed.get(o.id) ?? 0, lods.get(o.id) ?? 0]),
                });
                return;
            }
            case 'placements': {
                // packed for the map: ids (int32), xyz (float32), flags (bit 0 = LOD, bit 1 = inside an interior)
                const all = this.gta().placements();
                const ids = new Int32Array(all.length);
                const xyz = new Float32Array(all.length * 3);
                const flags = new Uint8Array(all.length);
                const rot = new Float32Array(all.length * 3);
                all.forEach((pl, i) => {
                    rot.set(objectRotation(pl.rot), i * 3);
                    ids[i] = pl.id;
                    xyz[i * 3] = pl.x;
                    xyz[i * 3 + 1] = pl.y;
                    xyz[i * 3 + 2] = pl.z;
                    flags[i] = (pl.isLod ? 1 : 0) | (pl.interior !== 0 && pl.interior !== 13 ? 2 : 0);
                });
                const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
                this.post({ type: 'placements', count: all.length, ids: b64(ids), xyz: b64(xyz), rot: b64(rot), flags: b64(flags) });
                return;
            }
            case 'mapImage':
                this.post({ type: 'mapImage', src: this.gta().mapPng() });
                return;
            case 'model': {
                const o = this.gta().objects().find((x) => x.id === m.id);
                const data = o && this.gta().loadModel(o.model, o.txd);
                this.post({ type: 'model', id: m.id, data });
                return;
            }
            case 'sprites':
                this.post({
                    type: 'sprites',
                    libs: this.gta().sprites().map((l) => ({ name: l.name, textures: l.textures.map((x) => [x.name, x.width, x.height]) })),
                });
                return;
            case 'spriteLib':
                this.post({ type: 'spriteLib', name: m.name, pngs: this.gta().spriteLibraryPngs(m.name) });
                return;
            case 'anims':
                this.post({
                    type: 'anims',
                    libs: this.gta().animationLibraries().map((l) => ({ name: l.name, anims: l.animations.map((a) => a.name) })),
                    skins: this.gta()
                        .skins()
                        .filter((s) => s.model.toLowerCase() !== 'null')
                        .map((s) => [s.id, s.model, s.txd]),
                });
                return;
            case 'animation': {
                const anim = this.gta().animation(m.lib, m.name);
                let ped: LoadedModel | undefined;
                if (m.skin) {
                    const s = this.gta().skins().find((x) => x.id === m.skin);
                    ped = s && this.gta().loadModel(s.model, s.txd);
                }
                this.post({ type: 'animation', lib: m.lib, name: m.name, skin: m.skin, anim, ped });
                return;
            }
            case 'sounds':
                this.post({ type: 'sounds', items: this.gta().sounds().map((s) => [s.id, s.name, s.kind, s.kind === 'play' ? this.gta().soundParts(s.id).map((p) => `${p.bank}:${p.sound}`) : undefined]), hasAudio: !!this.gta().sfx() });
                return;
            case 'soundAudio': {
                // the bank sounds the game plays for this id, as raw PCM the webview turns into an AudioBuffer
                const sfx = this.gta().sfx();
                const parts = sfx
                    ? this.gta()
                          .soundParts(m.id)
                          .map((p) => {
                              const s = sfx.sound(p.bank, p.sound);
                              return s && { rate: s.rate, pan: p.pan, speed: p.speed, bank: p.bank, sound: p.sound, pcm: s.pcm.toString('base64') };
                          })
                          .filter(Boolean)
                    : [];
                this.post({ type: 'soundAudio', id: m.id, parts });
                return;
            }
            case 'banks': {
                const sfx = this.gta().sfx();
                this.post({ type: 'banks', banks: sfx ? sfx.banks().map((b) => [b.bank, BANK_NAMES[b.bank] || `BANK_${b.bank}`, b.pak, b.sounds]) : [] });
                return;
            }
            case 'bankSound': {
                const s = this.gta().sfx()?.sound(m.bank, m.index);
                this.post({ type: 'bankSound', bank: m.bank, index: m.index, part: s && { rate: s.rate, pan: 0, speed: 1, pcm: s.pcm.toString('base64') } });
                return;
            }
            case 'saveWav': {
                const s = this.gta().sfx()?.sound(m.bank, m.index);
                if (!s) return;
                const target = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(os.homedir(), `${m.name || `bank${m.bank}_${m.index}`}.wav`)),
                    filters: { WAV: ['wav'] },
                });
                if (target) await vscode.workspace.fs.writeFile(target, encodeWav(s));
                return;
            }
            case 'insert':
                await this.editors.insert(m.code, !!m.snippet);
                return;
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                vscode.window.setStatusBarMessage(t('$(check) Copied: {0}', String(m.text).slice(0, 60)), 2500);
                return;
        }
    }

    protected strings(): Record<string, string> {
        return {
            objects: t('Objects'),
            sprites: t('Sprites'),
            animations: t('Animations'),
            sounds: t('Sounds'),
            search: t('Search by ID or name…'),
            searchSprites: t('Search sprites… (e.g. ld_beat, chit)'),
            searchAnims: t('Search animations… (e.g. dance, sit, PED)'),
            searchSounds: t('Search sounds by ID or name… (e.g. 1139, checkpoint)'),
            allGroups: t('All groups'),
            results: t('{0} results'),
            showMore: t('Show more'),
            loading: t('Loading…'),
            noGta: t('GTA San Andreas was not found. The asset browser reads models, textures, animations and sounds from your own game installation.'),
            pickGta: t('Select the GTA folder'),
            gtaFrom: t('Reading from {0}'),
            changeGta: t('Change folder'),
            pickItem: t('Select an item on the left'),
            insert: t('Insert'),
            copy: t('Copy'),
            copyId: t('Copy ID'),
            model: t('Model'),
            txd: t('Textures (.txd)'),
            group: t('Group'),
            size: t('Size'),
            library: t('Library'),
            skin: t('Skin'),
            play: t('Play'),
            pause: t('Pause'),
            loop: t('Loop'),
            inPlace: t('In place'),
            speed: t('Speed'),
            duration: t('Duration'),
            noModel: t('This object has no model file in your game.'),
            wireframe: t('Wireframe'),
            resetView: t('Reset view'),
            fSource: t('Source'),
            fSourceAll: t('GTA + SA-MP'),
            fType: t('Type'),
            fTypeAll: t('All types'),
            fTypeStatic: t('Static'),
            fTypeTimed: t('Timed (day/night)'),
            fTypeAnim: t('Animated'),
            fTypeWeapon: t('Weapon'),
            fPlaced: t('On the map'),
            fPlacedAll: t('Placed or not'),
            fPlacedYes: t('Placed on the map'),
            fPlacedNo: t('Not used on the map'),
            fNoLod: t('Hide LODs'),
            fOnlyLod: t('Only LODs'),
            fSort: t('Sort'),
            fSortId: t('Sort by ID'),
            fSortName: t('Sort by name'),
            fSortPlaced: t('Most placed first'),
            fSortDd: t('Largest draw distance first'),
            fDrawDist: t('Draw distance'),
            moreFilters: t('More filters'),
            areaOpen: t('Map area'),
            areaClose: t('Close map'),
            areaHint: t('Drag a rectangle on the map to list every object placed inside it.'),
            areaNone: t('No area selected'),
            areaCount: t('{0} models · {1} objects in the area'),
            areaInfo: t('Area ({0}) → ({1}): {2} objects, {3} models.'),
            areaComment: t('removed area'),
            areaRemoveAll: t('{0} objects'),
            areaRemoveAllBtn: t('Insert RemoveBuildingForPlayer for all ({0})'),
            areaRemoveModel: t('Only this model ({0}× {1})'),
            areaClear: t('Clear area'),
            view3d: t('View in 3D'),
            toolSelect: t('Select an area'),
            toolPan: t('Move the map'),
            mapHint: t('Wheel or the bar on the right: zoom · right-drag or Shift: move · click a dot: details'),
            ...mapStrings(),
            resultsOpen: t('Results on the map'),
            resultsHint: t('Show every place where the objects found by the search and filters are on the map, with their real positions'),
            resultsCount: t('{0} objects · {1} positions'),
            resultsNone: t('No object found by the search is placed on the map. Try another name (pump, atm, door…).'),
            resultsInfo: t('{0} positions of {1} objects. Click an object in the list to see only its positions, or a dot for its code.'),
            resultsModelInfo: t('{0}: {1} positions. Click a row or a dot for the code.'),
            insertPositions: t('Insert the {0} positions (array)'),
            copyPositions: t('Copy the positions'),
            positionsCount: t('{0} positions'),
            fitResults: t('Fit on the map'),
            openBigMap: t('Open on the big map'),
            coords: t('Coordinates'),
            teleport: t('Go there'),
            lodNote: t('far-away LOD version'),
            interiorNote: t('inside an interior'),
            clickToCopy: t('Click to copy'),
            pickedAt: t('Model {0} at {1}'),
            placedTimes: t('{0} times'),
            lodTimes: t('{0} as LOD'),
            notPlaced: t('not used on the map'),
            onMap: t('Where it appears on the map ({0})'),
            removeEverywhere: t('Insert RemoveBuildingForPlayer everywhere ({0})'),
            soundIntro: t('Pick a sound: the 🔊 ones play right here, with the same bank sounds the game uses.'),
            soundsAll: t('All IDs'),
            soundsAudible: t('🔊 Audible'),
            soundsKnown: t('With a known effect'),
            kind_play: t('The game plays these sounds from its resident banks — this is what players hear.'),
            kind_mission: t('Plays from a mission audio bank that a game script has to load first. On a SA-MP server it is usually silent.'),
            kind_track: t('Starts or stops a streamed music track (audio/streams), not a sound effect.'),
            kind_none: t('PlayerPlaySound does nothing audible with this ID (the game only uses it from its own scripts).'),
            noAudio: t('Audio preview needs audio/CONFIG and audio/SFX from your game folder.'),
            soundDuration: t('{0}s'),
            soundFrom: t('Bank sounds: {0}'),
            soundIds: t('PlayerPlaySound IDs'),
            soundBanks: t('All game sounds'),
            soundIdsHint: t('Back to the IDs PlayerPlaySound takes'),
            soundBanksHint: t('Listen to every sound in the game banks (audio/SFX)'),
            searchBanks: t('Search banks… (e.g. genrl, weapons, horn)'),
            soundBanksCount: t('{0} banks · {1} sounds'),
            soundBankNote: t('These are the raw sounds from audio/SFX. Only some of them can be triggered with PlayerPlaySound; the rest are used by the game itself (engines, weapons, speech…).'),
            saveWav: t('Save .wav'),
            usedBy: t('Used by:'),
            volume: t('Volume'),
            stop: t('Stop'),
            textdraw: t('Global TextDraw'),
            playerTextdraw: t('Player TextDraw'),
            spriteHint: t('Sprites need TextDrawFont 4 (TEXT_DRAW_FONT_SPRITE_DRAW) and TextDrawTextSize with the size on screen.'),
            animHint: t('Mouse: drag to rotate, wheel to zoom, right-drag to pan.'),
            object: t('CreateObject'),
            dynamicObject: t('CreateDynamicObject'),
            removeBuilding: t('RemoveBuildingForPlayer'),
            playSound: t('PlayerPlaySound'),
            applyAnimation: t('ApplyAnimation'),
            error: t('Error: {0}'),
        };
    }
}

// ───────────────────────── Dialog Creator ─────────────────────────

export interface DialogPrefill {
    style?: string;
    caption?: string;
    body?: string;
    button1?: string;
    button2?: string;
    name?: string;
    codeStyle?: 'native' | 'easy';
}

export class DialogCreator extends Panel {
    private prefill: DialogPrefill | undefined;

    constructor(ctx: vscode.ExtensionContext, editors: EditorTracker) {
        super(ctx, editors, 'pawnStudio.dialogCreator');
    }

    protected title(): string {
        return t('Pawn: Dialog Creator');
    }

    protected script(): string {
        return 'dialog.js';
    }

    open(prefill?: DialogPrefill): void {
        this.prefill = prefill;
        const existed = !!this.panel;
        this.reveal();
        if (existed && prefill) this.post({ type: 'prefill', prefill });
    }

    protected async onMessage(m: any): Promise<void> {
        switch (m.type) {
            case 'init':
                this.post({ type: 'init', prefill: this.prefill, style: cfg().get<string>('dialogs.codeStyle', 'auto'), detected: await detectDialogStyle() });
                return;
            case 'insert':
                await this.editors.insert(m.code, false);
                return;
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                vscode.window.setStatusBarMessage(t('$(check) Copied: {0}', t('dialog code')), 2500);
                return;
            case 'saveStyle':
                await cfg().update('dialogs.codeStyle', m.style, vscode.ConfigurationTarget.Workspace);
                return;
        }
    }

    protected strings(): Record<string, string> {
        return {
            style: t('Style'),
            caption: t('Title'),
            body: t('Text'),
            items: t('Items (one per line)'),
            columns: t('Columns: separate with Tab or |'),
            header: t('Header (first line)'),
            button1: t('Button 1'),
            button2: t('Button 2 (empty = hidden)'),
            name: t('Dialog name / ID'),
            codeStyle: t('Code'),
            native: t('ShowPlayerDialog (native)'),
            easy: t('easyDialog (Dialog_Show + Dialog:)'),
            handler: t('Generate the response handler'),
            insert: t('Insert in the editor'),
            copy: t('Copy'),
            preview: t('Preview (as in the game)'),
            colors: t('Colors'),
            colorsHint: t('Click a color to insert {RRGGBB} at the cursor. The text keeps that color until the next one.'),
            input: t('player types here'),
            password: t('••••••'),
            selectRow: t('Click a row to see how the selection looks.'),
            generated: t('Generated code'),
            msgbox: t('Message (MSGBOX)'),
            inputStyle: t('Input (INPUT)'),
            list: t('List (LIST)'),
            passwordStyle: t('Password (PASSWORD)'),
            tablist: t('Table (TABLIST)'),
            tablistHeaders: t('Table with header (TABLIST_HEADERS)'),
            maxColumns: t('SA-MP shows at most {0} columns in a table (3 tabs per row): the extra columns are dropped. Rows: {1}.'),
            maxColumnsTab: t('This row already has {0} columns, the most a SA-MP table shows.'),
            longText: t('Text longer than {0} characters: the code builds it with strcat to stay within the line limit.'),
            limit: t('Warning: SA-MP shows at most {0} characters in a dialog ({1} now).'),
            detected: t('detected in the project'),
        };
    }
}

/** Labels for the map zoom bar (media/map.js reads them from window.L10N). */
function mapStrings(): Record<string, string> {
    return { zoomIn: t('Zoom in'), zoomOut: t('Zoom out'), zoom: t('Zoom'), wholeMap: t('Whole map') };
}

/** easyDialog in the project? (Dialog_Show or "Dialog:" handlers in open/visible Pawn files) */
async function detectDialogStyle(): Promise<'easy' | 'native'> {
    try {
        const files = await vscode.workspace.findFiles('**/*.{pwn,inc}', '**/{node_modules,dependencies,.pawn-studio,pawno,qawno}/**', 400);
        let easy = 0;
        let native = 0;
        for (const f of files.slice(0, 400)) {
            const txt = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('latin1');
            easy += (txt.match(/\bDialog_Show\s*\(|^\s*Dialog:\w+\s*\(/gm) ?? []).length;
            native += (txt.match(/\bShowPlayerDialog\s*\(/g) ?? []).length;
            if (easy + native > 50) break;
        }
        return easy > native ? 'easy' : 'native';
    } catch {
        return 'native';
    }
}

// ───────────────────────── attachment editor ─────────────────────────

export interface AttachImport {
    text: string;
    target: 'player' | 'vehicle';
}

/**
 * SetPlayerAttachedObject / AttachObjectToVehicle editor, ported from SA-MP Preview Studio
 * (github.com/devbluen/samp-preview-studio). Models come from the user's GTA SA.
 */
export class AttachEditor extends Panel {
    private pending: AttachImport | undefined;
    private ready = false;
    private names: Record<string, string> | undefined;

    constructor(ctx: vscode.ExtensionContext, editors: EditorTracker) {
        super(ctx, editors, 'pawnStudio.attachEditor');
    }

    protected title(): string {
        return t('Pawn: Attached Objects');
    }

    protected script(): string {
        return 'attach/main.js';
    }

    protected styles(): string[] {
        return ['attach/attach.css'];
    }

    open(code?: AttachImport): void {
        const existed = !!this.panel;
        this.pending = code;
        if (!existed) this.ready = false;
        this.reveal();
        if (existed && this.ready && code) {
            this.post({ type: 'import', ...code });
            this.pending = undefined;
        }
    }

    private friendlyNames(): Record<string, string> {
        if (!this.names) {
            try {
                this.names = JSON.parse(fs.readFileSync(path.join(this.ctx.extensionPath, 'media', 'attach', 'names.json'), 'utf8')) as Record<string, string>;
            } catch {
                this.names = {};
            }
        }
        return this.names;
    }

    protected async onMessage(m: any): Promise<void> {
        switch (m.type) {
            case 'catalog': {
                const gta = gtaInstall();
                this.post({ type: 'catalog', reqId: m.reqId, rows: gta.catalog(this.friendlyNames()), gtaDir: gta.dir });
                return;
            }
            case 'rawModel': {
                const r = gtaInstall().rawModel(m.id);
                const name = this.friendlyNames()[m.id];
                this.post({
                    type: 'rawModel',
                    reqId: m.reqId,
                    model: r && {
                        kind: r.kind,
                        model: r.model,
                        name,
                        origin: r.origin,
                        dff: r.dff.toString('base64'),
                        textures: r.textures.map((x) => [x.name, x.width, x.height, x.rgba.toString('base64')]),
                    },
                });
                return;
            }
            case 'ready':
                this.ready = true;
                if (this.pending) this.post({ type: 'import', ...this.pending });
                this.pending = undefined;
                return;
            case 'insert':
                await this.editors.insert(m.code, false);
                return;
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                return;
        }
    }

    protected strings(): Record<string, string> {
        const bones = [
            t('Spine'), t('Head'), t('Left upper arm'), t('Right upper arm'), t('Left hand'), t('Right hand'),
            t('Left thigh'), t('Right thigh'), t('Left foot'), t('Right foot'), t('Right calf'), t('Left calf'),
            t('Left forearm'), t('Right forearm'), t('Left clavicle'), t('Right clavicle'), t('Neck'), t('Jaw'),
        ];
        return {
            ...Object.fromEntries(bones.map((b, i) => [`bone${i + 1}`, b])),
            loading: t('Loading…'),
            atNotFound: t('Model {0} was not found in your game.'),
            atLoadingSkin: t('Loading the skin…'),
            atLoadingVehicle: t('Loading the vehicle…'),
            atNotSkin: t('Model {0} is not a skin.'),
            atNotVehicle: t('Model {0} is not a vehicle.'),
            atObjects: t('Objects'),
            atClose: t('Close (Esc)'),
            atSearchObjects: t('Search all objects by name or ID…'),
            atBrowserHint: t('Click an object to use it in the selected slot · + adds it as a new slot · ☆ favorite'),
            atNoSlots: t('No objects yet. Click "+ Add", browse or import code.'),
            atAttachTo: t('Attach to'),
            atPlayer: t('Player'),
            atVehicle: t('Vehicle'),
            atPrevSkin: t('Previous skin'),
            atNextSkin: t('Next skin'),
            atSkinId: t('Skin ID'),
            atSearchSkin: t('Search skin by name or ID…'),
            atPrevVehicle: t('Previous vehicle'),
            atNextVehicle: t('Next vehicle'),
            atVehicleId: t('Vehicle model ID'),
            atSearchVehicle: t('Search vehicle by name or ID…'),
            atColors: t('Colors'),
            atColor1: t('Color 1'),
            atColor2: t('Color 2'),
            atAttached: t('Attached Objects'),
            atBrowse: t('Browse'),
            atBrowseHint: t('Browse objects by category, with thumbnails'),
            atAdd: t('Add'),
            atAddHint: t('Add a slot (first free index from 0 to {0})'),
            atSlot: t('Slot'),
            atDuplicate: t('Duplicate'),
            atDuplicateHint: t('Duplicate into the next free index'),
            atRemove: t('Remove'),
            atIndex: t('Index'),
            atBone: t('Bone'),
            atModel: t('Model'),
            atObjectId: t('Object ID'),
            atSearchObject: t('Search object…'),
            atOffset: t('Offset'),
            atRotation: t('Rotation'),
            atScale: t('Scale'),
            atUniform: t('Uniform scale'),
            atMaterialColors: t('Material colors'),
            atOptions: t('Options'),
            atAdvanced: t('advanced'),
            atShowMarker: t('Show the selected bone / vehicle origin'),
            atBindPoseHint: t('The skin is shown in its model pose (arms open), not an in-game animation. The position relative to the bone is the same.'),
            atVehicleOrder: t('Vehicle object rotation order'),
            atOrderZXY: t('ZXY: GTA objects (default)'),
            atOrderXYZ: t('XYZ: same as player attachments'),
            atVehicleOrderHint: t('Objects on vehicles use the game object rotation (CMatrix::SetRotate). If a rotated object does not match the game, compare once and switch the order here.'),
            atMove: t('Move'),
            atRotate: t('Rotate'),
            atScaleMode: t('Scale'),
            atLocal: t('Local'),
            atLocalHint: t('Bone/object axes'),
            atWorld: t('World'),
            atWorldHint: t('World axes'),
            atFront: t('Front'),
            atSide: t('Side'),
            atBack: t('Back'),
            atTop: t('Top'),
            atFocus: t('Focus'),
            atStageHint: t('Drag the object to move it, or use the gizmo to lock an axis · left-drag the background to orbit, right-drag to pan, wheel = zoom'),
            atCode: t('Pawn code'),
            atStreamer: t('Streamer plugin (CreateDynamicObject)'),
            atInsertAll: t('Insert all in the editor'),
            atInsertOne: t('Insert selected'),
            atCopyAll: t('Copy all'),
            atCopyOne: t('Copy selected'),
            atCopied: t('Copied!'),
            atImport: t('Import code'),
            atImportAdd: t('Add to slots'),
            atImportReplace: t('Replace all'),
            atImportHint: t('Tip: with the cursor on SetPlayerAttachedObject or AttachObjectToVehicle lines, run "Pawn: Attached Objects" and they open here.'),
            atImportPlayerPlaceholder: t('Paste one or more SetPlayerAttachedObject(playerid, index, modelid, bone, ...); lines here'),
            atImportVehiclePlaceholder: t('Paste CreateObject / CreateDynamicObject + AttachObjectToVehicle / AttachDynamicObjectToVehicle lines here'),
            atVehicleObject: t('Vehicle object'),
            atNoSlot: t('No slot selected'),
            atSwap: t('swap'),
            atNoObjects: t('no objects'),
            atSlotsFull: t('All {0} slots are in use'),
            atNoPlayerCode: t('No SetPlayerAttachedObject found'),
            atNoVehicleCode: t('No CreateObject + AttachObjectToVehicle found'),
            atImported: t('Imported {0} object(s)'),
            atCatFav: t('Favorites'),
            atCatRecent: t('Recent'),
            atCatHats: t('Hats & caps'),
            atCatHelmets: t('Helmets'),
            atCatGlasses: t('Glasses'),
            atCatMasks: t('Masks & bandanas'),
            atCatHair: t('Hair'),
            atCatWatches: t('Watches'),
            atCatTools: t('Phones & tools'),
            atCatWeapons: t('Weapons'),
            atCatMods: t('Modified'),
            atCatSamp: t('All SA-MP objects'),
            atCatAll: t('All objects'),
            atNoFav: t('No favorites yet: click ☆ on an object to keep it here.'),
            atNoRecent: t('Objects you use show up here.'),
            atNoFound: t('No objects found.'),
            atObjectCount: t('{0} objects'),
            atTileHint: t('Click: use in the selected slot'),
            atFavorite: t('Favorite'),
            atAddSlot: t('Add as a new slot'),
            atCredits: t('Editor from <a href="https://github.com/devbluen/samp-preview-studio">SA-MP Preview Studio</a> by devbluen.'),
        };
    }
}

// ───────────────────────── GangZone Creator ─────────────────────────

/** Rectangles, circles and polygons on the San Andreas map -> GangZoneCreate strips + streamer areas. */
export class GangZoneCreator extends Panel {
    private pendingImport: string | undefined;

    constructor(ctx: vscode.ExtensionContext, editors: EditorTracker) {
        super(ctx, editors, 'pawnStudio.gangZoneCreator');
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (!e.affectsConfiguration('pawnStudio.gtaPath') || !this.panel) return;
                let map: string | undefined;
                try {
                    map = gtaInstall().mapPng();
                } catch {
                    map = undefined;
                }
                this.post({ type: 'map', map });
            }),
        );
    }

    protected title(): string {
        return t('Pawn: GangZone Creator');
    }

    protected script(): string {
        return 'gangzone.js';
    }

    /** @param code gang zone code from the editor (cursor/selection) to open */
    open(code?: string): void {
        const existed = !!this.panel;
        this.pendingImport = code;
        this.reveal();
        if (existed && code) {
            this.post({ type: 'import', text: code });
            this.pendingImport = undefined;
        }
    }

    protected async onMessage(m: any): Promise<void> {
        switch (m.type) {
            case 'init': {
                let map: string | undefined;
                try {
                    map = gtaInstall().mapPng();
                } catch {
                    map = undefined; // no GTA: the map shows a grid
                }
                this.post({ type: 'init', map, import: this.pendingImport });
                this.pendingImport = undefined;
                return;
            }
            case 'pickGta':
                await pickGtaFolder();
                return;
            case 'insert':
                await this.editors.insert(m.code, false);
                return;
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                vscode.window.setStatusBarMessage(t('$(check) Copied: {0}', t('gang zone code')), 2500);
                return;
        }
    }

    protected strings(): Record<string, string> {
        return {
            toolSelect: t('Select'),
            toolRect: t('Rectangle'),
            toolCircle: t('Circle'),
            toolPoly: t('Polygon'),
            toolPan: t('Move map'),
            hintSelect: t('Click a zone to select it and drag it to move. Drag the white points to resize; on a polygon, drag a small point to add a corner and Alt+click a corner to remove it. Delete removes the zone.'),
            hintRect: t('Drag on the map to draw a rectangle.'),
            hintCircle: t('Press on the center and drag to the edge.'),
            hintPoly: t('Click to add each point. Click the first point, double-click or press Enter to close; Backspace undoes a point, Esc cancels.'),
            hintPan: t('Drag to move the map. In any tool, the right button or Shift+drag also moves it.'),
            snap: t('Snap'),
            snapFree: t('Free'),
            goTo: t('Go to'),
            zones: t('Zones'),
            noZones: t('No zones yet: pick Rectangle, Circle or Polygon and draw on the map.'),
            shapeRect: t('Rectangle'),
            shapeCircle: t('Circle'),
            shapePoly: t('Polygon'),
            name: t('Name'),
            color: t('Color'),
            opacity: t('Opacity'),
            minX: t('Min X'),
            minY: t('Min Y'),
            maxX: t('Max X'),
            maxY: t('Max Y'),
            centerX: t('Center X'),
            centerY: t('Center Y'),
            radius: t('Radius'),
            points: t('Points (x, y per line)'),
            pointsHint: t('One point per line: x, y'),
            strips: t('Strips (gang zones used to draw it)'),
            stripsHint: t('More strips follow the shape better but use more of the 1024 gang zones'),
            gangzonesCount: t('{0} gang zones'),
            focus: t('Focus'),
            duplicate: t('Duplicate'),
            del: t('Delete'),
            output: t('Code'),
            outGangzones: t('Gang zones (GangZoneCreate)'),
            outGangzonesHint: t('What the players see on the radar and the map'),
            showPlayer: t('Show per player (Zones_Show(playerid))'),
            showAll: t('Show for everyone (GangZoneShowForAll)'),
            outStreamer: t('Streamer areas (CreateDynamicRectangle / Circle / Polygon)'),
            outStreamerHint: t('Know when a player enters or leaves the exact shape'),
            callbacks: t('Generate OnPlayerEnterDynamicArea / OnPlayerLeaveDynamicArea'),
            total: t('Total: {0} gang zones (limit {1})'),
            overLimit: t('More gang zones than SA-MP allows: use fewer strips or fewer zones.'),
            selfCross: t('The polygon crosses itself: the streamer area and the strips may not match what you see.'),
            insert: t('Insert in the editor'),
            copy: t('Copy'),
            importCode: t('Import code'),
            importBtn: t('Import'),
            importHint: t('Paste GangZoneCreate, CreateDynamicRectangle/Circle/Polygon lines or code from this editor'),
            imported: t('{0} zone(s) imported'),
            nothingImported: t('No gang zone found in the code.'),
            stripsNote: t('SA-MP only draws rectangles as gang zones, so circles and polygons become horizontal strips that do not overlap. The streamer areas follow the exact shape (the dashed line).'),
            codeEmpty: t('// Draw a zone on the map to see the code here.'),
            noMap: t('GTA San Andreas not found: the map has no image.'),
            pickGta: t('Select the GTA folder'),
            zoneDefault: t('Zone'),
            cCreate: t('call in OnGameModeInit'),
            cShow: t('call in OnPlayerSpawn (or OnPlayerConnect)'),
            cShowAll: t('call after Zones_Create'),
            cEnter: t('the player entered'),
            cLeave: t('the player left'),
            mapHint: t('Wheel or the bar on the right: zoom · right button or Shift+drag: move the map'),
            loading: t('Loading…'),
            ...mapStrings(),
        };
    }
}
