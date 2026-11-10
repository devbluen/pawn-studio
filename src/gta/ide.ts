/**
 * Item definitions (.ide): object model IDs, names and texture dictionaries.
 * Builds the object catalog from the game's data/default.dat + data/gta.dat and SA-MP's SAMP.ide.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ObjectDef {
    id: number;
    model: string;
    txd: string;
    drawDist: number;
    /** objs / tobj / anim / weap */
    section: string;
    /** short origin label, e.g. "LA", "SF", "interior", "SA-MP", "weapons" */
    group: string;
    /** "gta" (models/gta3.img) or "samp" (SAMP/SAMP.img) */
    archive: 'gta' | 'samp';
}

const OBJECT_SECTIONS = new Set(['objs', 'tobj', 'anim', 'weap']);

export function parseIde(text: string, group: string, archive: ObjectDef['archive']): ObjectDef[] {
    const out: ObjectDef[] = [];
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (/^[a-z]+$/i.test(line)) {
            section = line.toLowerCase() === 'end' ? '' : line.toLowerCase();
            continue;
        }
        if (!OBJECT_SECTIONS.has(section)) continue;
        const f = line.split(',').map((s) => s.trim());
        const id = parseInt(f[0], 10);
        if (!Number.isFinite(id) || !f[1]) continue;
        // objs: id, model, txd, [meshCount,] drawDist, flags — anim/weap: id, model, txd, animFile, drawDist…
        const nums = f.slice(3).map(Number).filter((n) => Number.isFinite(n));
        out.push({ id, model: f[1], txd: f[2] ?? '', drawDist: nums[section === 'objs' && f.length >= 6 ? 1 : 0] ?? 0, section, group, archive });
    }
    return out;
}

function groupOf(rel: string): string {
    const parts = rel.replace(/\\/g, '/').toLowerCase().split('/');
    const i = parts.indexOf('maps');
    const g = i >= 0 ? parts[i + 1] : parts[parts.length - 1].replace(/\.ide$/, '');
    return ({ la: 'Los Santos', sf: 'San Fierro', vegas: 'Las Venturas', country: 'Countryside', interior: 'Interiors', generic: 'Generic', leveldes: 'Level design', default: 'Weapons & misc' } as Record<string, string>)[g] ?? g;
}

/** Case-insensitive path resolution (the game lists "DATA\MAPS\LA\LAn.IDE"). */
function resolveCi(root: string, rel: string): string | undefined {
    let cur = root;
    for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
        let names: string[];
        try {
            names = fs.readdirSync(cur);
        } catch {
            return undefined;
        }
        const hit = names.find((n) => n.toLowerCase() === part.toLowerCase());
        if (!hit) return undefined;
        cur = path.join(cur, hit);
    }
    return cur;
}

/** Every placeable object of the installation (GTA + SA-MP), sorted by ID. */
export function loadObjectCatalog(gtaDir: string): ObjectDef[] {
    const byId = new Map<number, ObjectDef>();
    const lists: string[] = [];
    for (const dat of ['data/default.dat', 'data/gta.dat']) {
        const f = resolveCi(gtaDir, dat);
        if (!f) continue;
        for (const line of fs.readFileSync(f, 'latin1').split(/\r?\n/)) {
            const m = /^\s*IDE\s+(\S+)/i.exec(line);
            if (m) lists.push(m[1]);
        }
    }
    for (const rel of lists) {
        const f = resolveCi(gtaDir, rel);
        if (!f || /(vehicles|peds|txdcut)\.ide$/i.test(f)) continue;
        for (const d of parseIde(fs.readFileSync(f, 'latin1'), groupOf(rel), 'gta')) byId.set(d.id, d);
    }
    for (const rel of ['SAMP/SAMP.ide', 'SAMP/CUSTOM.ide']) {
        const f = resolveCi(gtaDir, rel);
        if (!f) continue;
        for (const d of parseIde(fs.readFileSync(f, 'latin1'), 'SA-MP', 'samp')) byId.set(d.id, d);
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
}

export interface VehicleDef {
    id: number;
    model: string;
    txd: string;
    /** car, bike, bmx, plane, heli, boat, train, trailer, quad, mtruck */
    type: string;
    /** short game name (GXT key), e.g. LANDSTAL */
    gameName: string;
}

/** data/vehicles.ide "cars" section. */
export function parseVehiclesIde(text: string): VehicleDef[] {
    const out: VehicleDef[] = [];
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (/^[a-z]+$/i.test(line)) {
            section = line.toLowerCase() === 'end' ? '' : line.toLowerCase();
            continue;
        }
        if (section !== 'cars') continue;
        const f = line.split(',').map((x) => x.trim());
        const id = parseInt(f[0], 10);
        if (Number.isFinite(id) && f[1]) out.push({ id, model: f[1], txd: f[2] ?? f[1], type: (f[3] ?? '').toLowerCase(), gameName: f[5] ?? '' });
    }
    return out;
}

/** The IDE files the game loads (data/default.dat + data/gta.dat "IDE" lines). */
export function ideFiles(gtaDir: string): string[] {
    const out: string[] = [];
    for (const dat of ['data/default.dat', 'data/gta.dat']) {
        const f = resolveCi(gtaDir, dat);
        if (!f) continue;
        for (const line of fs.readFileSync(f, 'latin1').split(/\r?\n/)) {
            const m = /^\s*IDE\s+(\S+)/i.exec(line);
            const file = m && resolveCi(gtaDir, m[1]);
            if (file) out.push(file);
        }
    }
    return out;
}

/** "txdp" sections: a texture dictionary that borrows missing textures from a parent one (lowercase names). */
export function loadTxdParents(gtaDir: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const file of ideFiles(gtaDir)) {
        let section = '';
        for (const raw of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
            const line = raw.replace(/#.*$/, '').trim();
            if (!line) continue;
            if (/^[a-z]+$/i.test(line)) {
                section = line.toLowerCase() === 'end' ? '' : line.toLowerCase();
                continue;
            }
            if (section !== 'txdp') continue;
            const [child, parent] = line.split(',').map((x) => x.trim().toLowerCase());
            if (child && parent) out.set(child, parent);
        }
    }
    return out;
}

export { resolveCi };
