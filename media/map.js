// San Andreas map: the game's radar image with zoom/pan, area selection and object placements as dots.
// World -3000..3000 on both axes, north up (image y grows southwards).

const WORLD = 3000;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

export class MapView {
    /**
     * @param {HTMLElement} container
     * @param {string} src map image (data URI)
     * @param {{ tool?: string, onSelect?: (rect) => void, onPick?: (world) => void,
     *   interact?: { down?: (w, e) => boolean, move?: (w, e) => void, up?: (w, e) => void, dblclick?: (w, e) => void, hover?: (w) => void },
     *   overlay?: (ctx, view) => void, zoomBar?: boolean, labels?: object }} opts
     *   interact.down returning true takes the pointer (drawing tools); overlay paints on top of the dots.
     */
    constructor(container, src, opts = {}) {
        this.container = container;
        this.opts = opts;
        this.tool = opts.tool ?? 'pan';
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'map-canvas';
        container.append(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        this.img = new Image();
        this.img.onload = () => {
            if (!this.fitted) this.fit();
            this.draw();
        };
        if (src) this.img.src = src;
        /** world units per screen pixel and the world point at the canvas center */
        this.scale = 6000 / 600;
        this.cx = 0;
        this.cy = 0;
        this.layers = [];
        this.selection = null;
        this.marker = null;
        this.hover = null;
        this.bind();
        if (opts.zoomBar !== false) this.zoomBar();
        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(container);
        this.resize();
    }

    dispose() {
        this.ro.disconnect();
        this.canvas.remove();
        this.bar?.remove();
    }

    /** + / slider / − on the right: zooming without a mouse wheel. */
    zoomBar() {
        const L = this.opts.labels ?? window.L10N ?? {};
        const mk = (tag, text, title) => {
            const e = document.createElement(tag);
            if (tag === 'button') e.className = 'secondary';
            if (text) e.textContent = text;
            if (title) e.title = title;
            return e;
        };
        const bar = mk('div');
        bar.className = 'map-zoom';
        const plus = mk('button', '+', L.zoomIn ?? 'Zoom in');
        const minus = mk('button', '−', L.zoomOut ?? 'Zoom out');
        const fit = mk('button', '⤢', L.wholeMap ?? 'Whole map');
        const slider = mk('input', '', L.zoom ?? 'Zoom');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '1000';
        plus.onclick = () => this.zoomBy(1 / 1.6);
        minus.onclick = () => this.zoomBy(1.6);
        fit.onclick = () => this.fit();
        slider.oninput = () => {
            // 0 = whole map, 1000 = closest; logarithmic so every step feels the same
            const t = +slider.value / 1000;
            this.zoomTo(Math.exp(Math.log(MAX_SCALE) + (Math.log(MIN_SCALE) - Math.log(MAX_SCALE)) * t));
        };
        for (const e of [plus, minus, fit, slider]) e.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        bar.append(plus, slider, minus, fit);
        this.container.append(bar);
        this.bar = bar;
        this.slider = slider;
    }

    syncSlider() {
        if (!this.slider || document.activeElement === this.slider) return;
        const t = (Math.log(this.scale) - Math.log(MAX_SCALE)) / (Math.log(MIN_SCALE) - Math.log(MAX_SCALE));
        this.slider.value = String(Math.round(Math.min(1, Math.max(0, t)) * 1000));
    }

    /** Zoom keeping a screen point (default: the center) fixed. */
    zoomTo(scale, sx = this.w / 2, sy = this.h / 2) {
        const [wx, wy] = this.toWorld(sx, sy);
        this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
        const [nx, ny] = this.toScreen(wx, wy);
        this.cx += (nx - sx) * this.scale;
        this.cy -= (ny - sy) * this.scale;
        this.draw();
    }

    zoomBy(f, sx, sy) {
        this.zoomTo(this.scale * f, sx, sy);
    }

    /** Centers the view on a world point (optionally at a given zoom). */
    centerOn(x, y, scale) {
        this.cx = x;
        this.cy = y;
        if (scale) this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
        this.draw();
    }

    resize() {
        const r = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.w = Math.max(50, r.width);
        this.h = Math.max(50, r.height);
        this.canvas.width = this.w * dpr;
        this.canvas.height = this.h * dpr;
        this.canvas.style.width = `${this.w}px`;
        this.canvas.style.height = `${this.h}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!this.fitted && this.img.complete) this.fit();
        this.draw();
    }

    /** Shows the whole map, or a world box with some margin. */
    fit(box) {
        const b = box ?? { x1: -WORLD, y1: -WORLD, x2: WORLD, y2: WORLD };
        const bw = Math.max(60, b.x2 - b.x1);
        const bh = Math.max(60, b.y2 - b.y1);
        this.scale = Math.max(bw / this.w, bh / this.h) * (box ? 1.25 : 1.02);
        this.cx = (b.x1 + b.x2) / 2;
        this.cy = (b.y1 + b.y2) / 2;
        this.fitted = true;
        this.draw();
    }

    toScreen(x, y) {
        return [this.w / 2 + (x - this.cx) / this.scale, this.h / 2 - (y - this.cy) / this.scale];
    }

    toWorld(sx, sy) {
        return [this.cx + (sx - this.w / 2) * this.scale, this.cy - (sy - this.h / 2) * this.scale];
    }

    /**
     * Point layers drawn in order.
     * @param {Array<{ xy: Float32Array|number[], color: string, size?: number }>} layers xy = [x0, y0, x1, y1, …]
     */
    setLayers(layers) {
        this.layers = layers;
        this.draw();
    }

    setSelection(rect) {
        this.selection = rect;
        this.draw();
    }

    setMarker(p) {
        this.marker = p;
        this.draw();
    }

    setTool(tool) {
        this.tool = tool;
        this.canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    }

    setCursor(cursor) {
        this.canvas.style.cursor = cursor || (this.tool === 'pan' ? 'grab' : 'crosshair');
    }

    bind() {
        const c = this.canvas;
        this.setTool(this.tool);
        c.addEventListener('contextmenu', (e) => e.preventDefault());
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = c.getBoundingClientRect();
            // keep the point under the cursor fixed
            this.zoomBy(Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        let drag = null;
        c.addEventListener('pointerdown', (e) => {
            const r = c.getBoundingClientRect();
            const sx = e.clientX - r.left;
            const sy = e.clientY - r.top;
            // a page tool (drawing, moving shapes) gets the left button first; 'drag-pans' tools pan on empty space
            const pan = this.tool === 'pan' || e.button !== 0 || e.shiftKey || this.tool === 'drag-pans';
            const custom = this.tool !== 'pan' && e.button === 0 && !e.shiftKey;
            if (custom && this.opts.interact?.down?.(this.toWorld(sx, sy), e)) {
                drag = { custom: true };
                c.setPointerCapture(e.pointerId);
                this.draw();
                return;
            }
            drag = { pan, sx, sy, cx: this.cx, cy: this.cy, start: this.toWorld(sx, sy), moved: false };
            c.setPointerCapture(e.pointerId);
            if (pan) c.style.cursor = 'grabbing';
        });
        c.addEventListener('pointermove', (e) => {
            const r = c.getBoundingClientRect();
            const sx = e.clientX - r.left;
            const sy = e.clientY - r.top;
            this.hover = this.toWorld(sx, sy);
            if (drag?.custom) {
                this.opts.interact.move?.(this.hover, e);
                this.draw();
                return;
            }
            if (!drag) this.opts.interact?.hover?.(this.hover, e);
            if (drag) {
                if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
                if (drag.pan) {
                    this.cx = drag.cx - (sx - drag.sx) * this.scale;
                    this.cy = drag.cy + (sy - drag.sy) * this.scale;
                } else if (drag.moved) {
                    const [x, y] = this.hover;
                    this.selection = { x1: Math.min(drag.start[0], x), y1: Math.min(drag.start[1], y), x2: Math.max(drag.start[0], x), y2: Math.max(drag.start[1], y) };
                }
            }
            this.draw();
        });
        const end = (e) => {
            if (!drag) return;
            const d = drag;
            drag = null;
            if (d.custom) {
                const r = c.getBoundingClientRect();
                this.opts.interact.up?.(this.toWorld(e.clientX - r.left, e.clientY - r.top), e);
                this.draw();
                return;
            }
            this.setTool(this.tool);
            if (!d.moved) {
                this.opts.onPick?.(d.start);
                return;
            }
            if (!d.pan && this.selection) this.opts.onSelect?.(this.selection);
            void e;
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', end);
        c.addEventListener('dblclick', (e) => {
            const r = c.getBoundingClientRect();
            const w = this.toWorld(e.clientX - r.left, e.clientY - r.top);
            // double click zooms in, unless the page uses it (closing a polygon…)
            if (!this.opts.interact?.dblclick?.(w, e)) this.zoomBy(1 / 2, e.clientX - r.left, e.clientY - r.top);
        });
        c.addEventListener('pointerleave', () => {
            this.hover = null;
            this.draw();
        });
    }

    draw() {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            this.paint();
        });
    }

    paint() {
        const { ctx, w, h } = this;
        this.syncSlider();
        ctx.fillStyle = '#6f8ba8';
        ctx.fillRect(0, 0, w, h);
        if (this.img.complete && this.img.naturalWidth) {
            const [x0, y0] = this.toScreen(-WORLD, WORLD);
            const size = 6000 / this.scale;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(this.img, x0, y0, size, size);
        } else {
            // no game map: a 500-unit grid so positions still make sense
            ctx.strokeStyle = 'rgba(255,255,255,.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let v = -WORLD; v <= WORLD; v += 500) {
                const [ax, ay] = this.toScreen(v, WORLD);
                const [bx, by] = this.toScreen(v, -WORLD);
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                const [px, py] = this.toScreen(-WORLD, v);
                const [qx, qy] = this.toScreen(WORLD, v);
                ctx.moveTo(px, py);
                ctx.lineTo(qx, qy);
            }
            ctx.stroke();
        }
        // only dots inside the view; the dot grows a little when zoomed in
        const [vx1, vy2] = this.toWorld(0, 0);
        const [vx2, vy1] = this.toWorld(w, h);
        for (const layer of this.layers) {
            const xy = layer.xy;
            const r = Math.max(1.5, Math.min(5, (layer.size ?? 2) * (3 / Math.sqrt(this.scale))));
            ctx.fillStyle = layer.color;
            ctx.beginPath();
            for (let i = 0; i < xy.length; i += 2) {
                const x = xy[i];
                const y = xy[i + 1];
                if (x < vx1 || x > vx2 || y < vy1 || y > vy2) continue;
                const [sx, sy] = this.toScreen(x, y);
                ctx.moveTo(sx + r, sy);
                ctx.arc(sx, sy, r, 0, Math.PI * 2);
            }
            ctx.fill();
            if (layer.stroke) {
                ctx.strokeStyle = layer.stroke;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
        if (this.selection) {
            const s = this.selection;
            const [x1, y1] = this.toScreen(s.x1, s.y2);
            const [x2, y2] = this.toScreen(s.x2, s.y1);
            ctx.fillStyle = 'rgba(255, 200, 0, .12)';
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            ctx.strokeStyle = '#ffc800';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            ctx.setLineDash([]);
        }
        this.opts.overlay?.(ctx, this);
        if (this.marker) {
            const [sx, sy] = this.toScreen(this.marker[0], this.marker[1]);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sx, sy, 8, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = '#e0245e';
            ctx.beginPath();
            ctx.arc(sx, sy, 6, 0, Math.PI * 2);
            ctx.stroke();
        }
        if (this.hover) {
            const t = `${this.hover[0].toFixed(1)}, ${this.hover[1].toFixed(1)}`;
            ctx.font = '12px var(--vscode-editor-font-family, monospace)';
            const tw = ctx.measureText(t).width;
            ctx.fillStyle = 'rgba(0,0,0,.6)';
            ctx.fillRect(w - tw - 14, h - 22, tw + 10, 18);
            ctx.fillStyle = '#fff';
            ctx.fillText(t, w - tw - 9, h - 9);
        }
    }
}
