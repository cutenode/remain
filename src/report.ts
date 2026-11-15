import type { Classification } from './classify.ts';
import type { Pull } from './select.ts';

/** Starts the one comment the bot keeps on a pull request, so later runs edit it in place. */
export const MARKER = '<!-- remain -->';

const finish = (lines: string[]): string => lines.join('\n').trimEnd();

const code = (path: string): string => `\`${path}\``;

function resolvedLines(classification: Classification): string[] {
	return [
		...classification.union.map((path) => `- ${code(path)}: kept both sides' lines`),
		...classification.rerere.map((path) => `- ${code(path)}: replayed an earlier reviewed resolution`),
		...classification.regen.flatMap((group) =>
			group.paths.map((path) => `- ${code(path)}: rebuilt with ${code(group.rule.regen ?? '')}`),
		),
	];
}

export function ownerComment(base: string, classification: Classification): string {
	const groups = classification.owner.flatMap((group) => [
		`**${group.cause}**`,
		...group.paths.map((path) => `- ${code(path)}`),
		'',
	]);
	const resolved = resolvedLines(classification);
	return finish([
		MARKER,
		`\`${base}\` can't be merged in automatically. These files need you:`,
		'',
		...groups,
		...(resolved.length > 0 ? ['These would have been resolved:', '', ...resolved] : []),
	]);
}

export function failedComment(base: string, error: string, runUrl: string): string {
	return finish([MARKER, `\`${base}\` can't be merged in automatically: ${error}. [Run](${runUrl})`]);
}

export function pushedComment(base: string, sha: string, classification: Classification): string {
	return finish([MARKER, `Merged \`${base}\` in with ${sha.slice(0, 9)}:`, '', ...resolvedLines(classification)]);
}

export function clearedComment(): string {
	return finish([MARKER, 'No conflicts left.']);
}

export interface DigestEntry {
	number: number;
	title: string;
	url: string;
	/** What changed since the last approval. */
	compare: string;
	ci: 'passing' | 'failing' | 'pending';
}

export function ciState(pull: Pull): DigestEntry['ci'] {
	if (pull.ci === 'SUCCESS') return 'passing';
	if (pull.ci === 'FAILURE' || pull.ci === 'ERROR') return 'failing';
	return 'pending';
}

/**
 * The commits since the newest commit an approver approved (approvals GitHub dismissed on a push
 * count too), or undefined when there's none on the branch. An approved commit that's gone from the
 * branch (a force-push) doesn't count: nothing after it can be trusted.
 */
export function sinceApproval(pull: Pull, approvers: string[]): { approved: string; since: string[] } | undefined {
	const approved = new Set(
		pull.approvals.filter((approval) => approvers.includes(approval.login)).map((approval) => approval.oid),
	);
	const index = pull.commits.findLastIndex((oid) => approved.has(oid));
	if (index === -1) return undefined;
	return { approved: pull.commits[index] ?? '', since: pull.commits.slice(index + 1) };
}

/**
 * Pull requests where everything since an approver's last approval is the bot's own merges, so
 * re-approving them is all they need. `isOwn` decides which commits are the bot's. One with anyone
 * else's commits since, or whose approved commit is gone, isn't listed: it needs a full review.
 */
export function digest(pulls: Pull[], approvers: string[], isOwn: (sha: string) => boolean): DigestEntry[] {
	const entries: DigestEntry[] = [];
	for (const pull of pulls) {
		const range = sinceApproval(pull, approvers);
		if (!range || range.since.length === 0) continue;
		if (!range.since.every(isOwn)) continue;
		const repoUrl = pull.url.replace(/\/pull\/\d+$/, '');
		entries.push({
			number: pull.number,
			title: pull.title,
			url: pull.url,
			compare: `${repoUrl}/compare/${range.approved}...${pull.headRefOid}`,
			ci: ciState(pull),
		});
	}
	return entries.toSorted((a, b) => a.number - b.number);
}

export function renderDigest(entries: DigestEntry[]): string {
	if (entries.length === 0) return 'Nothing to re-approve.\n';
	return [
		'| Pull request | CI | Since your approval |',
		'| --- | --- | --- |',
		...entries.map(
			(entry) =>
				`| [#${entry.number}](${entry.url}) ${entry.title.replaceAll('|', '\\|')} | ${entry.ci} | [changes](${entry.compare}) |`,
		),
		'',
	].join('\n');
}
