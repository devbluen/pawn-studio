/**
 * .zip and .tar.gz extraction without external dependencies (Node's zlib only).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { t } from '../i18n';

export interface ArchiveEntry {
    /** Path inside the archive, always with "/". */
    name: string;
    isDir: boolean;
    data: () => Buffer;
}

export function isZip(buf: Buffer): boolean {
    return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

export function isGzip(buf: Buffer): boolean {
    return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function readZip(buf: Buffer): ArchiveEntry[] {
    // Find the "End of central directory" record (signature 0x06054b50), scanning backwards.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error(t('Invalid zip (EOCD not found)'));
    let count = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // ZIP64 (very large archives) — rare here, but the basics are supported.
    if (cdOffset === 0xffffffff || count === 0xffff) {
        const loc = eocd - 20;
        if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
            const z64 = Number(buf.readBigUInt64LE(loc + 8));
            count = Number(buf.readBigUInt64LE(z64 + 32));
            cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
    }

    const entries: ArchiveEntry[] = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(t('Invalid zip (corrupted central directory)'));
        const method = buf.readUInt16LE(p + 10);
        let compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        let localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
        // ZIP64 extra field
        if (compSize === 0xffffffff || localOffset === 0xffffffff) {
            let e = p + 46 + nameLen;
            const end = e + extraLen;
            while (e + 4 <= end) {
                const id = buf.readUInt16LE(e);
                const size = buf.readUInt16LE(e + 2);
                if (id === 0x0001) {
                    let q = e + 4;
                    if (buf.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed
                    if (compSize === 0xffffffff) {
                        compSize = Number(buf.readBigUInt64LE(q));
                        q += 8;
                    }
                    if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q));
                }
                e += 4 + size;
            }
        }
        p += 46 + nameLen + extraLen + commentLen;

        const lo = localOffset;
        entries.push({
            name,
            isDir: name.endsWith('/'),
            data: () => {
                const lNameLen = buf.readUInt16LE(lo + 26);
                const lExtraLen = buf.readUInt16LE(lo + 28);
                const start = lo + 30 + lNameLen + lExtraLen;
                const raw = buf.subarray(start, start + compSize);
                if (method === 0) return Buffer.from(raw);
                if (method === 8) return zlib.inflateRawSync(raw);
                throw new Error(t('Unsupported compression method {0} ({1})', method, name));
            },
        });
    }
    return entries;
}

export function readTarGz(buf: Buffer): ArchiveEntry[] {
    return readTar(isGzip(buf) ? zlib.gunzipSync(buf) : buf);
}

export function readTar(tar: Buffer): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    let p = 0;
    let longName: string | undefined;
    let paxPath: string | undefined;
    while (p + 512 <= tar.length) {
        const header = tar.subarray(p, p + 512);
        if (header.every((b) => b === 0)) break;
        const str = (o: number, l: number) => {
            const s = header.subarray(o, o + l);
            const z = s.indexOf(0);
            return s.toString('utf8', 0, z < 0 ? l : z);
        };
        let name = str(0, 100);
        const prefix = str(345, 155);
        if (prefix) name = prefix + '/' + name;
        const size = parseInt(str(124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        const dataStart = p + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        p = dataStart + Math.ceil(size / 512) * 512;

        if (type === 'L') {
            longName = data.toString('utf8').replace(/\0+$/, '');
            continue;
        }
        if (type === 'x') {
            const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
            if (m) paxPath = m[1];
            continue;
        }
        if (type === 'g') continue;
        if (longName) name = longName;
        if (paxPath) name = paxPath;
        longName = paxPath = undefined;
        if (type !== '0' && type !== '5' && type !== '\0' && type !== '7') continue; // skip links etc.
        const copy = Buffer.from(data);
        entries.push({ name, isDir: type === '5' || name.endsWith('/'), data: () => copy });
    }
    return entries;
}

export function readArchive(buf: Buffer): ArchiveEntry[] {
    if (isZip(buf)) return readZip(buf);
    return readTarGz(buf);
}

/** Strips the first path component if *all* entries share the same root folder. */
export function stripCommonRoot(entries: ArchiveEntry[]): ArchiveEntry[] {
    const firsts = new Set(entries.map((e) => e.name.split('/')[0]));
    if (firsts.size !== 1 || entries.every((e) => !e.name.includes('/'))) return entries;
    return entries
        .map((e) => ({ ...e, name: e.name.split('/').slice(1).join('/') }))
        .filter((e) => e.name !== '');
}

function safeJoin(root: string, name: string): string {
    const target = path.resolve(root, name);
    const r = path.resolve(root);
    if (target !== r && !target.startsWith(r + path.sep)) throw new Error(t('Unsafe path in archive: {0}', name));
    return target;
}

/** Extracts the entries into `dest`. Returns the files written. */
export function extractTo(entries: ArchiveEntry[], dest: string): string[] {
    const written: string[] = [];
    fs.mkdirSync(dest, { recursive: true });
    for (const e of entries) {
        const target = safeJoin(dest, e.name);
        if (e.isDir) {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, e.data());
        written.push(target);
    }
    return written;
}
