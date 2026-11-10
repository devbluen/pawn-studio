/**
 * Package names and version requirements (Pawn Studio format).
 *
 * In pawn.json, `dependencies` is an object — key = GitHub repository, value = requirement:
 *   "^2.9.6"          compatible updates (2.x.x ≥ 2.9.6)       — the default when adding
 *   "~2.9.6"          patch updates only (2.9.x ≥ 2.9.6)
 *   "2.9.6"           exactly that version (tag v2.9.6 or 2.9.6)
 *   "2.x", ">=1.2 <2" any semver-like range ( "||" also works )
 *   "latest" / "*"    newest stable tag (default branch when the repo has no tags)
 *   "tag:r1-final"    a tag by its exact name (for tags that are not versions)
 *   "branch:dev"      newest commit of a branch (locked to a commit in pawn-lock.json)
 *   "commit:a1b2c3d"  a fixed commit
 */

export interface PackageName {
    owner: string;
    repo: string;
}

export type Requirement =
    | { kind: 'latest' }
    | { kind: 'range'; range: string; exact?: string }
    | { kind: 'tag'; tag: string }
    | { kind: 'branch'; branch: string }
    | { kind: 'commit'; commit: string };

const NAME_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

/**
 * Parses a package name. Accepts `user/repo`, `https://github.com/user/repo(.git)` and the
 * npm-like shorthand `user/repo@<requirement>` (the requirement is returned separately).
 */
export function parsePackageInput(input: string): { name: PackageName; requirement?: string } | undefined {
    let s = input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\/+$/, '');
    let requirement: string | undefined;
    const tree = /^([^/]+)\/([^/]+)\/(tree|releases\/tag|commit)\/(.+)$/.exec(s);
    if (tree) {
        s = `${tree[1]}/${tree[2]}`;
        requirement = tree[3] === 'tree' ? `branch:${tree[4]}` : tree[3] === 'commit' ? `commit:${tree[4]}` : `tag:${tree[4]}`;
    } else {
        const at = s.indexOf('@');
        if (at > 0) {
            requirement = s.slice(at + 1).trim() || undefined;
            s = s.slice(0, at);
        }
    }
    const m = NAME_RE.exec(s);
    if (!m) return undefined;
    if (requirement !== undefined && !parseRequirement(requirement)) return undefined;
    return { name: { owner: m[1], repo: m[2] }, requirement };
}

export function parsePackageName(input: string): PackageName | undefined {
    return parsePackageInput(input)?.name;
}

/** Unique (case-insensitive) key of a package. */
export function depKey(d: PackageName): string {
    return `${d.owner}/${d.repo}`.toLowerCase();
}

export function displayName(d: PackageName): string {
    return `${d.owner}/${d.repo}`;
}

export function parseRequirement(value: string | undefined): Requirement | undefined {
    const v = (value ?? '').trim();
    if (!v || v === '*' || /^latest$/i.test(v) || /^x$/i.test(v)) return { kind: 'latest' };
    const prefixed = /^(tag|branch|commit):(.+)$/i.exec(v);
    if (prefixed) {
        const kind = prefixed[1].toLowerCase();
        const ref = prefixed[2].trim();
        if (!ref) return undefined;
        if (kind === 'tag') return { kind: 'tag', tag: ref };
        if (kind === 'branch') return { kind: 'branch', branch: ref };
        return /^[0-9a-f]{4,40}$/i.test(ref) ? { kind: 'commit', commit: ref } : undefined;
    }
    if (!parseRange(v)) return undefined;
    // A bare version ("2.9.6", "v2.9.6") is an exact requirement.
    const exact = /^=?\s*[A-Za-z_-]{0,10}\d+([.-]\d+)*([-+][0-9A-Za-z.-]+)?$/.test(v) ? v.replace(/^=\s*/, '') : undefined;
    return { kind: 'range', range: v, exact };
}

export function formatRequirement(r: Requirement): string {
    switch (r.kind) {
        case 'latest':
            return 'latest';
        case 'range':
            return r.range;
        case 'tag':
            return `tag:${r.tag}`;
        case 'branch':
            return `branch:${r.branch}`;
        case 'commit':
            return `commit:${r.commit}`;
    }
}

// ───────────────────────── versions ─────────────────────────

export interface Version {
    /** at least 3 numbers (missing ones are 0); 4-part tags such as 1.1.0.1 keep the 4th */
    nums: number[];
    pre: string; // "" = stable
}

/** Loose version parse: v1.2, 2.9.6, r1.0-beta, release-3.1 → numbers + pre-release suffix. */
export function parseVersion(v: string): Version | undefined {
    v = v.trim();
    // SA-MP style "R41-4", "r39-6": numbers joined by hyphens are version parts, not a pre-release
    if (/^[A-Za-z_-]*\d+(-\d+)+$/.test(v)) v = v.replace(/(\d)-(?=\d)/g, '$1.');
    const m = /^[^\d]*?(\d+(?:\.\d+)*)(?:[-+_ ]?([0-9A-Za-z.-]*))?$/.exec(v.trim());
    if (!m) return undefined;
    const nums = m[1].split('.').map((x) => parseInt(x, 10));
    while (nums.length < 3) nums.push(0);
    return { nums, pre: (m[2] ?? '').replace(/^\+.*$/, '').trim() };
}

/** "v1.2", "2.9.6", "R41-4", "release-3.1" — a short alphabetic prefix followed by a number. */
export function isVersionLike(v: string): boolean {
    return /^[A-Za-z_-]{0,10}\d/.test(v.trim());
}

const PRERELEASE_RE = /(alpha|beta|rc|pre|dev|test|nightly|snapshot)/i;

function isPrerelease(tag: string, v: Version): boolean {
    return !!v.pre && PRERELEASE_RE.test(v.pre) || PRERELEASE_RE.test(tag);
}

function cmp(a: Version, b: Version): number {
    for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
        const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
        if (d) return d;
    }
    if (!a.pre && b.pre) return 1;
    if (a.pre && !b.pre) return -1;
    return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

/** Compares two "loose" versions. >0 if a > b. */
export function compareVersions(a: string, b: string): number {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return pa ? 1 : pb ? -1 : a.localeCompare(b);
    return cmp(pa, pb);
}

// ───────────────────────── ranges ─────────────────────────

type Comparator = { op: '>' | '>=' | '<' | '<=' | '='; v: Version };

/** Partial version: missing parts are wildcards ("1.2" → 1.2.x). */
function partial(s: string): { nums: number[]; pre: string } | undefined {
    s = s.trim();
    if (/^[A-Za-z_-]*\d+(-\d+)+$/.test(s)) s = s.replace(/(\d)-(?=\d)/g, '$1.'); // R41-4
    s = s.replace(/^[A-Za-z_-]+(?=\d)/, ''); // v1.2, R41, release-3
    const m = /^((?:\d+|[xX*])(?:\.(?:\d+|[xX*]))*)(?:-([0-9A-Za-z.-]+))?$/.exec(s.trim());
    if (!m) return undefined;
    const nums: number[] = [];
    for (const p of m[1].split('.')) {
        if (/^[xX*]$/.test(p)) break;
        nums.push(parseInt(p, 10));
    }
    return { nums, pre: m[2] ?? '' };
}

const V = (a: number, b = 0, c = 0, pre = ''): Version => ({ nums: [a, b, c], pre });

function expand(token: string): Comparator[] | undefined {
    const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
    if (!m) return undefined;
    const op = m[1] ?? '';
    const p = partial(m[2]);
    if (!p) return undefined;
    const [a, b, c] = p.nums;
    const n = p.nums.length;
    if (n === 0) return op === '<' || op === '>' ? [{ op: '<', v: V(0) }] : [];
    // the full version (a 4th part such as 1.1.0.1 counts for >=, =, >…)
    const lo: Version = { nums: [a, b ?? 0, c ?? 0, ...p.nums.slice(3)], pre: p.pre };
    switch (op) {
        case '^':
            if (a > 0 || n === 1) return [{ op: '>=', v: lo }, { op: '<', v: V(a + 1) }];
            if ((b ?? 0) > 0 || n === 2) return [{ op: '>=', v: lo }, { op: '<', v: V(0, (b ?? 0) + 1) }];
            return [{ op: '>=', v: lo }, { op: '<', v: V(0, 0, (c ?? 0) + 1) }];
        case '~':
            return n === 1 ? [{ op: '>=', v: lo }, { op: '<', v: V(a + 1) }] : [{ op: '>=', v: lo }, { op: '<', v: V(a, (b ?? 0) + 1) }];
        case '>':
            return n >= 3 ? [{ op: '>', v: lo }] : n === 2 ? [{ op: '>=', v: V(a, b + 1) }] : [{ op: '>=', v: V(a + 1) }];
        case '<=':
            return n >= 3 ? [{ op: '<=', v: lo }] : n === 2 ? [{ op: '<', v: V(a, b + 1) }] : [{ op: '<', v: V(a + 1) }];
        case '>=':
        case '<':
            return [{ op, v: lo }];
        default:
            if (n >= 3) return [{ op: '=', v: lo }];
            return n === 2 ? [{ op: '>=', v: lo }, { op: '<', v: V(a, b + 1) }] : [{ op: '>=', v: lo }, { op: '<', v: V(a + 1) }];
    }
}

/** Parses a range into OR-groups of AND-comparators. undefined = invalid. */
export function parseRange(range: string): Comparator[][] | undefined {
    const groups: Comparator[][] = [];
    for (const part of range.split('||')) {
        let s = part.trim();
        // "1.2 - 1.4" (hyphen range)
        const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
        if (hy) s = `>=${hy[1]} <=${hy[2]}`;
        const tokens = s.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
        const group: Comparator[] = [];
        for (const tok of tokens.length ? tokens : ['*']) {
            const c = expand(tok);
            if (!c) return undefined;
            group.push(...c);
        }
        groups.push(group);
    }
    return groups;
}

function test(c: Comparator, v: Version): boolean {
    const d = cmp(v, c.v);
    switch (c.op) {
        case '>':
            return d > 0;
        case '>=':
            return d >= 0;
        case '<':
            return d < 0;
        case '<=':
            return d <= 0;
        default:
            return d === 0;
    }
}

/** Does the tag satisfy the range? Pre-releases only match when the range mentions one. */
export function satisfies(tag: string, range: string): boolean {
    const v = parseVersion(tag);
    const groups = parseRange(range);
    if (!v || !groups) return false;
    const wantsPre = /-[0-9A-Za-z]/.test(range);
    if (isPrerelease(tag, v) && !wantsPre) return false;
    return groups.some((g) => g.every((c) => test(c, v)));
}

/** Highest version-like tag; ignores pre-releases when a stable one exists. */
export function latestTag(tags: string[]): string | undefined {
    const versions = tags.filter((t) => isVersionLike(t) && parseVersion(t));
    if (!versions.length) return undefined;
    const stable = versions.filter((t) => !isPrerelease(t, parseVersion(t)!));
    const pool = stable.length ? stable : versions;
    return pool.slice().sort((a, b) => compareVersions(b, a))[0];
}

/** Picks the tag that best fulfills a requirement (undefined = none / not tag-based). */
export function resolveTag(tags: string[], r: Requirement): string | undefined {
    if (r.kind === 'latest') return latestTag(tags);
    if (r.kind === 'tag') return tags.find((t) => t === r.tag) ?? tags.find((t) => t.toLowerCase() === r.tag.toLowerCase());
    if (r.kind !== 'range') return undefined;
    if (r.exact) {
        const byName = tags.find((t) => t === r.exact);
        if (byName) return byName;
    }
    const ok = tags.filter((t) => isVersionLike(t) && satisfies(t, r.range));
    return ok.sort((a, b) => compareVersions(b, a))[0];
}

/** Does an installed ref still fulfill the requirement? */
export function refSatisfies(ref: { type: 'tag' | 'branch' | 'commit'; ref: string; commit?: string }, r: Requirement): boolean {
    switch (r.kind) {
        case 'latest':
            return ref.type === 'tag' || ref.type === 'branch';
        case 'range':
            return ref.type === 'tag' && (ref.ref === r.exact || satisfies(ref.ref, r.range));
        case 'tag':
            return ref.type === 'tag' && ref.ref.toLowerCase() === r.tag.toLowerCase();
        case 'branch':
            return ref.type === 'branch' && ref.ref === r.branch;
        case 'commit':
            return !!ref.commit && ref.commit.toLowerCase().startsWith(r.commit.toLowerCase());
    }
}

/** Default requirement written when adding a package at a tag: "^<tag>" when it is a version. */
export function caretFor(tag: string): string {
    const v = parseVersion(tag);
    if (!v || !isVersionLike(tag) || v.pre) return tag;
    return `^${tag.replace(/^v(?=\d)/i, '')}`;
}
