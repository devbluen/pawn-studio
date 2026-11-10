/**
 * Custom models a server adds (SA-MP 0.3.DL / open.mp): AddCharModel (skins, ids 20001+) and
 * AddSimpleModel / AddSimpleModelTimed (objects, negative ids), declared in models/artconfig.txt or
 * in the gamemode's own code. The .dff/.txd files live in the server's models/ folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseDff } from './dff';
import { readTextures, Texture } from './txd';

export interface CustomModel {
    kind: 'skin' | 'object';
    id: number;
    baseId: number;
    dff: string; // absolute path
    txd: string; // absolute path
    /** where it was declared (artconfig.txt or a .pwn file) */
    source: string;
}

const CALL = /\b(AddCharModel|AddSimpleModel|AddSimpleModelTimed)\s*\(([^;]*?)\)\s*;?/g;

/** Every AddCharModel / AddSimpleModel with literal ids and file names in a text. */
export function parseCustomModels(text: string, modelsDir: string, source: string): CustomModel[] {
    const out: CustomModel[] = [];
    for (const m of text.matchAll(CALL)) {
        // args: AddCharModel(baseid, newid, "dff", "txd") · AddSimpleModel(vw, baseid, newid, "dff", "txd"[, on, off])
        const args = m[2].split(',').map((s) => s.trim());
        const skin = m[1] === 'AddCharModel';
        const off = skin ? 0 : 1;
        const baseId = Number(args[off]);
        const id = Number(args[off + 1]);
        const str = (s: string | undefined) => /^"([^"]+)"$/.exec(s ?? '')?.[1];
        const dff = str(args[off + 2]);
        const txd = str(args[off + 3]);
        if (!Number.isInteger(id) || !dff || !txd) continue;
        out.push({ kind: skin ? 'skin' : 'object', id, baseId: Number.isInteger(baseId) ? baseId : 0, dff: path.resolve(modelsDir, dff), txd: path.resolve(modelsDir, txd), source });
    }
    return out;
}

/** Custom models of a server: models/artconfig.txt first, then the given Pawn files. */
export function findCustomModels(serverDir: string, pawnFiles: string[] = []): CustomModel[] {
    const modelsDir = path.join(serverDir, 'models');
    const byId = new Map<number, CustomModel>();
    const add = (list: CustomModel[]) => {
        for (const c of list) if (!byId.has(c.id) && fs.existsSync(c.dff)) byId.set(c.id, c);
    };
    const art = path.join(modelsDir, 'artconfig.txt');
    if (fs.existsSync(art)) add(parseCustomModels(fs.readFileSync(art, 'latin1'), modelsDir, 'models/artconfig.txt'));
    for (const f of pawnFiles) {
        let txt: string;
        try {
            txt = fs.readFileSync(f, 'latin1');
        } catch {
            continue;
        }
        if (!/Add(CharModel|SimpleModel)/.test(txt)) continue;
        add(parseCustomModels(txt, modelsDir, path.relative(serverDir, f).split(path.sep).join('/')));
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** DFF bytes + the textures its materials use, from the loose files of a custom model. */
export function readCustomModel(c: CustomModel): { dff: Buffer; textures: Texture[] } | undefined {
    let dff: Buffer;
    try {
        dff = fs.readFileSync(c.dff);
    } catch {
        return undefined;
    }
    let textures: Texture[] = [];
    try {
        textures = fs.existsSync(c.txd) ? readTextures(fs.readFileSync(c.txd)) : [];
    } catch {
        textures = [];
    }
    try {
        const wanted = new Set(parseDff(dff).materials.map((m) => m.texture?.toLowerCase()).filter(Boolean) as string[]);
        if (wanted.size) textures = textures.filter((t) => wanted.has(t.name.toLowerCase()));
    } catch {
        /* keep every texture */
    }
    return { dff, textures };
}
