// Attachment editor (SetPlayerAttachedObject / AttachObjectToVehicle) inside VS Code.
// Ported from SA-MP Preview Studio (github.com/devbluen/samp-preview-studio): the 3D editor, the
// object browser and the Pawn code generation are the same modules; models come from the player's
// GTA SA through the extension (sources.js) and the code goes straight into the editor.
import { post, on, vscode } from './bridge.js';
import { sources } from './sources.js';
import { ModelLoader } from './models.js';

const L = window.L10N;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const t = (k) => esc(L[k] ?? k);

document.getElementById('app').outerHTML = `
<dialog id="obj-browser" class="obj-browser">
    <div class="card-head"><h2>${t('atObjects')}</h2><button id="ob-close" class="btn ghost sm icon" title="${t('atClose')}">×</button></div>
    <input id="ob-search" type="search" placeholder="${t('atSearchObjects')}" autocomplete="off">
    <div id="ob-cats" class="ob-cats"></div>
    <p id="ob-hint" class="hint"></p>
    <div id="ob-grid" class="ob-grid"></div>
    <p class="hint">${t('atBrowserHint')}</p>
</dialog>

<main class="app" id="attach-app" style="--empty-slots: '${esc(L.atNoSlots).replace(/'/g, "\\'")}'">
    <aside class="col col-left">
        <section class="card">
            <div class="card-head"><h2>${t('atAttachTo')}</h2>
                <div class="segmented" id="at-target">
                    <button data-target="player" class="active" title="SetPlayerAttachedObject">${t('atPlayer')}</button>
                    <button data-target="vehicle" title="AttachObjectToVehicle">${t('atVehicle')}</button>
                </div>
            </div>
            <div class="player-only">
                <div class="model-nav no-source">
                    <button id="at-skin-prev" class="btn icon" title="${t('atPrevSkin')}">‹</button>
                    <input id="at-skin" type="number" min="0" max="311" value="7" title="${t('atSkinId')}">
                    <button id="at-skin-next" class="btn icon" title="${t('atNextSkin')}">›</button>
                </div>
                <div class="search">
                    <input id="at-skin-search" type="search" placeholder="${t('atSearchSkin')}" autocomplete="off">
                    <ul class="results" id="at-skin-results"></ul>
                </div>
                <div id="at-skin-name" class="muted"></div>
            </div>
            <div class="vehicle-only">
                <div class="model-nav no-source">
                    <button id="at-veh-prev" class="btn icon" title="${t('atPrevVehicle')}">‹</button>
                    <input id="at-veh" type="number" min="400" max="611" value="411" title="${t('atVehicleId')}">
                    <button id="at-veh-next" class="btn icon" title="${t('atNextVehicle')}">›</button>
                </div>
                <div class="search">
                    <input id="at-veh-search" type="search" placeholder="${t('atSearchVehicle')}" autocomplete="off">
                    <ul class="results" id="at-veh-results"></ul>
                </div>
                <div id="at-veh-name" class="muted"></div>
                <div class="inline at-vcolors">
                    <label class="mini">${t('atColors')} <input id="at-vc1" type="number" min="0" max="255" title="${t('atColor1')}"></label>
                    <input id="at-vc2" type="number" min="0" max="255" title="${t('atColor2')}">
                </div>
            </div>
        </section>

        <section class="card">
            <div class="card-head"><h2>${t('atAttached')}</h2>
                <div class="inline">
                    <button id="at-browse" class="btn primary sm" title="${t('atBrowseHint')}">${t('atBrowse')}</button>
                    <button id="at-add" class="btn ghost sm">+ ${t('atAdd')}</button>
                </div>
            </div>
            <ul id="at-slots" class="slot-list"></ul>
        </section>

        <section class="card" id="at-editor">
            <div class="card-head"><h2>${t('atSlot')}</h2>
                <div class="inline">
                    <button id="at-dup" class="btn ghost sm" title="${t('atDuplicateHint')}">${t('atDuplicate')}</button>
                    <button id="at-del" class="btn ghost sm danger">${t('atRemove')}</button>
                </div>
            </div>
            <div class="grid2">
                <label>${t('atIndex')}<select id="at-index"></select></label>
                <label class="player-only">${t('atBone')}<select id="at-bone"></select></label>
            </div>
            <div class="field">
                <label>${t('atModel')}</label>
                <div class="inline">
                    <input id="at-model" type="number" min="0" class="model-input" title="${t('atObjectId')}">
                    <div class="search grow">
                        <input id="at-model-search" type="search" placeholder="${t('atSearchObject')}" autocomplete="off">
                        <ul class="results" id="at-model-results"></ul>
                    </div>
                    <button id="at-model-browse" class="btn icon" title="${t('atBrowse')}"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5"/><rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/></svg></button>
                </div>
                <div id="at-model-name" class="muted"></div>
            </div>
            <div class="vec">
                <span class="vec-label">${t('atOffset')}</span>
                <input type="number" step="0.01" data-k="x" title="fOffsetX"><input type="number" step="0.01" data-k="y" title="fOffsetY"><input type="number" step="0.01" data-k="z" title="fOffsetZ">
            </div>
            <div class="vec">
                <span class="vec-label">${t('atRotation')}</span>
                <input type="number" step="1" data-k="rx" title="fRotX"><input type="number" step="1" data-k="ry" title="fRotY"><input type="number" step="1" data-k="rz" title="fRotZ">
            </div>
            <div class="vec player-only">
                <span class="vec-label">${t('atScale')}</span>
                <input type="number" step="0.05" data-k="sx" title="fScaleX"><input type="number" step="0.05" data-k="sy" title="fScaleY"><input type="number" step="0.05" data-k="sz" title="fScaleZ">
            </div>
            <div class="vec-axes"><span></span><span class="x">X</span><span class="y">Y</span><span class="z">Z</span></div>
            <label class="check player-only"><input id="at-uniform" type="checkbox"> ${t('atUniform')}</label>
            <div class="field player-only">
                <label>${t('atMaterialColors')} <small>materialcolor1 / 2 (ARGB)</small></label>
                <div class="inline mc-row">
                    <label class="check" title="materialcolor1"><input id="at-mc1-on" type="checkbox"> 1</label>
                    <input id="at-mc1" type="color" value="#ffffff">
                    <label class="mini">A <input id="at-mc1-a" type="number" min="0" max="255" value="255"></label>
                </div>
                <div class="inline mc-row">
                    <label class="check" title="materialcolor2"><input id="at-mc2-on" type="checkbox"> 2</label>
                    <input id="at-mc2" type="color" value="#ffffff">
                    <label class="mini">A <input id="at-mc2-a" type="number" min="0" max="255" value="255"></label>
                </div>
            </div>
        </section>

        <details class="card">
            <summary><h2>${t('atOptions')}</h2><span class="muted">${t('atAdvanced')}</span></summary>
            <label class="check"><input id="at-marker" type="checkbox" checked> ${t('atShowMarker')}</label>
            <p class="hint player-only">${t('atBindPoseHint')}</p>
            <div class="field vehicle-only">
                <label>${t('atVehicleOrder')}</label>
                <select id="at-vorder">
                    <option value="ZXY">${t('atOrderZXY')}</option>
                    <option value="XYZ">${t('atOrderXYZ')}</option>
                </select>
                <p class="hint">${t('atVehicleOrderHint')}</p>
            </div>
        </details>
    </aside>

    <section class="col stage">
        <div class="stage-bar">
            <div class="segmented" id="at-gizmo">
                <button data-mode="translate" class="active" title="W">${t('atMove')} <kbd>W</kbd></button>
                <button data-mode="rotate" title="E">${t('atRotate')} <kbd>E</kbd></button>
                <button data-mode="scale" title="R">${t('atScaleMode')} <kbd>R</kbd></button>
            </div>
            <div class="segmented" id="at-space">
                <button data-space="local" class="active" title="${t('atLocalHint')}">${t('atLocal')}</button>
                <button data-space="world" title="${t('atWorldHint')}">${t('atWorld')}</button>
            </div>
            <div class="segmented" id="at-views">
                <button data-view="front">${t('atFront')}</button>
                <button data-view="right">${t('atSide')}</button>
                <button data-view="back">${t('atBack')}</button>
                <button data-view="top">${t('atTop')}</button>
                <button data-view="focus" title="F">${t('atFocus')}</button>
            </div>
            <div class="zoom-ctl" title="Zoom">
                <button id="at-zoom-out" class="btn icon sm">−</button>
                <input id="at-zoom" type="range" min="0" max="100" step="0.5">
                <button id="at-zoom-in" class="btn icon sm">+</button>
                <span id="at-zoom-val" class="zoom-val"></span>
            </div>
            <span id="at-status" class="muted"></span>
        </div>
        <div class="viewport">
            <div class="view active at-view"><canvas id="at-canvas"></canvas></div>
        </div>
        <div class="stage-foot">
            <div id="at-info"></div>
            <div class="hint">${t('atStageHint')}</div>
        </div>
    </section>

    <aside class="col col-right">
        <section class="card">
            <div class="card-head"><h2>${t('atCode')}</h2></div>
            <pre id="at-code" class="code"></pre>
            <label class="check vehicle-only"><input id="at-streamer" type="checkbox"> ${t('atStreamer')}</label>
            <div class="btn-row at-insert-row">
                <button id="at-insert-all" class="btn primary">${t('atInsertAll')}</button>
                <button id="at-insert-one" class="btn">${t('atInsertOne')}</button>
            </div>
            <div class="btn-row">
                <button id="at-copy-all" class="btn ghost sm">${t('atCopyAll')}</button>
                <button id="at-copy-one" class="btn ghost sm">${t('atCopyOne')}</button>
            </div>
        </section>
        <section class="card">
            <div class="card-head"><h2>${t('atImport')}</h2></div>
            <textarea id="at-import"></textarea>
            <div class="btn-row">
                <button id="at-import-add" class="btn">${t('atImportAdd')}</button>
                <button id="at-import-replace" class="btn">${t('atImportReplace')}</button>
            </div>
            <p class="hint">${t('atImportHint')}</p>
        </section>
        <p class="hint">${L.atCredits}</p>
    </aside>
</main>`;

// state lives in the webview state (survives hiding the panel and reloads of the window)
const saved = vscode.getState() ?? {};
const store = {
    get(key, fallback) {
        const v = saved[key];
        return v ? { ...fallback, ...v } : { ...fallback };
    },
    set(key, value) {
        saved[key] = value;
        vscode.setState(saved);
    },
};

function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1800);
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function highlight(code) {
    return escapeHtml(code).replace(/(\/\/[^\n]*)|("[^"]*")|\b(\w+)(?=\()|(-?\b0x[0-9A-F]+\b|-?\b\d+(?:\.\d+)?\b)/gi, (m, cmt, str, fn, num) =>
        cmt ? `<span class="muted">${cmt}</span>` : str ? `<span class="str">${str}</span>` : fn ? `<span class="fn">${fn}</span>` : `<span class="num">${num}</span>`);
}

const status = (text) => {
    const el = document.getElementById('at-status');
    el.textContent = text;
};

async function init() {
    status(L.loading);
    try {
        await sources.init();
    } catch (e) {
        status(e.message);
        document.getElementById('at-status').className = 'error';
        return;
    }
    status('');
    const ui = await import('./attach-ui.js');
    await ui.initAttach({
        store,
        toast,
        highlight,
        copy: (text) => {
            post('copy', { text });
            toast(L.atCopied);
        },
        insert: (code) => post('insert', { code }),
        getCatalog: () => sources.catalog,
        loader: new ModelLoader(),
    });
    // code under the cursor in the editor (SetPlayerAttachedObject / AttachObjectToVehicle lines)
    on('import', (m) => ui.importCode(m.text, m.target));
    post('ready');
}

init();
