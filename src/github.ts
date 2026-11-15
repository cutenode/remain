import { spawnSync } from 'node:child_process';
import type { Pull } from './select.ts';

/**
 * The open pull requests, with what the bot reads of each. Approvals GitHub dismissed on a later
 * push come from the timeline, since the review itself then only says DISMISSED.
 */
const PULLS_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $endCursor) {
      nodes {
        number title url headRefName headRefOid baseRefName mergeStateStatus isCrossRepository
        labels(first: 50) { nodes { name } }
        reviews(states: APPROVED, last: 100) { nodes { author { login } commit { oid } } }
        timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], last: 100) {
          nodes { ... on ReviewDismissedEvent { previousReviewState review { author { login } commit { oid } } } }
        }
        commits(last: 100) { nodes { commit { oid statusCheckRollup { state } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PULLS_JQ = `.data.repository.pullRequests.nodes[] | {
  number, title, url, headRefName, headRefOid, baseRefName, mergeStateStatus, isCrossRepository,
  labels: [.labels.nodes[].name],
  approvals: ([.reviews.nodes[] | select(.commit != null) | {login: (.author.login // ""), oid: .commit.oid}]
    + [.timelineItems.nodes[] | select(.previousReviewState == "APPROVED" and .review.commit != null)
       | {login: (.review.author.login // ""), oid: .review.commit.oid}]),
  commits: [.commits.nodes[].commit.oid],
  ci: (.commits.nodes[-1].commit.statusCheckRollup.state // null)
}`;

export class GitHubError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status: number | undefined) {
		super(message);
		this.status = status;
	}
}

/** What the bot asks of GitHub. */
export interface GitHubApi {
	readonly repo: string;
	api<T>(method: string, path: string, body?: unknown): T;
	list<T>(path: string): T[];
	pulls(): Pull[];
	defaultBranch(): string;
}

/** GitHub through the gh CLI, which every GitHub-hosted runner has. */
export class GitHub implements GitHubApi {
	readonly repo: string;
	readonly #token: string;

	constructor(repo: string, token: string) {
		this.repo = repo;
		this.#token = token;
	}

	private gh(args: string[], input?: string): string {
		const result = spawnSync('gh', args, {
			input,
			encoding: 'utf8',
			maxBuffer: 1 << 30,
			env: { ...process.env, GH_TOKEN: this.#token, GH_PROMPT_DISABLED: '1' },
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const status = /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1];
			throw new GitHubError(
				`gh ${args.slice(0, 3).join(' ')}: ${result.stderr.trim()}`,
				status ? Number(status) : undefined,
			);
		}
		return result.stdout;
	}

	/** Each line of output as JSON. */
	private jsonLines<T>(out: string): T[] {
		return out
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line) as T);
	}

	/** A REST call against this repository: `path` is relative to `repos/<owner>/<name>/`. */
	api<T>(method: string, path: string, body?: unknown): T {
		const args = ['api', '--method', method, `repos/${this.repo}/${path}`];
		if (body !== undefined) args.push('--input', '-');
		const out = this.gh(args, body === undefined ? undefined : JSON.stringify(body));
		return (out.trim() === '' ? undefined : JSON.parse(out)) as T;
	}

	/** Every page of a REST list. */
	list<T>(path: string): T[] {
		return this.jsonLines<T>(this.gh(['api', '--paginate', '--jq', '.[]', `repos/${this.repo}/${path}`]));
	}

	pulls(): Pull[] {
		const [owner = '', name = ''] = this.repo.split('/');
		const args = ['api', 'graphql', '--paginate', '-f', `owner=${owner}`, '-f', `name=${name}`];
		return this.jsonLines<Pull>(this.gh([...args, '-f', `query=${PULLS_QUERY}`, '--jq', PULLS_JQ]));
	}

	defaultBranch(): string {
		return this.gh(['repo', 'view', this.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
	}
}
