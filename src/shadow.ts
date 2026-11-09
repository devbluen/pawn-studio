/**
 * Shadow copy of the project in a temp folder, so pawncc can compile text that has not been
 * saved yet. Only copies what changed (compares mtime/size), so after the first time syncing
 * costs a few milliseconds.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathKey } from './includeGraph';

const IS_WIN = process.platform === 'win32';

function under(file: string, dir: string): boolean {
    const f = pathKey(file);
    const d = pathKey(dir);
    return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** Deepest folder shared by the paths (undefined if they are on different drives). */
export function commonAncestor(paths: string[]): string | undefined {
    if (!paths.length) return undefined;
    const split = (p: string) => path.resolve(p).split(/[\\/]/);
    let common = split(paths[0]);
    for (const p of paths.slice(1)) {
        const parts = split(p);
        let i = 0;
        while (i < common.length && i < parts.length && (IS_WIN ? common[i].toLowerCase() === parts[i].toLowerCase() : common[i] === parts[i])) i++;
        common = common.slice(0, i);
        if (!common.length) return undefined;
    }
    const joined = common.join(path.sep);
    return IS_WIN && /^[A-Za-z]:$/.test(joined) ? joined + path.sep : joined || path.sep;
}

export class ShadowTree {
    readonly base: string;
    private copied = new Map<string, { mtimeMs: number; size: number }>();
    private overlaid = new Map<string, string>(); // key → written content

    constructor(readonly root: string) {
        const hash = crypto.createHash('md5').update(pathKey(root)).digest('hex').slice(0, 10);
        this.base = path.join(os.tmpdir(), 'pawn-studio', 'shadow-' + hash);
    }

    contains(file: string): boolean {
        return under(file, this.root);
    }

    map(file: string): string {
        return path.join(this.base, path.relative(this.root, path.resolve(file)));
    }

    unmap(file: string): string {
        return under(file, this.base) ? path.join(this.root, path.relative(this.base, path.resolve(file))) : file;
    }

    /**
     * Mirrors `files` (only those inside root) and writes the unsaved content from
     * `overlays` (real path → text) on top.
     */
    sync(files: Iterable<string>, overlays: Map<string, string>): { copied: number; written: number } {
        let copied = 0;
        let written = 0;
        const overlayKeys = new Map<string, string>();
        for (const [f, txt] of overlays) if (this.contains(f)) overlayKeys.set(pathKey(f), txt);

        const seen = new Set<string>();
        const handle = (file: string) => {
            if (!this.contains(file)) return;
            const k = pathKey(file);
            if (seen.has(k)) return;
            seen.add(k);
            const dest = this.map(file);
            const overlay = overlayKeys.get(k);
            if (overlay !== undefined) {
                if (this.overlaid.get(k) !== overlay) {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.writeFileSync(dest, overlay, 'utf8');
                    this.overlaid.set(k, overlay);
                    this.copied.delete(k);
                    written++;
                }
                return;
            }
            let st: fs.Stats;
            try {
                st = fs.statSync(file);
            } catch {
                return;
            }
            const prev = this.copied.get(k);
            if (!this.overlaid.has(k) && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(file, dest);
            this.copied.set(k, { mtimeMs: st.mtimeMs, size: st.size });
            this.overlaid.delete(k);
            copied++;
        };
        for (const f of files) handle(f);
        for (const f of overlays.keys()) handle(f);
        return { copied, written };
    }
}
