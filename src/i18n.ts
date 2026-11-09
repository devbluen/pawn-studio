/**
 * Localization helper.
 *
 * Every user-visible string goes through `t('English message with {0}', value)`.
 * - Inside VS Code: uses `vscode.l10n.t`, which picks the bundle for the editor's display
 *   language (`l10n/bundle.l10n.<locale>.json`).
 * - With the `pawnStudio.language` setting, the bundle is loaded manually so the user can force
 *   a language different from the editor's.
 * - Outside VS Code (unit tests in plain Node): returns the English text with the placeholders filled.
 *
 * English is the source language: the message itself is the key in the translation bundles.
 */
import * as fs from 'fs';
import * as path from 'path';

type Arg = string | number | boolean;

let vscodeApi: { l10n?: { t(message: string, ...args: Arg[]): string } } | undefined;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    vscodeApi = require('vscode');
} catch {
    vscodeApi = undefined; // plain Node (tests)
}

/** Manually loaded bundle when the user forces a language; `null` = follow VS Code. */
let override: Record<string, string> | null = null;

export function format(message: string, args: Arg[]): string {
    return message.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

export function t(message: string, ...args: Arg[]): string {
    if (override) return format(override[message] ?? message, args);
    if (vscodeApi?.l10n) return vscodeApi.l10n.t(message, ...args);
    return format(message, args);
}

/**
 * Forces a language. `auto` follows VS Code; `en` uses the source strings;
 * anything else loads `l10n/bundle.l10n.<lang>.json` from the extension folder.
 */
export function setLanguage(extensionPath: string, lang: string | undefined): void {
    const l = (lang ?? 'auto').toLowerCase();
    if (l === 'auto') {
        override = null;
        return;
    }
    if (l === 'en') {
        override = {};
        return;
    }
    try {
        override = JSON.parse(fs.readFileSync(path.join(extensionPath, 'l10n', `bundle.l10n.${l}.json`), 'utf8'));
    } catch {
        override = null;
    }
}
