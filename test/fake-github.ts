import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type GitHubApi, GitHubError } from '../src/github.ts';
import { git, gitOut, lines } from '../src/git.ts';
import type { Pull } from '../src/select.ts';
import { tempDir } from './repo.ts';

interface TreeBody {
	base_tree: string;
	tree: { path: string; mode: string; type: string; sha: string | null }[];
}

interface Comment {
	id: number;
	body: string;
	user: { login: string };
}

/**
 * GitHub over a local bare repository: the git data API, pull requests, comments and labels, with
 * GitHub's rules that matter here (a tree can only name objects the repository has, a ref update
 * without force must fast-forward, and a pull request's commits are those its base doesn't have).
 */
export class FakeGitHub implements GitHubApi {
	readonly repo = 'o/r';
	readonly remote: string;
	readonly calls: string[] = [];
	readonly comments = new Map<number, Comment[]>();
	/** Calls (`METHOD path`) that fail with this HTTP status. */
	readonly failures = new Map<string, number>();
	pullList: Pull[] = [];
	readonly ids = { next: 1 };
	/** Whether GitHub signs the commits made through the API, which nobody knows yet for an App. */
	readonly signing = { on: false };
	/** Who made each commit through the API, and whether it was signed. */
	readonly made = new Map<string, { login: string; verified: boolean }>();
	author: string;

	constructor(remote: string, author = 'github-actions[bot]') {
		this.remote = remote;
		this.author = author;
	}

	/** The same repository as another login sees it, sharing its state. */
	as(author: string): FakeGitHub {
		const other = Object.create(this) as FakeGitHub;
		other.author = author;
		return other;
	}

	defaultBranch(): string {
		return 'main';
	}

	pulls(): Pull[] {
		return this.pullList.map((pull) => {
			if (pull.isCrossRepository) return pull;
			const head = gitOut(this.remote, ['rev-parse', `refs/heads/${pull.headRefName}`]);
			const commits = lines(gitOut(this.remote, ['rev-list', '--reverse', head, `^refs/heads/${pull.baseRefName}`]));
			return { ...pull, headRefOid: head, commits };
		});
	}

	list<T>(path: string): T[] {
		const number = Number(/^issues\/(\d+)\/comments$/.exec(path)?.[1]);
		return (this.comments.get(number) ?? []) as T[];
	}

	api<T>(method: string, path: string, body?: unknown): T {
		this.calls.push(`${method} ${path}`);
		const failure = this.failures.get(`${method} ${path}`);
		if (failure) throw new GitHubError(`${method} ${path} failed (HTTP ${failure})`, failure);
		const remote = this.remote;
		if (method === 'POST' && path === 'git/blobs') {
			const { content } = body as { content: string };
			return { sha: gitOut(remote, ['hash-object', '-w', '--stdin'], { input: Buffer.from(content, 'base64') }) } as T;
		}
		if (method === 'POST' && path === 'git/trees') {
			const { base_tree, tree } = body as TreeBody;
			const scratch = tempDir();
			const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_WORK_TREE: scratch };
			try {
				git(remote, ['read-tree', base_tree], { env });
				for (const entry of tree) {
					if (entry.sha === null) git(remote, ['update-index', '--force-remove', '--', entry.path], { env });
					else
						git(remote, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`], { env });
				}
				return { sha: gitOut(remote, ['write-tree'], { env }) } as T;
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		}
		if (method === 'POST' && path === 'git/commits') {
			const { message, tree, parents } = body as { message: string; tree: string; parents: string[] };
			const args = ['-c', 'user.name=app', '-c', 'user.email=app@example.com', 'commit-tree', tree, '-m', message];
			const sha = gitOut(remote, [...args, ...parents.flatMap((parent) => ['-p', parent])]);
			const verified = this.signing.on;
			this.made.set(sha, { login: this.author, verified });
			return { sha, verification: { verified, reason: verified ? 'valid' : 'unsigned' } } as T;
		}
		const commit = /^commits\/([0-9a-f]{40})$/.exec(path)?.[1];
		if (method === 'GET' && commit) {
			// A commit pushed with git is unsigned here, whatever its author and committer say.
			const made = this.made.get(commit) ?? { login: 'someone', verified: false };
			return { committer: { login: made.login }, commit: { verification: { verified: made.verified } } } as T;
		}
		const ref = /^git\/refs\/(heads\/.+)$/.exec(path)?.[1];
		if (method === 'PATCH' && ref) {
			const { sha, force } = body as { sha: string; force: boolean };
			const old = gitOut(remote, ['rev-parse', `refs/${ref}`]);
			const fastForward = git(remote, ['merge-base', '--is-ancestor', old, sha], { ok: [0, 1] }).code === 0;
			if (!force && !fastForward) throw new GitHubError('Update is not a fast forward (HTTP 422)', 422);
			git(remote, ['update-ref', `refs/${ref}`, sha]);
			return { ref: `refs/${ref}` } as T;
		}
		const issue = /^issues\/(\d+)\/(comments|labels)(?:\/(.+))?$/.exec(path);
		const number = Number(issue?.[1]);
		const pull = this.pullList.find((item) => item.number === number);
		if (method === 'POST' && issue?.[2] === 'comments') {
			const comment = { id: this.ids.next++, body: (body as { body: string }).body, user: { login: this.author } };
			this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
			return comment as T;
		}
		const edited = /^issues\/comments\/(\d+)$/.exec(path);
		if (method === 'PATCH' && edited) {
			const comment = [...this.comments.values()].flat().find((item) => item.id === Number(edited[1]));
			if (!comment) throw new GitHubError('Not Found (HTTP 404)', 404);
			comment.body = (body as { body: string }).body;
			return comment as T;
		}
		if (method === 'POST' && issue?.[2] === 'labels' && pull) {
			pull.labels = [...new Set([...pull.labels, ...(body as { labels: string[] }).labels])];
			return [] as T;
		}
		if (method === 'DELETE' && issue?.[2] === 'labels' && pull) {
			const label = decodeURIComponent(issue[3] ?? '');
			if (!pull.labels.includes(label)) throw new GitHubError('Label does not exist (HTTP 404)', 404);
			pull.labels = pull.labels.filter((item) => item !== label);
			return undefined as T;
		}
		throw new Error(`fake GitHub has no ${method} ${path}`);
	}
}
