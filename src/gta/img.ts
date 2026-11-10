/**
 * GTA San Andreas IMG archives (version 2, "VER2"): a directory of 2048-byte-sector entries.
 * Reads only the directory up front; entries are read on demand with a single positioned read.
 */
import * as fs from 'fs';

const SECTOR = 2048;

export interface ImgEntry {
    name: string;
    offset: number; // bytes
    size: number; // bytes
}

export class ImgArchive {
    readonly entries: ImgEntry[] = [];
    private byName = new Map<string, ImgEntry>();

    private constructor(readonly file: string) {}

    static open(file: string): ImgArchive {
        const img = new ImgArchive(file);
        const fd = fs.openSync(file, 'r');
        try {
            const head = Buffer.alloc(8);
            fs.readSync(fd, head, 0, 8, 0);
            if (head.toString('latin1', 0, 4) !== 'VER2') throw new Error(`${file}: not a VER2 IMG archive`);
            const count = head.readUInt32LE(4);
            const dir = Buffer.alloc(count * 32);
            fs.readSync(fd, dir, 0, dir.length, 8);
            for (let i = 0; i < count; i++) {
                const o = i * 32;
                const offset = dir.readUInt32LE(o) * SECTOR;
                const streaming = dir.readUInt16LE(o + 4);
                const archived = dir.readUInt16LE(o + 6);
                const raw = dir.toString('latin1', o + 8, o + 32);
                const name = raw.slice(0, raw.indexOf('\0') >= 0 ? raw.indexOf('\0') : 24);
                const e: ImgEntry = { name, offset, size: (archived || streaming) * SECTOR };
                img.entries.push(e);
                img.byName.set(name.toLowerCase(), e);
            }
        } finally {
            fs.closeSync(fd);
        }
        return img;
    }

    has(name: string): boolean {
        return this.byName.has(name.toLowerCase());
    }

    get(name: string): ImgEntry | undefined {
        return this.byName.get(name.toLowerCase());
    }

    read(nameOrEntry: string | ImgEntry): Buffer | undefined {
        const e = typeof nameOrEntry === 'string' ? this.get(nameOrEntry) : nameOrEntry;
        if (!e) return undefined;
        const buf = Buffer.alloc(e.size);
        const fd = fs.openSync(this.file, 'r');
        try {
            fs.readSync(fd, buf, 0, e.size, e.offset);
        } finally {
            fs.closeSync(fd);
        }
        return buf;
    }
}
