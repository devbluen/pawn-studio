/**
 * Texture dictionaries (.txd): lists textures and decodes them to RGBA.
 * Supports the PC formats used by GTA SA (platform 9) and GTA III/VC (platform 8):
 * DXT1/3/5, 8888, 888, 1555, 565, 4444, LUM8 and 8/4-bit palettes.
 */
import { child, children, cstring, readChunk, RW } from './rw';

export interface TextureInfo {
    name: string;
    width: number;
    height: number;
    format: string;
    hasAlpha: boolean;
}

export interface Texture extends TextureInfo {
    /** width*height*4 bytes, RGBA */
    rgba: Buffer;
}

const FOURCC: Record<number, string> = { 0x31545844: 'DXT1', 0x33545844: 'DXT3', 0x35545844: 'DXT5' };

interface RawTexture extends TextureInfo {
    raster: number;
    d3d: number;
    depth: number;
    palette?: Buffer;
    data: Buffer;
}

function parseNative(buf: Buffer, native: { start: number; end: number; type: number; size: number; version: number }): RawTexture | undefined {
    const st = child(buf, native, RW.STRUCT);
    if (!st) return undefined;
    let p = st.start;
    const platform = buf.readUInt32LE(p);
    p += 8; // platform + filter/addressing
    const name = cstring(buf, p, 32);
    p += 64; // name + mask name
    const raster = buf.readUInt32LE(p);
    p += 4;
    const d3dOrAlpha = buf.readUInt32LE(p);
    p += 4;
    const width = buf.readUInt16LE(p);
    const height = buf.readUInt16LE(p + 2);
    const depth = buf[p + 4];
    const flags = buf[p + 7];
    p += 8;
    let d3d = 0;
    let hasAlpha: boolean;
    if (platform === 9) {
        d3d = d3dOrAlpha;
        hasAlpha = (flags & 1) !== 0;
    } else if (platform === 8) {
        hasAlpha = d3dOrAlpha !== 0;
        const compression = flags; // GTA III/VC: 0 none, 1 DXT1, 3 DXT3
        if (compression === 1) d3d = 0x31545844;
        else if (compression === 3) d3d = 0x33545844;
    } else return undefined;
    let palette: Buffer | undefined;
    if (raster & 0x2000) {
        palette = buf.subarray(p, p + 1024);
        p += 1024;
    } else if (raster & 0x4000) {
        palette = buf.subarray(p, p + 64);
        p += 64;
    }
    const size = buf.readUInt32LE(p);
    const data = buf.subarray(p + 4, Math.min(p + 4 + size, st.end));
    const format = FOURCC[d3d] ?? (palette ? `PAL${raster & 0x2000 ? 8 : 4}` : RASTER_NAMES[raster & 0xf00] ?? `0x${raster.toString(16)}`);
    return { name, width, height, format, hasAlpha, raster, d3d, depth, palette, data };
}

const RASTER_NAMES: Record<number, string> = { 0x100: '1555', 0x200: '565', 0x300: '4444', 0x400: 'LUM8', 0x500: '8888', 0x600: '888', 0xa00: '555' };

function natives(buf: Buffer): RawTexture[] {
    const root = readChunk(buf, 0);
    if (root.type !== RW.TEXTURE_DICTIONARY) throw new Error('not a texture dictionary');
    const out: RawTexture[] = [];
    for (const c of children(buf, root)) {
        if (c.type !== RW.TEXTURE_NATIVE) continue;
        const t = parseNative(buf, c);
        if (t) out.push(t);
    }
    return out;
}

/** Texture names/sizes without decoding pixels. */
export function listTextures(buf: Buffer): TextureInfo[] {
    return natives(buf).map(({ name, width, height, format, hasAlpha }) => ({ name, width, height, format, hasAlpha }));
}

export function readTextures(buf: Buffer, only?: string): Texture[] {
    return natives(buf)
        .filter((t) => !only || t.name.toLowerCase() === only.toLowerCase())
        .map((t) => ({ name: t.name, width: t.width, height: t.height, format: t.format, hasAlpha: t.hasAlpha, rgba: decode(t) }));
}

// ───────────────────────── pixel decoders ─────────────────────────

function decode(t: RawTexture): Buffer {
    const { width: w, height: h, data } = t;
    const out = Buffer.alloc(w * h * 4);
    const fmt = t.format;
    if (fmt === 'DXT1' || fmt === 'DXT3' || fmt === 'DXT5') {
        decodeDXT(data, w, h, fmt, out, t.hasAlpha);
        return out;
    }
    if (t.palette) {
        const pal = t.palette;
        const four = fmt === 'PAL4';
        for (let i = 0; i < w * h; i++) {
            const idx = four ? (data[i >> 1] >> ((i & 1) * 4)) & 0xf : data[i];
            pal.copy(out, i * 4, idx * 4, idx * 4 + 4);
            if (!t.hasAlpha) out[i * 4 + 3] = 255;
        }
        return out;
    }
    const raster = t.raster & 0xf00;
    for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        if (raster === 0x500 || raster === 0x600) {
            // stored B, G, R, A
            out[o] = data[i * 4 + 2];
            out[o + 1] = data[i * 4 + 1];
            out[o + 2] = data[i * 4];
            out[o + 3] = raster === 0x500 && t.hasAlpha ? data[i * 4 + 3] : 255;
        } else if (raster === 0x100 || raster === 0xa00) {
            const v = data.readUInt16LE(i * 2);
            out[o] = ((v >> 10) & 31) * 255 / 31;
            out[o + 1] = ((v >> 5) & 31) * 255 / 31;
            out[o + 2] = (v & 31) * 255 / 31;
            out[o + 3] = raster === 0x100 ? (v & 0x8000 ? 255 : 0) : 255;
        } else if (raster === 0x200) {
            const v = data.readUInt16LE(i * 2);
            out[o] = ((v >> 11) & 31) * 255 / 31;
            out[o + 1] = ((v >> 5) & 63) * 255 / 63;
            out[o + 2] = (v & 31) * 255 / 31;
            out[o + 3] = 255;
        } else if (raster === 0x300) {
            const v = data.readUInt16LE(i * 2);
            out[o] = ((v >> 8) & 15) * 17;
            out[o + 1] = ((v >> 4) & 15) * 17;
            out[o + 2] = (v & 15) * 17;
            out[o + 3] = ((v >> 12) & 15) * 17;
        } else if (raster === 0x400) {
            out[o] = out[o + 1] = out[o + 2] = data[i];
            out[o + 3] = 255;
        }
    }
    return out;
}

function rgb565(v: number): [number, number, number] {
    return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
}

function decodeDXT(data: Buffer, w: number, h: number, fmt: string, out: Buffer, hasAlpha: boolean): void {
    const blockSize = fmt === 'DXT1' ? 8 : 16;
    const bw = Math.max(1, Math.ceil(w / 4));
    const bh = Math.max(1, Math.ceil(h / 4));
    const colors = new Array<number[]>(4);
    const alphas = new Array<number>(8);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            let p = (by * bw + bx) * blockSize;
            if (p + blockSize > data.length) return;
            let alphaBits: bigint | undefined;
            let explicit: Buffer | undefined;
            if (fmt === 'DXT3') {
                explicit = data.subarray(p, p + 8);
                p += 8;
            } else if (fmt === 'DXT5') {
                const a0 = data[p];
                const a1 = data[p + 1];
                alphas[0] = a0;
                alphas[1] = a1;
                if (a0 > a1) for (let i = 1; i < 7; i++) alphas[i + 1] = ((7 - i) * a0 + i * a1) / 7;
                else {
                    for (let i = 1; i < 5; i++) alphas[i + 1] = ((5 - i) * a0 + i * a1) / 5;
                    alphas[6] = 0;
                    alphas[7] = 255;
                }
                alphaBits = 0n;
                for (let i = 0; i < 6; i++) alphaBits |= BigInt(data[p + 2 + i]) << BigInt(8 * i);
                p += 8;
            }
            const c0 = data.readUInt16LE(p);
            const c1 = data.readUInt16LE(p + 2);
            const bits = data.readUInt32LE(p + 4);
            const a = rgb565(c0);
            const b = rgb565(c1);
            colors[0] = [...a, 255];
            colors[1] = [...b, 255];
            if (c0 > c1 || fmt !== 'DXT1') {
                colors[2] = [(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3, 255];
                colors[3] = [(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3, 255];
            } else {
                colors[2] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 255];
                colors[3] = [0, 0, 0, hasAlpha ? 0 : 255];
            }
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= w || y >= h) continue;
                    const k = py * 4 + px;
                    const c = colors[(bits >>> (2 * k)) & 3];
                    const o = (y * w + x) * 4;
                    out[o] = c[0];
                    out[o + 1] = c[1];
                    out[o + 2] = c[2];
                    if (explicit) out[o + 3] = ((explicit[k >> 1] >> ((k & 1) * 4)) & 15) * 17;
                    else if (alphaBits !== undefined) out[o + 3] = alphas[Number((alphaBits >> BigInt(3 * k)) & 7n)];
                    else out[o + 3] = c[3];
                }
            }
        }
    }
}
