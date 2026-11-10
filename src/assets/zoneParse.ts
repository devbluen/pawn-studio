/**
 * Finds the gang zone code around the cursor (GangZoneCreate, CreateDynamicRectangle/Circle/Cylinder/Polygon
 * or the GangZone Creator "// zone:" lines) so the GangZone Creator can open it.
 */
const RELEVANT = /\b(GangZoneCreate|CreateDynamic(?:Rectangle|Circle|Cylinder|Polygon)|GangZoneShowFor(?:Player|All))\s*\(|^\s*\/\/\s*zone[:+]/;
const MAX_GAP = 8;
const MAX_SPAN = 300;

/** The polygon point arrays the code uses but defines somewhere else in the file. */
function referencedArrays(block: string, whole: string): string[] {
    const out: string[] = [];
    for (const m of block.matchAll(/\bCreateDynamicPolygon\s*\(\s*(\w+)/g)) {
        const def = new RegExp(String.raw`Float\s*:\s*${m[1]}\s*\[[^\]]*\]\s*=\s*\{[^}]*\}`);
        if (def.test(block)) continue;
        const found = def.exec(whole);
        if (found) out.push(`new ${found[0]};`);
    }
    return out;
}

export function findZoneBlock(lines: string[], line: number, selected?: string): string | undefined {
    const whole = lines.join('\n');
    if (selected && selected.split(/\r?\n/).some((l) => RELEVANT.test(l))) return [selected, ...referencedArrays(selected, whole)].join('\n');
    let at = -1;
    for (let d = 0; d <= 3 && at < 0; d++) {
        if (RELEVANT.test(lines[line - d] ?? '')) at = line - d;
        else if (RELEVANT.test(lines[line + d] ?? '')) at = line + d;
    }
    if (at < 0) return undefined;
    let from = at;
    let to = at;
    for (let i = at - 1, last = at; i >= 0 && at - i <= MAX_SPAN && last - i <= MAX_GAP; i--) if (RELEVANT.test(lines[i])) from = last = i;
    for (let i = at + 1, last = at; i < lines.length && i - at <= MAX_SPAN && i - last <= MAX_GAP; i++) if (RELEVANT.test(lines[i])) to = last = i;
    // the "// zone+" polygon points follow their "// zone:" line
    while (to + 1 < lines.length && /^\s*\/\/\s*zone\+/.test(lines[to + 1])) to++;
    const block = lines.slice(from, to + 1).join('\n');
    return [block, ...referencedArrays(block, whole)].join('\n');
}
