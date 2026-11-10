// Request/response over the VS Code webview message channel.
export const vscode = acquireVsCodeApi();

let seq = 0;
const pending = new Map();
const listeners = new Map();

export function request(type, extra = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        vscode.postMessage({ type, reqId: id, ...extra });
    });
}

export function post(type, extra = {}) {
    vscode.postMessage({ type, ...extra });
}

/** Messages the extension sends on its own (e.g. code to import from the editor). */
export function on(type, fn) {
    listeners.set(type, fn);
}

window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.reqId && pending.has(m.reqId)) {
        const p = pending.get(m.reqId);
        pending.delete(m.reqId);
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve(m);
        return;
    }
    listeners.get(m.type)?.(m);
});
