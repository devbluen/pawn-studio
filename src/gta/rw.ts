/**
 * RenderWare binary stream chunks (used by .dff models and .txd texture dictionaries).
 * Every chunk: type (u32), size (u32), library version (u32), then `size` bytes of payload.
 */

export const RW = {
    STRUCT: 0x01,
    STRING: 0x02,
    EXTENSION: 0x03,
    TEXTURE: 0x06,
    MATERIAL: 0x07,
    MATERIAL_LIST: 0x08,
    FRAME_LIST: 0x0e,
    GEOMETRY: 0x0f,
    CLUMP: 0x10,
    ATOMIC: 0x14,
    TEXTURE_NATIVE: 0x15,
    TEXTURE_DICTIONARY: 0x16,
    GEOMETRY_LIST: 0x1a,
    SKIN: 0x116,
    HANIM: 0x11e,
    BIN_MESH: 0x50e,
    FRAME: 0x253f2fe,
} as const;

export interface Chunk {
    type: number;
    size: number;
    version: number;
    /** payload start (absolute offset in the buffer) */
    start: number;
    end: number;
}

export function readChunk(buf: Buffer, at: number): Chunk {
    if (at + 12 > buf.length) throw new Error(`RenderWare chunk header out of bounds at ${at}`);
    const type = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    const version = buf.readUInt32LE(at + 8);
    const start = at + 12;
    return { type, size, version, start, end: Math.min(start + size, buf.length) };
}

/** Children of a container chunk (payload made of chunks). */
export function children(buf: Buffer, parent: Chunk): Chunk[] {
    const out: Chunk[] = [];
    let p = parent.start;
    while (p + 12 <= parent.end) {
        const c = readChunk(buf, p);
        out.push(c);
        p = c.start + c.size;
    }
    return out;
}

export function child(buf: Buffer, parent: Chunk, type: number): Chunk | undefined {
    return children(buf, parent).find((c) => c.type === type);
}

export function cstring(buf: Buffer, start: number, max: number): string {
    const end = Math.min(start + max, buf.length);
    let i = start;
    while (i < end && buf[i] !== 0) i++;
    return buf.toString('latin1', start, i);
}
