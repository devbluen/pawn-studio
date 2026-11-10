/**
 * GTA SA sound effect banks (audio/SFX/*), indexed by audio/CONFIG/PakFiles.dat + BankLkup.dat.
 *
 * BankLkup.dat: one 12-byte entry per bank — pak index (u8, 3 pad bytes), offset (u32), size (u32).
 * A bank starts with a 4804-byte header: sound count (u16, 2 pad bytes) and 400 entries of
 * { offset u32, loop offset i32, sample rate u16, headroom i16 }; the samples follow the header
 * as mono 16-bit little-endian PCM.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveCi } from './ide';

const HEADER = 4 + 400 * 12;

export interface BankInfo {
    bank: number;
    pak: string;
    sounds: number;
}

export interface SfxSound {
    rate: number;
    /** mono 16-bit little-endian PCM */
    pcm: Buffer;
}

interface BankEntry {
    pak: number;
    offset: number;
    size: number;
}

export class SfxBanks {
    private paks: string[] = [];
    private entries: BankEntry[] = [];
    private headers = new Map<number, Array<{ offset: number; rate: number }>>();

    private constructor(private readonly sfxDir: string) {}

    /** undefined when the game has no readable audio config (e.g. a stripped install). */
    static open(gtaDir: string): SfxBanks | undefined {
        const pak = resolveCi(gtaDir, 'audio/CONFIG/PakFiles.dat');
        const lk = resolveCi(gtaDir, 'audio/CONFIG/BankLkup.dat');
        const sfx = resolveCi(gtaDir, 'audio/SFX');
        if (!pak || !lk || !sfx) return undefined;
        const b = new SfxBanks(sfx);
        const p = fs.readFileSync(pak);
        for (let i = 0; i + 52 <= p.length; i += 52) b.paks.push(p.toString('latin1', i, i + 52).split('\0')[0]);
        const l = fs.readFileSync(lk);
        for (let i = 0; i + 12 <= l.length; i += 12) b.entries.push({ pak: l[i], offset: l.readUInt32LE(i + 4), size: l.readUInt32LE(i + 8) });
        return b;
    }

    get count(): number {
        return this.entries.length;
    }

    private file(pak: number): string | undefined {
        const name = this.paks[pak];
        return name ? resolveCi(this.sfxDir, name) ?? path.join(this.sfxDir, name) : undefined;
    }

    private header(bank: number): Array<{ offset: number; rate: number }> {
        let h = this.headers.get(bank);
        if (h) return h;
        h = [];
        const e = this.entries[bank];
        const f = e && this.file(e.pak);
        if (f && fs.existsSync(f)) {
            const buf = Buffer.alloc(HEADER);
            const fd = fs.openSync(f, 'r');
            try {
                fs.readSync(fd, buf, 0, HEADER, e.offset);
            } finally {
                fs.closeSync(fd);
            }
            const n = Math.min(400, buf.readUInt16LE(0));
            for (let i = 0; i < n; i++) h.push({ offset: buf.readUInt32LE(4 + i * 12), rate: buf.readUInt16LE(4 + i * 12 + 8) });
        }
        this.headers.set(bank, h);
        return h;
    }

    banks(): BankInfo[] {
        return this.entries.map((e, bank) => ({ bank, pak: this.paks[e.pak] ?? '?', sounds: this.header(bank).length }));
    }

    sound(bank: number, index: number): SfxSound | undefined {
        const e = this.entries[bank];
        const h = this.header(bank);
        const s = h[index];
        const f = e && this.file(e.pak);
        if (!s || !f) return undefined;
        const end = index + 1 < h.length ? h[index + 1].offset : e.size - HEADER;
        const len = Math.max(0, end - s.offset) & ~1;
        const pcm = Buffer.alloc(len);
        const fd = fs.openSync(f, 'r');
        try {
            fs.readSync(fd, pcm, 0, len, e.offset + HEADER + s.offset);
        } finally {
            fs.closeSync(fd);
        }
        return { rate: s.rate, pcm };
    }
}

/** A playable .wav (used by the "save as .wav" button). */
export function encodeWav(s: SfxSound): Buffer {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'latin1');
    h.writeUInt32LE(36 + s.pcm.length, 4);
    h.write('WAVEfmt ', 8, 'latin1');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(s.rate, 24);
    h.writeUInt32LE(s.rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'latin1');
    h.writeUInt32LE(s.pcm.length, 40);
    return Buffer.concat([h, s.pcm]);
}
