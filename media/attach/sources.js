// Model source for the attachment editor inside VS Code: the extension reads the player's GTA SA
// installation (src/gta) and sends raw DFF bytes + decoded textures. Same interface as the
// SA-MP Preview Studio sources.js (resolve(id) -> { info, dff, textures }), so models.js is unchanged.
import { request } from './bridge.js';

export const isSampObject = (id) => id >= 18631 && id <= 19999;
export const kindOf = (id) => (id >= 0 && id <= 311 ? 'skin' : id >= 400 && id <= 611 ? 'vehicle' : 'object');

const bytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

class Sources extends EventTarget {
    constructor() {
        super();
        this.game = true; // models always come from the user's game here
        this.modCount = 0;
        this.generation = 1;
        this.variant = 'modified';
        this.catalog = [];
        this.cache = new Map(); // id -> Promise<found>
    }

    async init() {
        const res = await request('catalog');
        this.catalog = res.rows;
        this.gtaDir = res.gtaDir;
    }

    resolve(id) {
        let p = this.cache.get(id);
        if (!p) {
            p = request('rawModel', { id }).then((res) => {
                if (!res.model) throw new Error(window.L10N.atNotFound.replace('{0}', id));
                const m = res.model;
                const textures = new Map(m.textures.map(([name, width, height, rgba]) => [name.toLowerCase(), { width, height, rgba: bytes(rgba) }]));
                const dff = bytes(m.dff);
                return {
                    info: { id, kind: m.kind, model: m.model, name: m.name || m.model, source: 'local', origin: m.origin, modified: false, textures: 'rgba' },
                    dff: dff.buffer,
                    textures: async () => textures,
                };
            });
            p.catch(() => this.cache.delete(id));
            if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(id, p);
        }
        return p;
    }
}

export const sources = new Sources();
