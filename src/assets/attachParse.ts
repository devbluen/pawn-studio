/**
 * Finds the attachment code around the cursor (SetPlayerAttachedObject lines, or CreateObject +
 * AttachObjectToVehicle blocks) so the attachment editor opens with it. No VS Code dependency.
 */
export interface AttachBlock {
    text: string;
    target: 'player' | 'vehicle';
}

const PLAYER = /\bSetPlayerAttachedObject\s*\(/;
const VEHICLE = /\bAttach(?:Dynamic)?ObjectToVehicle\s*\(/;
const CREATE = /\bCreate(?:Dynamic)?Object\s*\(/;
const RELATED = new RegExp(`${PLAYER.source}|${VEHICLE.source}|${CREATE.source}`);

/**
 * @param lines the document lines
 * @param line the cursor line
 * @param selected the selected text, if any (wins over the block search)
 */
export function findAttachBlock(lines: string[], line: number, selected?: string): AttachBlock | undefined {
    const pick = (text: string): AttachBlock | undefined =>
        VEHICLE.test(text) ? { text, target: 'vehicle' } : PLAYER.test(text) ? { text, target: 'player' } : undefined;
    if (selected && selected.trim()) return pick(selected);
    if (!RELATED.test(lines[line] ?? '')) return undefined;
    // grow over neighbouring related lines (blank lines and comments in between are fine)
    const skippable = (s: string) => !s.trim() || /^\s*\/\//.test(s);
    let from = line;
    let to = line;
    for (let i = line - 1; i >= 0 && line - i <= 60; i--) {
        if (RELATED.test(lines[i])) from = i;
        else if (!skippable(lines[i])) break;
    }
    for (let i = line + 1; i < lines.length && i - line <= 60; i++) {
        if (RELATED.test(lines[i])) to = i;
        else if (!skippable(lines[i])) break;
    }
    return pick(lines.slice(from, to + 1).join('\n'));
}
