import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequestLogger } from 'evlog';
import { isMechanical } from './classify.ts';
import { type Config, parseConfig } from './config.ts';
import { type GitHubApi, GitHubError } from './github.ts';
import { git, gitOut, readObject } from './git.ts';
import { annotate, classificationFields, type PullEvent, pullEvent } from './log.ts';
import { attributesTree, type Prepared, prepare, removeWorktree } from './merge.ts';
import { applyPlan, publish } from './publish.ts';
import { type PlanFile, regenerate } from './regen.ts';
import {
	clearedComment,
	digest,
	failedComment,
	MARKER,
	ownerComment,
	pushedComment,
	renderDigest,
	sinceApproval,
} from './report.ts';
import { approvedMerges, defaultBranchMerges, train } from './rerere.ts';
import { type Pick, type Pull, select } from './select.ts';

export interface Options {
	/** A checkout of the repository, with `origin` pointing at GitHub. */
	repo: string;
	github: GitHubApi;
	/** Push mode: GitHub as the App, which writes the merge commits, and the App's bot login. */
	app?: { github: GitHubApi; login: string };
	/** The branch merged into pull requests based on it, and the one the config is read from. */
	base?: string;
	/** For fetching; sent in a header for each fetch, never saved in .git/config. */
	token: string;
	server: string;
	scratch: string;
	config: string;
	plans: string;
	digest: string;
	commentAuthor: string;
	runUrl: string;
	summary?: string;
	/** Merge mode: the one pull request to rebuild files for, so each runs in a job of its own. */
	pull?: number;
	/** List mode: the step's GITHUB_OUTPUT file. */
	output?: string;
}

export type Mode = 'list' | 'merge' | 'push';

/** What the merge job hands the push job for one pull request. */
interface Plan {
	number: number;
	head: string;
	base: string;
	ok: boolean;
	files: PlanFile[];
}

interface Context {
	options: Options;
	config: Config;
	defaultBranch: string;
	attrTree: string;
	pulls: Pull[];
	picks: Pick[];
}

const DEFAULT_REF = 'refs/remain/default';
const headRef = (number: number) => `refs/remain/pull/${number}`;
const baseRef = (pull: Pull, defaultBranch: string) =>
	pull.baseRefName === defaultBranch ? DEFAULT_REF : `refs/remain/base/${pull.number}`;

function fetch(options: Options, refspecs: string[]): void {
	const auth = Buffer.from(`x-access-token:${options.token}`).toString('base64');
	const header = `http.${options.server}/.extraheader=AUTHORIZATION: basic ${auth}`;
	git(options.repo, ['-c', header, 'fetch', '--quiet', '--no-tags', '--force', 'origin', ...refspecs]);
}

/**
 * What both modes start from: the base branch's config, the pull requests to merge into, and the
 * resolutions learned from merges already reviewed.
 */
function setup(options: Options): Context {
	const { repo, github } = options;
	const event = createRequestLogger();
	const defaultBranch = options.base ?? github.defaultBranch();
	const pulls = github.pulls();
	const sameRepo = pulls.filter((pull) => !pull.isCrossRepository);
	event.set({ base: defaultBranch, pulls: pulls.length });
	fetch(options, [
		`+refs/heads/${defaultBranch}:${DEFAULT_REF}`,
		...sameRepo.map((pull) => `+refs/pull/${pull.number}/head:${headRef(pull.number)}`),
		...sameRepo
			.filter((pull) => pull.baseRefName !== defaultBranch)
			.map((pull) => `+refs/heads/${pull.baseRefName}:${baseRef(pull, defaultBranch)}`),
	]);
	const configText = readObject(repo, `${DEFAULT_REF}:${options.config}`);
	if (!configText) throw new Error(`${defaultBranch} has no ${options.config}`);
	const config = parseConfig(configText.toString('utf8'));
	const attrTree = attributesTree(repo, DEFAULT_REF, config);

	const merges = [
		...defaultBranchMerges(repo, DEFAULT_REF, config.since),
		...sameRepo.flatMap((pull) => {
			const range = sinceApproval(pull, config.approvers);
			return range ? approvedMerges(repo, range.approved, DEFAULT_REF) : [];
		}),
	];
	const learned = train(repo, join(options.scratch, 'train'), [...new Set(merges)], attrTree);
	const picks = select(pulls, defaultBranch);
	event.set({ rerere: { merges: merges.length, learned: learned.length }, dirty: picks.length });
	event.emit();
	return { options, config, defaultBranch, attrTree, pulls, picks };
}

/** Merges a picked pull request's base in, in its own worktree, or says why it can't. */
function prepared(context: Context, pull: Pull): Prepared | string {
	const { repo, scratch } = context.options;
	const head = gitOut(repo, ['rev-parse', headRef(pull.number)]);
	if (head !== pull.headRefOid) return `its head moved to ${head.slice(0, 9)} while this ran`;
	const base = gitOut(repo, ['rev-parse', baseRef(pull, context.defaultBranch)]);
	// GitHub's DIRTY can trail a push that already merged the base in.
	const hasBase = git(repo, ['merge-base', '--is-ancestor', base, head], { ok: [0, 1] }).code === 0;
	if (hasBase) return `it already has ${pull.baseRefName}`;
	return prepare(repo, join(scratch, String(pull.number)), head, base, context.attrTree, context.config);
}

/**
 * Merges one pull request's base in and, when every conflict is mechanical and some file needs
 * rebuilding, returns its number. With `rebuild` it also runs the regen commands and writes the plan
 * the push job reads.
 */
function mergeOne(context: Context, pick: Pick, event: PullEvent, rebuild: boolean): number | undefined {
	const { options } = context;
	const { pull } = pick;
	const result = pick.action === 'skip' ? pick.reason : prepared(context, pull);
	if (typeof result === 'string') {
		event.set({ skipped: result });
		return undefined;
	}
	try {
		const { classification } = result;
		event.set(classificationFields(classification));
		if (!isMechanical(classification) || classification.regen.length === 0) return undefined;
		if (!rebuild) return pull.number;
		const base = gitOut(result.dir, ['rev-parse', 'MERGE_HEAD']);
		const plan: Plan = { number: pull.number, head: pull.headRefOid, base, ok: true, files: [] };
		for (const group of classification.regen) {
			const outcome = regenerate(result.dir, { ...group.rule, regen: group.rule.regen ?? '' }, group.paths, base);
			if (!outcome.ok) {
				event.warn(outcome.error, { rule: group.rule.cause });
				annotate('warning', `#${pull.number}: ${outcome.error}`);
				plan.ok = false;
				plan.files = [];
				break;
			}
			plan.files.push(...outcome.files);
		}
		event.set({ rebuilt: plan.files.map((file) => file.path), regenerated: plan.ok });
		writeFileSync(join(options.plans, `${pull.number}.json`), JSON.stringify(plan));
		return pull.number;
	} finally {
		removeWorktree(options.repo, result.dir);
	}
}

/** Runs `each` on the picks, with one wide event per pull request. */
function eachPick<T>(picks: Pick[], mode: Mode, each: (pick: Pick, event: PullEvent) => T): T[] {
	return picks.map((pick) => {
		const event = pullEvent(mode, pick.pull);
		try {
			return each(pick, event);
		} catch (error) {
			event.error(error as Error);
			throw error;
		} finally {
			event.emit();
		}
	});
}

/**
 * The pull requests with files to rebuild, for the caller's matrix of merge jobs. Listing runs no
 * repository code: git merges with hooks off and no drivers but union.
 */
function listMode(context: Context): void {
	const pulls = eachPick(context.picks, 'list', (pick, event) => mergeOne(context, pick, event, false)).filter(
		(number) => number !== undefined,
	);
	if (context.options.output) appendFileSync(context.options.output, `pulls=${JSON.stringify(pulls)}\n`);
}

/**
 * Rebuilds one pull request's files. Each runs in its own job, so one pull request's regen command,
 * which is its own code, can't touch the files rebuilt for another.
 */
function mergeMode(context: Context): void {
	const { options } = context;
	if (options.pull === undefined) throw new Error('merge mode needs pull');
	mkdirSync(options.plans, { recursive: true });
	const picks = context.picks.filter((pick) => pick.pull.number === options.pull);
	eachPick(picks, 'merge', (pick, event) => mergeOne(context, pick, event, true));
}

interface IssueComment {
	id: number;
	body: string;
	user: { login: string } | null;
}

/** The bot's own comment on a pull request, found by its marker and author. */
function ownComment(context: Context, number: number): IssueComment | undefined {
	const { github, commentAuthor } = context.options;
	return github
		.list<IssueComment>(`issues/${number}/comments`)
		.find((comment) => comment.user?.login === commentAuthor && comment.body.startsWith(MARKER));
}

function upsertComment(github: GitHubApi, number: number, existing: IssueComment | undefined, body: string): void {
	if (existing?.body === body) return;
	if (existing) github.api('PATCH', `issues/comments/${existing.id}`, { body });
	else github.api('POST', `issues/${number}/comments`, { body });
}

function setLabel(github: GitHubApi, pull: Pull, label: string, on: boolean): void {
	const has = pull.labels.includes(label);
	if (on && !has) github.api('POST', `issues/${pull.number}/labels`, { labels: [label] });
	if (on || !has) return;
	try {
		github.api('DELETE', `issues/${pull.number}/labels/${encodeURIComponent(label)}`);
	} catch (error) {
		if (!(error instanceof GitHubError && error.status === 404)) throw error;
	}
}

function readPlan(options: Options, number: number): Plan | undefined {
	const file = join(options.plans, `${number}.json`);
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Plan) : undefined;
}

function pushOne(context: Context, appGitHub: GitHubApi, pull: Pull, event: PullEvent): void {
	const { options, config } = context;
	const { github } = options;
	const comment = ownComment(context, pull.number);
	const needsOwner = (body: string) => {
		event.set({ outcome: 'needs owner' });
		setLabel(github, pull, config.label, true);
		upsertComment(github, pull.number, comment, body);
	};
	const result = prepared(context, pull);
	if (typeof result === 'string') {
		event.set({ skipped: result });
		return;
	}
	try {
		const { classification } = result;
		event.set(classificationFields(classification));
		if (!isMechanical(classification)) {
			needsOwner(ownerComment(pull.baseRefName, classification));
			return;
		}
		const base = gitOut(result.dir, ['rev-parse', 'MERGE_HEAD']);
		let files: PlanFile[] = [];
		if (classification.regen.length > 0) {
			const plan = readPlan(options, pull.number);
			if (!plan || plan.head !== pull.headRefOid || plan.base !== base) {
				event.set({ skipped: 'the merge job left no rebuilt files for this head' });
				return;
			}
			if (!plan.ok) {
				needsOwner(failedComment(pull.baseRefName, 'rebuilding a generated file failed', options.runUrl));
				return;
			}
			files = plan.files;
		}
		const tree = applyPlan(result.dir, classification, files);
		const message = `Merge branch '${pull.baseRefName}' into ${pull.headRefName}`;
		const published = publish(appGitHub, result.dir, pull.headRefName, [pull.headRefOid, base], tree, message);
		if (!published) {
			event.set({ skipped: 'the branch moved before the push' });
			return;
		}
		event.set({ outcome: 'pushed', commit: published.sha, verified: published.verified });
		const signature = published.verified ? 'verified' : `not verified (${published.reason})`;
		annotate('notice', `#${pull.number}: merged ${pull.baseRefName} in with ${published.sha}, signature ${signature}`);
		setLabel(github, pull, config.label, false);
		const body = pushedComment(pull.baseRefName, published.sha, classification);
		upsertComment(github, pull.number, comment, body);
	} finally {
		removeWorktree(options.repo, result.dir);
	}
}

interface CommitInfo {
	committer: { login: string } | null;
	commit: { verification: { verified: boolean } };
}

/**
 * Whether the App made `sha`: GitHub verified its signature and its committer is the App's bot.
 * GitHub only signs an API commit for the identity that made it, and nobody else can make one as the
 * App, while a commit's author and committer emails can say anything. A comment by the workflow's
 * token can't be the record either, since any workflow in the repository can post as that bot.
 */
function isOwnCommit(github: GitHubApi, login: string, sha: string): boolean {
	const info = github.api<CommitInfo>('GET', `commits/${sha}`);
	return info.commit.verification.verified && info.committer?.login === login;
}

function pushMode(context: Context): void {
	const { options, config } = context;
	const { github, app } = options;
	if (!app) throw new Error('push mode needs app-token and app-slug');
	eachPick(context.picks, 'push', (pick, event) => {
		const { pull } = pick;
		if (pick.action === 'merge') return pushOne(context, app.github, pull, event);
		event.set({ skipped: pick.reason });
		if (!pull.isCrossRepository) return;
		const comment = ownComment(context, pull.number);
		setLabel(github, pull, config.label, true);
		upsertComment(github, pull.number, comment, failedComment(pull.baseRefName, pick.reason, options.runUrl));
	});

	// A pull request its owner resolved since loses the label.
	for (const pull of context.pulls) {
		if (!pull.labels.includes(config.label) || pull.mergeStateStatus === 'DIRTY') continue;
		const comment = ownComment(context, pull.number);
		setLabel(github, pull, config.label, false);
		if (comment) upsertComment(github, pull.number, comment, clearedComment());
	}

	const entries = digest(github.pulls(), config.approvers, (sha) => isOwnCommit(github, app.login, sha));
	const markdown = renderDigest(entries);
	mkdirSync(options.digest, { recursive: true });
	writeFileSync(join(options.digest, 'digest.md'), markdown);
	writeFileSync(join(options.digest, 'digest.json'), `${JSON.stringify(entries, null, '\t')}\n`);
	if (options.summary) appendFileSync(options.summary, `## Re-approve\n\n${markdown}`);
}

const modes: Record<Mode, (context: Context) => void> = { list: listMode, merge: mergeMode, push: pushMode };

export function run(mode: Mode, options: Options): void {
	mkdirSync(options.scratch, { recursive: true });
	modes[mode](setup(options));
}
