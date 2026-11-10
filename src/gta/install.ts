/**
 * Locates the GTA San Andreas installation and serves its assets (catalogs, models, textures).
 * Everything is read from the user's own game files and cached in memory.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DffModel, parseDff } from './dff';
import { loadObjectCatalog, loadTxdParents, ObjectDef, parseVehiclesIde, resolveCi, VehicleDef } from './ide';
import { parseIfp, AnimPackage, Animation } from './ifp';
import { ImgArchive } from './img';
import { loadPlacements, Placement } from './ipl';
import { encodePng } from './png';
import { SfxBanks } from './sfx';
import { SOUND_MAP } from './soundMap';
import { listTextures, readTextures, Texture, TextureInfo } from './txd';

export function isGtaDir(dir: string | undefined): dir is string {
    return !!dir && fs.existsSync(path.join(dir, 'gta_sa.exe')) && !!resolveCi(dir, 'models/gta3.img');
}

/** Setting → SA-MP registry key → common install folders. */
export function findGtaDir(configured?: string): string | undefined {
    if (configured) {
        const d = /\.exe$/i.test(configured) ? path.dirname(configured) : configured;
        return isGtaDir(d) ? d : undefined;
    }
    if (process.platform === 'win32') {
        try {
            const out = cp.execFileSync('reg', ['query', 'HKCU\\Software\\SAMP', '/v', 'gta_sa_exe'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
            const m = /gta_sa_exe\s+REG_SZ\s+(.+)/i.exec(out);
            if (m && isGtaDir(path.dirname(m[1].trim()))) return path.dirname(m[1].trim());
        } catch {
            /* no SA-MP key */
        }
        const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Games', 'D:\\Games'].filter(Boolean) as string[];
        const names = ['Rockstar Games\\GTA San Andreas', 'GTA San Andreas', 'Steam\\steamapps\\common\\Grand Theft Auto San Andreas', 'GTA SA'];
        for (const base of pf) for (const n of names) if (isGtaDir(path.join(base, n))) return path.join(base, n);
    }
    return undefined;
}

export interface SpriteLibrary {
    /** name used in TextDraw strings, e.g. "ld_beat" */
    name: string;
    file: string;
    textures: TextureInfo[];
}

export interface AnimLibrary {
    name: string;
    animations: Array<{ name: string; duration: number }>;
}

export interface SoundEvent {
    id: number;
    name: string;
    /** what the game does for it: plays bank sounds, needs a mission bank, a music track, or nothing known */
    kind: 'play' | 'mission' | 'track' | 'none';
}

export interface SkinDef {
    id: number;
    model: string;
    txd: string;
}

/** One row of the attachment editor catalog: [id, model, name, kind] — kind 's' skin, 'v' vehicle, 'o' object. */
export type CatalogRow = [number, string, string, 's' | 'v' | 'o'];

/** A model as raw RenderWare data, for the attachment editor (it builds the meshes itself). */
export interface RawModel {
    id: number;
    kind: 'skin' | 'vehicle' | 'object';
    model: string;
    origin: string;
    dff: Buffer;
    /** every texture of the model's TXD chain (own TXD, its txdp parents, vehicle.txd for vehicles) */
    textures: Texture[];
}

export interface LoadedModel {
    model: DffModel;
    /** texture name (lowercase) → PNG data URI */
    textures: Record<string, string>;
}

/** Loose .dff/.txd files of a folder tree (modloader), read like an IMG archive by file name. */
export class LooseFolder {
    private byName = new Map<string, string>();

    constructor(readonly file: string) {
        const walk = (dir: string, depth: number) => {
            let items: fs.Dirent[];
            try {
                items = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
            } catch {
                return;
            }
            for (const it of items) {
                const abs = path.join(dir, it.name);
                // modloader ignores folders starting with "." (disabled mods)
                if (it.isDirectory()) {
                    if (depth < 8 && !it.name.startsWith('.')) walk(abs, depth + 1);
                } else if (/\.(dff|txd)$/i.test(it.name) && !this.byName.has(it.name.toLowerCase())) this.byName.set(it.name.toLowerCase(), abs);
            }
        };
        walk(file, 0);
    }

    get size(): number {
        return this.byName.size;
    }

    has(name: string): boolean {
        return this.byName.has(name.toLowerCase());
    }

    read(name: string): Buffer | undefined {
        const f = this.byName.get(name.toLowerCase());
        if (!f) return undefined;
        try {
            return fs.readFileSync(f);
        } catch {
            return undefined;
        }
    }
}

type AssetSource = ImgArchive | LooseFolder;

export class GtaInstall {
    private imgs?: AssetSource[];
    private _objects?: ObjectDef[];
    private _sprites?: SpriteLibrary[];
    private _anims?: Map<string, { load: () => AnimPackage; summary: AnimLibrary }>;
    private _sounds?: SoundEvent[];
    private _skins?: SkinDef[];
    private _sfx?: SfxBanks | null;
    private _placements?: Placement[];
    private _vehicles?: VehicleDef[];
    private _txdParents?: Map<string, string>;
    private txdCache = new Map<string, Texture[]>();
    private _map?: string;
    private pngCache = new Map<string, string>();

    constructor(readonly dir: string) {}

    /**
     * Where models are read from, in the game's priority: modloader/ (loose files, like the
     * modloader.asi mod), the extra IMGs listed in data/gta.dat, then the stock archives.
     */
    private archives(): AssetSource[] {
        if (!this.imgs) {
            const out: AssetSource[] = [];
            const ml = resolveCi(this.dir, 'modloader');
            if (ml && fs.statSync(ml).isDirectory()) {
                const loose = new LooseFolder(ml);
                if (loose.size) out.push(loose);
            }
            const stock = ['SAMP/SAMP.img', 'SAMP/custom.img', 'models/gta3.img', 'models/gta_int.img', 'models/player.img'];
            // IMG lines of gta.dat added by mods (skins.img…); the stock ones are already in the list
            const extra: string[] = [];
            const dat = resolveCi(this.dir, 'data/gta.dat');
            if (dat) {
                for (const m of fs.readFileSync(dat, 'latin1').matchAll(/^\s*IMG\s+(\S+)/gim)) {
                    const rel = m[1].replace(/\\/g, '/');
                    if (!/\/(carrec|script|cutscene)\.img$/i.test(rel) && !stock.some((s) => s.toLowerCase() === rel.toLowerCase())) extra.push(rel);
                }
            }
            for (const rel of [...extra, ...stock]) {
                const f = resolveCi(this.dir, rel);
                if (!f) continue;
                try {
                    out.push(ImgArchive.open(f));
                } catch {
                    /* unreadable archive */
                }
            }
            this.imgs = out;
        }
        return this.imgs;
    }

    /** Where a model file comes from (archive or modloader path), for the UI. */
    sourceOf(name: string): string | undefined {
        return this.archiveOf(name);
    }

    private readAsset(name: string): Buffer | undefined {
        for (const a of this.archives()) {
            const b = a.read(name);
            if (b) return b;
        }
        return undefined;
    }

    objects(): ObjectDef[] {
        return (this._objects ??= loadObjectCatalog(this.dir));
    }

    /** data/vehicles.ide */
    vehicles(): VehicleDef[] {
        if (!this._vehicles) {
            const f = resolveCi(this.dir, 'data/vehicles.ide');
            this._vehicles = f ? parseVehiclesIde(fs.readFileSync(f, 'latin1')) : [];
        }
        return this._vehicles;
    }

    /** Skins, vehicles and objects for the attachment editor; `names` gives friendly names by id. */
    catalog(names: Record<string, string> = {}): CatalogRow[] {
        const rows = new Map<number, CatalogRow>();
        for (const s of this.skins()) if (s.model.toLowerCase() !== 'null') rows.set(s.id, [s.id, s.model.toLowerCase(), names[s.id] ?? '', 's']);
        for (const v of this.vehicles()) rows.set(v.id, [v.id, v.model.toLowerCase(), names[v.id] ?? v.gameName, 'v']);
        for (const o of this.objects()) if (!rows.has(o.id)) rows.set(o.id, [o.id, o.model.toLowerCase(), names[o.id] ?? '', 'o']);
        return [...rows.values()].sort((a, b) => a[0] - b[0]);
    }

    private archiveOf(name: string): string | undefined {
        const a = this.archives().find((x) => x.has(name));
        if (!a) return undefined;
        return a instanceof LooseFolder ? `modloader · ${name}` : path.basename(a.file);
    }

    private txd(name: string): Texture[] {
        const key = name.toLowerCase();
        let t = this.txdCache.get(key);
        if (t) return t;
        let buf = this.readAsset(`${key}.txd`);
        // vehicle.txd (shared vehicle textures) is a loose file
        if (!buf && key === 'vehicle') {
            const f = resolveCi(this.dir, 'models/generic/vehicle.txd');
            if (f) buf = fs.readFileSync(f);
        }
        try {
            t = buf ? readTextures(buf) : [];
        } catch {
            t = [];
        }
        if (this.txdCache.size > 48) this.txdCache.delete(this.txdCache.keys().next().value!);
        this.txdCache.set(key, t);
        return t;
    }

    /** DFF bytes + decoded textures of a skin, vehicle or object. */
    rawModel(id: number): RawModel | undefined {
        const skin = this.skins().find((s) => s.id === id && s.model.toLowerCase() !== 'null');
        const veh = !skin ? this.vehicles().find((v) => v.id === id) : undefined;
        const obj = !skin && !veh ? this.objects().find((o) => o.id === id) : undefined;
        const def = skin ?? veh ?? obj;
        if (!def) return undefined;
        const kind = skin ? 'skin' : veh ? 'vehicle' : 'object';
        const dff = this.readAsset(`${def.model}.dff`);
        if (!dff) return undefined;
        this._txdParents ??= loadTxdParents(this.dir);
        const chain: string[] = [];
        for (let t: string | undefined = def.txd.toLowerCase(); t && !chain.includes(t); t = this._txdParents.get(t)) chain.push(t);
        if (kind === 'vehicle') chain.push('vehicle');
        // only the textures the model's materials use (SA-MP's TXDs hold dozens of objects)
        let wanted: Set<string> | undefined;
        try {
            wanted = new Set(parseDff(dff).materials.map((m) => m.texture?.toLowerCase()).filter(Boolean) as string[]);
        } catch {
            wanted = undefined;
        }
        const seen = new Set<string>();
        const textures: Texture[] = [];
        for (const name of chain) {
            for (const tex of this.txd(name)) {
                const k = tex.name.toLowerCase();
                if (seen.has(k) || (wanted && !wanted.has(k))) continue;
                seen.add(k);
                textures.push(tex);
            }
        }
        return { id, kind, model: def.model, origin: this.archiveOf(`${def.model}.dff`) ?? '', dff, textures };
    }

    /** Where every map object stands (text IPLs + the binary stream IPLs in gta3.img). */
    placements(): Placement[] {
        if (!this._placements) {
            const f = resolveCi(this.dir, 'models/gta3.img');
            this._placements = loadPlacements(this.dir, this.archives().find((a): a is ImgArchive => a instanceof ImgArchive && a.file === f));
        }
        return this._placements;
    }

    /**
     * The San Andreas map as one PNG, stitched from the radar tiles (radar00..radar143.txd, 12×12 tiles of 128 px)
     * — the same image the in-game map uses. Covers world -3000..3000 on both axes, north up.
     */
    mapPng(tile = 128): string | undefined {
        if (this._map) return this._map;
        const n = 12;
        const size = n * tile;
        const rgba = Buffer.alloc(size * size * 4);
        let found = 0;
        for (let i = 0; i < n * n; i++) {
            const buf = this.readAsset(`radar${String(i).padStart(2, '0')}.txd`);
            if (!buf) continue;
            let tex;
            try {
                tex = readTextures(buf)[0];
            } catch {
                continue;
            }
            if (!tex) continue;
            found++;
            const ox = (i % n) * tile;
            const oy = Math.floor(i / n) * tile;
            for (let y = 0; y < tile; y++) {
                const sy = Math.floor((y * tex.height) / tile);
                for (let x = 0; x < tile; x++) {
                    const sx = Math.floor((x * tex.width) / tile);
                    const s4 = (sy * tex.width + sx) * 4;
                    const d4 = ((oy + y) * size + ox + x) * 4;
                    rgba[d4] = tex.rgba[s4];
                    rgba[d4 + 1] = tex.rgba[s4 + 1];
                    rgba[d4 + 2] = tex.rgba[s4 + 2];
                    rgba[d4 + 3] = 255;
                }
            }
        }
        if (!found) return undefined;
        this._map = `data:image/png;base64,${encodePng(size, size, rgba).toString('base64')}`;
        return this._map;
    }

    /** TextDraw sprite libraries: every .txd in models/txd. */
    sprites(): SpriteLibrary[] {
        if (!this._sprites) {
            const dir = resolveCi(this.dir, 'models/txd');
            const out: SpriteLibrary[] = [];
            for (const f of dir ? fs.readdirSync(dir) : []) {
                if (!/\.txd$/i.test(f)) continue;
                try {
                    const textures = listTextures(fs.readFileSync(path.join(dir!, f)));
                    out.push({ name: f.replace(/\.txd$/i, '').toLowerCase(), file: path.join(dir!, f), textures });
                } catch {
                    /* not a texture dictionary */
                }
            }
            this._sprites = out.sort((a, b) => a.name.localeCompare(b.name));
        }
        return this._sprites;
    }

    /** PNG data URI of a sprite ("ld_beat", "chit"). */
    spritePng(library: string, texture: string): string | undefined {
        const key = `s:${library}:${texture}`.toLowerCase();
        if (this.pngCache.has(key)) return this.pngCache.get(key);
        const lib = this.sprites().find((l) => l.name === library.toLowerCase());
        if (!lib) return undefined;
        const t = readTextures(fs.readFileSync(lib.file), texture)[0];
        if (!t) return undefined;
        const uri = `data:image/png;base64,${encodePng(t.width, t.height, t.rgba).toString('base64')}`;
        this.pngCache.set(key, uri);
        return uri;
    }

    /** All PNGs of one sprite library at once (the grid shows them together). */
    spriteLibraryPngs(library: string): Record<string, string> {
        const lib = this.sprites().find((l) => l.name === library.toLowerCase());
        const out: Record<string, string> = {};
        if (!lib) return out;
        for (const t of readTextures(fs.readFileSync(lib.file))) {
            const key = `s:${lib.name}:${t.name}`.toLowerCase();
            let uri = this.pngCache.get(key);
            if (!uri) {
                uri = `data:image/png;base64,${encodePng(t.width, t.height, t.rgba).toString('base64')}`;
                this.pngCache.set(key, uri);
            }
            out[t.name] = uri;
        }
        return out;
    }

    private animIndex(): Map<string, { load: () => AnimPackage; summary: AnimLibrary }> {
        if (!this._anims) {
            const idx = new Map<string, { load: () => AnimPackage; summary: AnimLibrary }>();
            const add = (read: () => Buffer) => {
                const pkg = parseIfp(read(), false);
                const summary: AnimLibrary = { name: pkg.name.toUpperCase(), animations: pkg.animations.map((a) => ({ name: a.name, duration: 0 })) };
                idx.set(summary.name, { load: () => parseIfp(read()), summary });
            };
            const ped = resolveCi(this.dir, 'anim/ped.ifp');
            if (ped) add(() => fs.readFileSync(ped));
            const animImg = resolveCi(this.dir, 'anim/anim.img');
            if (animImg) {
                const img = ImgArchive.open(animImg);
                for (const e of img.entries) {
                    if (!/\.ifp$/i.test(e.name)) continue;
                    try {
                        add(() => img.read(e)!);
                    } catch {
                        /* skip broken package */
                    }
                }
            }
            this._anims = idx;
        }
        return this._anims;
    }

    animationLibraries(): AnimLibrary[] {
        return [...this.animIndex().values()].map((v) => v.summary).sort((a, b) => a.name.localeCompare(b.name));
    }

    animation(library: string, name: string): Animation | undefined {
        const lib = this.animIndex().get(library.toUpperCase());
        return lib?.load().animations.find((a) => a.name.toLowerCase() === name.toLowerCase());
    }

    /** data/AudioEvents.txt: the IDs PlayerPlaySound takes, with the game's own names. */
    sounds(): SoundEvent[] {
        if (!this._sounds) {
            const f = resolveCi(this.dir, 'data/AudioEvents.txt');
            const out: SoundEvent[] = [];
            for (const line of f ? fs.readFileSync(f, 'latin1').split(/\r?\n/) : []) {
                const m = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
                if (!m) continue;
                const id = parseInt(m[2], 10);
                const e = SOUND_MAP[id];
                out.push({ id, name: m[1], kind: Array.isArray(e) ? 'play' : e === 'mission' || e === 'track' ? e : 'none' });
            }
            this._sounds = out.sort((a, b) => a.id - b.id);
        }
        return this._sounds;
    }

    /** The game's sound effect banks; undefined when audio/CONFIG is missing. */
    sfx(): SfxBanks | undefined {
        if (this._sfx === undefined) this._sfx = SfxBanks.open(this.dir) ?? null;
        return this._sfx ?? undefined;
    }

    /** The bank sounds the game plays for a PlayerPlaySound id. */
    soundParts(id: number): Array<{ bank: number; sound: number; pan: number; speed: number }> {
        const e = SOUND_MAP[id];
        return Array.isArray(e) ? e.map(([bank, sound, pan, speed]) => ({ bank, sound, pan, speed })) : [];
    }

    /** Ped skins (peds.ide + SA-MP skins), for the animation preview. */
    skins(): SkinDef[] {
        if (!this._skins) {
            const out: SkinDef[] = [];
            // peds of mods in modloader/ (new skin ids) come after the stock ones; a repeated id is replaced
            const ml = resolveCi(this.dir, 'modloader');
            const modIdes: string[] = [];
            const walk = (d: string, depth: number) => {
                try {
                    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
                        if (it.isDirectory() && depth < 8 && !it.name.startsWith('.')) walk(path.join(d, it.name), depth + 1);
                        else if (/\.ide$/i.test(it.name)) modIdes.push(path.join(d, it.name));
                    }
                } catch {
                    /* unreadable */
                }
            };
            if (ml) walk(ml, 0);
            for (const rel of ['data/peds.ide', 'SAMP/SAMP.ide', ...modIdes]) {
                const f = path.isAbsolute(rel) ? rel : resolveCi(this.dir, rel);
                if (!f) continue;
                let section = '';
                for (const raw of fs.readFileSync(f, 'latin1').split(/\r?\n/)) {
                    const line = raw.replace(/#.*$/, '').trim();
                    if (/^[a-z]+$/i.test(line)) {
                        section = line.toLowerCase();
                        continue;
                    }
                    if (section !== 'peds') continue;
                    const p = line.split(',').map((s) => s.trim());
                    if (p.length > 2 && /^\d+$/.test(p[0])) {
                        // a mod that redefines an id replaces it
                        const i = out.findIndex((x) => x.id === +p[0]);
                        if (i >= 0) out.splice(i, 1);
                        out.push({ id: +p[0], model: p[1], txd: p[2] });
                    }
                }
            }
            this._skins = out;
        }
        return this._skins;
    }

    /** Model + its textures as PNG data URIs (textures come from the model's own .txd). */
    loadModel(model: string, txd: string): LoadedModel | undefined {
        const dff = this.readAsset(`${model}.dff`);
        if (!dff) return undefined;
        const parsed = parseDff(dff);
        const textures: Record<string, string> = {};
        const wanted = new Set(parsed.materials.map((m) => m.texture?.toLowerCase()).filter(Boolean) as string[]);
        const txdBuf = this.readAsset(`${txd}.txd`);
        if (txdBuf && wanted.size) {
            try {
                for (const t of readTextures(txdBuf)) {
                    const k = t.name.toLowerCase();
                    if (!wanted.has(k)) continue;
                    textures[k] = `data:image/png;base64,${encodePng(t.width, t.height, t.rgba).toString('base64')}`;
                }
            } catch {
                /* untextured preview */
            }
        }
        return { model: parsed, textures };
    }
}
