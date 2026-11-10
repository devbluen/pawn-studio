/**
 * Item placements (.ipl): where every map object stands. Text IPLs come from data/gta.dat ("IPL ..."),
 * the binary "stream" IPLs (lan_stream0.ipl…) live inside models/gta3.img.
 *
 * Binary layout: "bnry", 6 counts (int32: inst, unused×3, cars, unused), then 6 (offset, 0) int32 pairs;
 * an instance is 40 bytes: pos xyz (float), rotation quaternion xyzw (float), model id, interior, lod (int32).
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveCi } from './ide';
import { ImgArchive } from './img';

export interface Placement {
    id: number;
    x: number;
    y: number;
    z: number;
    interior: number;
    /** rotation quaternion as written in the file (x, y, z, w) */
    rot: [number, number, number, number];
    /** true for the low-detail stand-ins the game draws from far away */
    isLod: boolean;
}

/** inst lines: id, model, interior, x, y, z, rx, ry, rz, rw, lod */
export function parseTextIpl(text: string, out: Placement[] = [], onLod?: (index: number) => void): Placement[] {
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (/^[a-z]+$/i.test(line)) {
            section = line.toLowerCase() === 'end' ? '' : line.toLowerCase();
            continue;
        }
        if (section !== 'inst') continue;
        const f = line.split(',').map((s) => s.trim());
        if (f.length < 10) continue;
        const n = f.map(Number);
        if (!Number.isFinite(n[0]) || !Number.isFinite(n[3])) continue;
        out.push({ id: n[0], x: n[3], y: n[4], z: n[5], interior: n[2] || 0, rot: [n[6], n[7], n[8], n[9]], isLod: false });
        if (onLod && n[10] >= 0) onLod(n[10]);
    }
    return out;
}

export function parseBinaryIpl(buf: Buffer, out: Placement[] = [], onLod?: (index: number) => void): Placement[] {
    if (buf.length < 76 || buf.toString('latin1', 0, 4) !== 'bnry') return out;
    const count = buf.readInt32LE(4);
    const offset = buf.readInt32LE(28);
    for (let i = 0; i < count; i++) {
        const o = offset + i * 40;
        if (o + 40 > buf.length) break;
        out.push({
            x: buf.readFloatLE(o),
            y: buf.readFloatLE(o + 4),
            z: buf.readFloatLE(o + 8),
            rot: [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20), buf.readFloatLE(o + 24)],
            id: buf.readInt32LE(o + 28),
            interior: buf.readInt32LE(o + 32) & 0xff,
            isLod: false,
        });
        const lod = buf.readInt32LE(o + 36);
        if (onLod && lod >= 0) onLod(lod);
    }
    return out;
}

/** Every placement of the map. LOD instances are flagged through the text IPLs' lod indexes. */
export function loadPlacements(gtaDir: string, gta3?: ImgArchive): Placement[] {
    const out: Placement[] = [];
    const lods = new Set<number>();
    /** text IPL base name (lowercase) -> index of its first instance in `out` */
    const starts = new Map<string, number>();
    const f = resolveCi(gtaDir, 'data/gta.dat');
    for (const line of f ? fs.readFileSync(f, 'latin1').split(/\r?\n/) : []) {
        const m = /^\s*IPL\s+(\S+)/i.exec(line);
        const file = m && resolveCi(gtaDir, m[1]);
        if (!file) continue;
        const start = out.length;
        starts.set(path.basename(file).toLowerCase().replace(/\.ipl$/, ''), start);
        parseTextIpl(fs.readFileSync(file, 'latin1'), out, (lod) => lods.add(start + lod));
    }
    if (gta3) {
        for (const e of gta3.entries) {
            if (!/\.ipl$/i.test(e.name)) continue;
            const b = gta3.read(e);
            // lan_stream3.ipl points its LODs at instances of lan.ipl
            const start = starts.get(e.name.toLowerCase().replace(/_stream\d+\.ipl$/, ''));
            if (b) parseBinaryIpl(b, out, start === undefined ? undefined : (lod) => lods.add(start + lod));
        }
    }
    for (const i of lods) if (out[i]) out[i].isLod = true;
    return out;
}

/**
 * IPL rotation quaternion -> CreateObject rotX/rotY/rotZ in degrees.
 * RenderWare stores the inverse rotation (the quaternion is conjugated), and GTA objects build their
 * matrix as Rz * Rx * Ry (CMatrix::SetRotate), so the angles are decomposed in that order.
 */
export function objectRotation(rot: [number, number, number, number]): [number, number, number] {
    let [x, y, z, w] = rot;
    const n = Math.hypot(x, y, z, w) || 1;
    x = -x / n;
    y = -y / n;
    z = -z / n;
    w = w / n;
    const m11 = 1 - 2 * (y * y + z * z);
    const m12 = 2 * (x * y - z * w);
    const m21 = 2 * (x * y + z * w);
    const m22 = 1 - 2 * (x * x + z * z);
    const m31 = 2 * (x * z - y * w);
    const m32 = 2 * (y * z + x * w);
    const m33 = 1 - 2 * (x * x + y * y);
    const deg = (r: number) => {
        let d = (r * 180) / Math.PI;
        d = Math.round(d * 1000) / 1000;
        return d === 0 ? 0 : d; // no -0
    };
    const rx = Math.asin(Math.max(-1, Math.min(1, m32)));
    if (Math.abs(m32) < 0.9999999) return [deg(rx), deg(Math.atan2(-m31, m33)), deg(Math.atan2(-m12, m22))];
    return [deg(rx), 0, deg(Math.atan2(m21, m11))];
}
