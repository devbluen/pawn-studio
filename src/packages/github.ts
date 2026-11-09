/**
 * Minimal GitHub API client (native fetch from Node 18+).
 */
import { t } from '../i18n';

export class GitHubError extends Error {
    constructor(
        message: string,
        public status: number,
        public rateLimited = false,
    ) {
        super(message);
    }
}

export interface RepoInfo {
    full_name: string;
    name: string;
    owner: { login: string };
    description: string | null;
    stargazers_count: number;
    default_branch: string;
    html_url: string;
    pushed_at: string;
    topics?: string[];
    archived?: boolean;
}

export interface ReleaseAsset {
    name: string;
    browser_download_url: string;
    url: string;
    size: number;
}

export interface Release {
    tag_name: string;
    name: string | null;
    draft: boolean;
    prerelease: boolean;
    published_at: string;
    assets: ReleaseAsset[];
}

export interface TagInfo {
    name: string;
    commit: { sha: string };
}

type TokenProvider = () => Promise<string | undefined>;

const API = 'https://api.github.com';
const UA = 'pawn-studio-vscode';
const CACHE_TTL = 5 * 60 * 1000;

export class GitHub {
    private cache = new Map<string, { at: number; value: unknown }>();

    constructor(private token: TokenProvider = async () => undefined) {}

    clearCache(): void {
        this.cache.clear();
    }

    private async headers(accept = 'application/vnd.github+json'): Promise<Record<string, string>> {
        const h: Record<string, string> = { 'User-Agent': UA, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
        const token = await this.token();
        if (token) h.Authorization = `Bearer ${token}`;
        return h;
    }

    private async request(url: string, accept?: string): Promise<Response> {
        let res: Response;
        try {
            res = await fetch(url, { headers: await this.headers(accept), redirect: 'follow' });
        } catch (e) {
            throw new GitHubError(t('No connection to GitHub ({0})', (e as Error).message), 0);
        }
        if (!res.ok) {
            const remaining = res.headers.get('x-ratelimit-remaining');
            const limited = (res.status === 403 || res.status === 429) && remaining === '0';
            let detail = '';
            try {
                detail = ((await res.json()) as { message?: string }).message ?? '';
            } catch {
                /* non-JSON body */
            }
            if (limited) {
                const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
                const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : '?';
                throw new GitHubError(
                    t('GitHub rate limit reached (resets in ~{0} min). Sign in with your GitHub account to raise the limit.', mins),
                    res.status,
                    true,
                );
            }
            throw new GitHubError(`GitHub ${res.status}: ${detail || res.statusText} (${url})`, res.status);
        }
        return res;
    }

    async api<T>(p: string, useCache = true): Promise<T> {
        const url = p.startsWith('http') ? p : API + p;
        const hit = this.cache.get(url);
        if (useCache && hit && Date.now() - hit.at < CACHE_TTL) return hit.value as T;
        const value = (await (await this.request(url)).json()) as T;
        this.cache.set(url, { at: Date.now(), value });
        return value;
    }

    repo(owner: string, repo: string): Promise<RepoInfo> {
        return this.api<RepoInfo>(`/repos/${owner}/${repo}`);
    }

    tags(owner: string, repo: string): Promise<TagInfo[]> {
        return this.api<TagInfo[]>(`/repos/${owner}/${repo}/tags?per_page=100`);
    }

    releases(owner: string, repo: string): Promise<Release[]> {
        return this.api<Release[]>(`/repos/${owner}/${repo}/releases?per_page=30`);
    }

    async releaseByTag(owner: string, repo: string, tag: string): Promise<Release | undefined> {
        try {
            return await this.api<Release>(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
        } catch (e) {
            if (e instanceof GitHubError && e.status === 404) return undefined;
            throw e;
        }
    }

    async latestRelease(owner: string, repo: string): Promise<Release | undefined> {
        try {
            return await this.api<Release>(`/repos/${owner}/${repo}/releases/latest`);
        } catch (e) {
            if (e instanceof GitHubError && e.status === 404) return undefined;
            throw e;
        }
    }

    /** Commit SHA of a ref (branch, tag or sha). */
    async commitSha(owner: string, repo: string, ref: string): Promise<string> {
        const url = `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
        const res = await this.request(url, 'application/vnd.github.sha');
        return (await res.text()).trim();
    }

    /**
     * Searches packages: merges repositories tagged `topic:pawn-package` with a free-text search
     * filtered by SA-MP/open.mp/Pawn signals (many popular plugins lack the topic).
     */
    async searchRepos(query: string): Promise<Array<RepoInfo & { pawnPackage: boolean }>> {
        const search = async (q: string) =>
            (await this.api<{ items: RepoInfo[] }>(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`)).items;
        const [tagged, free] = await Promise.all([
            search(`${query} topic:pawn-package`.trim()),
            search(query.trim() ? `${query.trim()} samp` : 'topic:sa-mp').catch(() => [] as RepoInfo[]),
        ]);
        const SIGNAL = /\b(sa-?mp|samp|pawn|open\.?mp|omp|amx|pawncc|gamemode|filterscript)\b/i;
        const relevant = (r: RepoInfo) =>
            (r.topics ?? []).some((topic) => SIGNAL.test(topic) || topic === 'pawn-package') ||
            SIGNAL.test(r.full_name) ||
            SIGNAL.test(r.description ?? '') ||
            /^(pawn|sourcepawn)$/i.test((r as RepoInfo & { language?: string }).language ?? '');
        const out = new Map<string, RepoInfo & { pawnPackage: boolean }>();
        for (const r of tagged) out.set(r.full_name.toLowerCase(), { ...r, pawnPackage: true });
        for (const r of free.filter(relevant)) {
            if (!out.has(r.full_name.toLowerCase())) out.set(r.full_name.toLowerCase(), { ...r, pawnPackage: false });
        }
        return [...out.values()].sort((a, b) => b.stargazers_count - a.stargazers_count);
    }

    /** Downloads the source code of a ref as a .zip. */
    async downloadSource(owner: string, repo: string, ref: string): Promise<Buffer> {
        const hasToken = !!(await this.token());
        const url = hasToken
            ? `${API}/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`
            : `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
        return this.download(url);
    }

    async download(url: string): Promise<Buffer> {
        const res = await this.request(url, 'application/octet-stream');
        return Buffer.from(await res.arrayBuffer());
    }
}
