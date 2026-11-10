/**
 * RenderWare clumps (.dff): frames (with HAnim bone IDs), geometry, materials and skin weights.
 * Output is plain arrays so it can be posted to a webview and turned into three.js objects there.
 */
import { child, children, Chunk, cstring, readChunk, RW } from './rw';

export interface DffFrame {
    name: string;
    parent: number;
    /** column-major 4x4 local transform (three.js Matrix4.fromArray order) */
    matrix: number[];
    boneId?: number;
}

export interface DffMaterial {
    color: [number, number, number, number];
    texture?: string;
}

export interface DffMesh {
    frame: number;
    positions: number[];
    normals?: number[];
    uvs?: number[];
    colors?: number[]; // prelit RGBA 0..1
    groups: Array<{ material: number; indices: number[] }>;
    skin?: {
        indices: number[]; // 4 per vertex (index into the skin's bone list)
        weights: number[]; // 4 per vertex
        inverseBind: number[][]; // per bone, column-major 4x4
    };
}

export interface DffModel {
    frames: DffFrame[];
    meshes: DffMesh[];
    materials: DffMaterial[];
    /** HAnim hierarchy: skin bone i ↔ nodes[i].id (matches IFP bone IDs) */
    hanim?: Array<{ id: number; index: number; type: number }>;
}

const FLAG_TRISTRIP = 0x01;
const FLAG_PRELIT = 0x08;
const FLAG_TEXTURED = 0x04;
const FLAG_TEXTURED2 = 0x80;
const FLAG_NATIVE = 0x01000000;

function readFrames(buf: Buffer, list: Chunk): { frames: DffFrame[]; hanim?: DffModel['hanim'] } {
    const st = child(buf, list, RW.STRUCT)!;
    const n = buf.readInt32LE(st.start);
    const frames: DffFrame[] = [];
    let p = st.start + 4;
    for (let i = 0; i < n; i++) {
        const f = (k: number) => buf.readFloatLE(p + k * 4);
        // RW stores right, up, at (rows of the rotation) + position
        const m = [f(0), f(1), f(2), 0, f(3), f(4), f(5), 0, f(6), f(7), f(8), 0, f(9), f(10), f(11), 1];
        frames.push({ name: '', parent: buf.readInt32LE(p + 48), matrix: m });
        p += 56;
    }
    let hanim: DffModel['hanim'];
    const exts = children(buf, list).filter((c) => c.type === RW.EXTENSION);
    exts.forEach((ext, i) => {
        if (!frames[i]) return;
        for (const c of children(buf, ext)) {
            if (c.type === RW.FRAME) frames[i].name = buf.toString('latin1', c.start, c.end).replace(/\0.*$/, '');
            else if (c.type === RW.HANIM) {
                frames[i].boneId = buf.readInt32LE(c.start + 4);
                const numBones = buf.readInt32LE(c.start + 8);
                if (numBones > 0) {
                    hanim = [];
                    let q = c.start + 20;
                    for (let b = 0; b < numBones; b++, q += 12) {
                        hanim.push({ id: buf.readInt32LE(q), index: buf.readInt32LE(q + 4), type: buf.readInt32LE(q + 8) });
                    }
                }
            }
        }
    });
    return { frames, hanim };
}

function readMaterials(buf: Buffer, list: Chunk, out: DffMaterial[]): number[] {
    const st = child(buf, list, RW.STRUCT)!;
    const n = buf.readInt32LE(st.start);
    const refs: number[] = [];
    for (let i = 0; i < n; i++) refs.push(buf.readInt32LE(st.start + 4 + i * 4));
    const mats = children(buf, list).filter((c) => c.type === RW.MATERIAL);
    const local: number[] = [];
    let mi = 0;
    for (let i = 0; i < n; i++) {
        if (refs[i] >= 0) {
            local.push(local[refs[i]]);
            continue;
        }
        const m = mats[mi++];
        const ms = m && child(buf, m, RW.STRUCT);
        const mat: DffMaterial = { color: [1, 1, 1, 1] };
        if (ms) {
            mat.color = [buf[ms.start + 4] / 255, buf[ms.start + 5] / 255, buf[ms.start + 6] / 255, buf[ms.start + 7] / 255];
            const tex = child(buf, m, RW.TEXTURE);
            if (tex) {
                const name = children(buf, tex).find((c) => c.type === RW.STRING);
                if (name) mat.texture = cstring(buf, name.start, name.size);
            }
        }
        out.push(mat);
        local.push(out.length - 1);
    }
    return local;
}

function readGeometry(buf: Buffer, g: Chunk, materials: DffMaterial[]): Omit<DffMesh, 'frame'> | undefined {
    const st = child(buf, g, RW.STRUCT)!;
    let p = st.start;
    const format = buf.readUInt32LE(p);
    const numTris = buf.readInt32LE(p + 4);
    const numVerts = buf.readInt32LE(p + 8);
    const numMorph = buf.readInt32LE(p + 12);
    p += 16;
    if (st.version < 0x34000 && (st.version & 0xffff0000) !== 0) p += 12; // old surface properties
    if (format & FLAG_NATIVE) return undefined;
    let colors: number[] | undefined;
    if (format & FLAG_PRELIT) {
        colors = [];
        for (let i = 0; i < numVerts * 4; i++) colors.push(buf[p + i] / 255);
        p += numVerts * 4;
    }
    const numUV = (format >> 16) & 0xff || (format & FLAG_TEXTURED2 ? 2 : format & FLAG_TEXTURED ? 1 : 0);
    let uvs: number[] | undefined;
    for (let s = 0; s < numUV; s++) {
        if (s === 0) {
            uvs = [];
            for (let i = 0; i < numVerts * 2; i++) uvs.push(buf.readFloatLE(p + i * 4));
        }
        p += numVerts * 8;
    }
    // each triangle: v1, v0, materialId, v2 (u16) — as librw reads it (two u32: v0<<16|v1, v2<<16|mat)
    const tris: Array<[number, number, number, number]> = [];
    for (let i = 0; i < numTris; i++, p += 8) {
        tris.push([buf.readUInt16LE(p + 2), buf.readUInt16LE(p), buf.readUInt16LE(p + 6), buf.readUInt16LE(p + 4)]);
    }
    let positions: number[] = [];
    let normals: number[] | undefined;
    for (let m = 0; m < Math.max(1, numMorph); m++) {
        p += 16; // bounding sphere
        const hasV = buf.readInt32LE(p);
        const hasN = buf.readInt32LE(p + 4);
        p += 8;
        if (hasV) {
            if (m === 0) for (let i = 0; i < numVerts * 3; i++) positions.push(buf.readFloatLE(p + i * 4));
            p += numVerts * 12;
        }
        if (hasN) {
            if (m === 0) {
                normals = [];
                for (let i = 0; i < numVerts * 3; i++) normals.push(buf.readFloatLE(p + i * 4));
            }
            p += numVerts * 12;
        }
    }
    const matList = child(buf, g, RW.MATERIAL_LIST);
    const local = matList ? readMaterials(buf, matList, materials) : [];
    const byMat = new Map<number, number[]>();
    for (const [a, b, c, mat] of tris) {
        const idx = local[mat] ?? 0;
        if (!byMat.has(idx)) byMat.set(idx, []);
        byMat.get(idx)!.push(a, b, c);
    }
    void FLAG_TRISTRIP;
    const mesh: Omit<DffMesh, 'frame'> = {
        positions,
        normals,
        uvs,
        colors,
        groups: [...byMat.entries()].map(([material, indices]) => ({ material, indices })),
    };
    const ext = child(buf, g, RW.EXTENSION);
    const skin = ext && child(buf, ext, RW.SKIN);
    if (skin) {
        let q = skin.start;
        const numBones = buf[q];
        const numUsed = buf[q + 1];
        const maxWeights = buf[q + 2];
        q += 4 + numUsed;
        const indices: number[] = [];
        for (let i = 0; i < numVerts * 4; i++) indices.push(buf[q + i]);
        q += numVerts * 4;
        const weights: number[] = [];
        for (let i = 0; i < numVerts * 4; i++) weights.push(buf.readFloatLE(q + i * 4));
        q += numVerts * 16;
        const inverseBind: number[][] = [];
        for (let b = 0; b < numBones; b++) {
            if (maxWeights === 0) q += 4;
            const m: number[] = [];
            for (let k = 0; k < 16; k++) m.push(buf.readFloatLE(q + k * 4));
            m[3] = m[7] = m[11] = 0;
            m[15] = 1;
            inverseBind.push(m);
            q += 64;
        }
        mesh.skin = { indices, weights, inverseBind };
    }
    positions = mesh.positions;
    return mesh;
}

export function parseDff(buf: Buffer): DffModel {
    let clump = readChunk(buf, 0);
    // some files carry leading UV-anim dictionaries etc.
    let at = 0;
    while (clump.type !== RW.CLUMP && clump.end < buf.length) {
        at = clump.start + clump.size;
        clump = readChunk(buf, at);
    }
    if (clump.type !== RW.CLUMP) throw new Error('not a RenderWare clump');
    const parts = children(buf, clump);
    const fl = parts.find((c) => c.type === RW.FRAME_LIST);
    const gl = parts.find((c) => c.type === RW.GEOMETRY_LIST);
    if (!fl || !gl) throw new Error('clump without frames or geometry');
    const { frames, hanim } = readFrames(buf, fl);
    const materials: DffMaterial[] = [];
    const geoms = children(buf, gl)
        .filter((c) => c.type === RW.GEOMETRY)
        .map((g) => {
            try {
                return readGeometry(buf, g, materials);
            } catch {
                return undefined;
            }
        });
    const all: DffMesh[] = [];
    for (const a of parts.filter((c) => c.type === RW.ATOMIC)) {
        const st = child(buf, a, RW.STRUCT)!;
        const frame = buf.readInt32LE(st.start);
        const geo = geoms[buf.readInt32LE(st.start + 4)];
        if (geo) all.push({ frame, ...geo });
    }
    // drop damaged / very-low-detail duplicates, but only when the intact version is present
    const isAlt = (m: DffMesh) => /_(dam|vlo)$/i.test(frames[m.frame]?.name ?? '');
    const meshes = all.some((m) => !isAlt(m)) ? all.filter((m) => !isAlt(m)) : all;
    return { frames, meshes, materials, hanim };
}
