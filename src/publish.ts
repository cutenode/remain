import type { Classification } from './classify.ts';
import { matches } from './config.ts';
import { type GitHubApi, GitHubError } from './github.ts';
import { git, gitOut, readObject, splitZ } from './git.ts';
import { unmerged } from './merge.ts';
import type { PlanFile } from './regen.ts';

/**
 * Finishes the push job's own merge with the merge job's rebuilt files, and returns the merged tree.
 * The merge job ran the pull request's code, so nothing from it is trusted beyond this: each file
 * must belong to a regen rule that has a conflict in this merge, and together they must resolve
 * every conflict. Anything else throws.
 */
export function applyPlan(dir: string, classification: Classification, files: PlanFile[]): string {
	if (classification.owner.length > 0) throw new Error('the merge has conflicts no rule resolves');
	const rules = classification.regen.map((group) => group.rule);
	for (const file of files) {
		if (!rules.some((rule) => matches(rule, file.path))) {
			throw new Error(`the merge job rebuilt ${file.path}, which no conflicting regen rule names`);
		}
		if (file.mode !== '100644' && file.mode !== '100755') throw new Error(`${file.path} has mode ${String(file.mode)}`);
		if (file.content === null) {
			git(dir, ['update-index', '--force-remove', '--', file.path]);
			continue;
		}
		const blob = gitOut(dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from(file.content, 'base64') });
		git(dir, ['update-index', '--add', '--cacheinfo', `${file.mode},${blob},${file.path}`]);
	}
	const left = unmerged(dir);
	if (left.length > 0) throw new Error(`still conflicting: ${left.join(', ')}`);
	return gitOut(dir, ['write-tree']);
}

export interface TreeEntry {
	path: string;
	mode: string;
	type: 'blob' | 'commit';
	sha: string | null;
}

/** How `tree` differs from `head`'s tree, as entries for the git trees API. */
export function treeChanges(dir: string, head: string, tree: string): TreeEntry[] {
	const fields = splitZ(gitOut(dir, ['diff-tree', '-r', '-z', '--no-renames', head, tree]));
	const entries: TreeEntry[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [oldMode = '', newMode = '', , sha = '', status = ''] = (fields[i] ?? '').slice(1).split(' ');
		const path = fields[i + 1] ?? '';
		if (status === 'D') entries.push({ path, mode: oldMode, type: 'blob', sha: null });
		else entries.push({ path, mode: newMode, type: newMode === '160000' ? 'commit' : 'blob', sha });
	}
	return entries;
}

/** Every blob in a commit's tree. */
function blobs(dir: string, rev: string): Set<string> {
	return new Set(
		splitZ(gitOut(dir, ['ls-tree', '-r', '-z', rev])).map((line) => line.split('\t')[0]?.split(' ')[2] ?? ''),
	);
}

export interface Published {
	sha: string;
	verified: boolean;
	reason: string;
}

/**
 * Writes the merge commit through GitHub's git data API, so GitHub signs it as the App, then moves
 * the pull request's branch to it without force. Only blobs neither parent has are uploaded. Returns
 * undefined when the branch moved since (someone pushed): the next run starts over from the new head.
 */
export function publish(
	github: Pick<GitHubApi, 'api'>,
	dir: string,
	branch: string,
	parents: [string, string],
	tree: string,
	message: string,
): Published | undefined {
	const entries = treeChanges(dir, parents[0], tree);
	const known = new Set([...blobs(dir, parents[0]), ...blobs(dir, parents[1])]);
	for (const entry of entries) {
		if (entry.type !== 'blob' || entry.sha === null || known.has(entry.sha)) continue;
		const content = readObject(dir, entry.sha)?.toString('base64');
		if (content === undefined) throw new Error(`no blob ${entry.sha} for ${entry.path}`);
		const blob = github.api<{ sha: string }>('POST', 'git/blobs', { content, encoding: 'base64' });
		if (blob.sha !== entry.sha) throw new Error(`GitHub stored ${entry.path} as ${blob.sha}, not ${entry.sha}`);
		known.add(entry.sha);
	}
	// The trees API takes the changes in batches, each on top of the tree the last one made.
	let built = gitOut(dir, ['rev-parse', `${parents[0]}^{tree}`]);
	for (let i = 0; i < entries.length; i += 500) {
		built = github.api<{ sha: string }>('POST', 'git/trees', { base_tree: built, tree: entries.slice(i, i + 500) }).sha;
	}
	if (built !== tree) throw new Error(`GitHub built tree ${built}, not the merged ${tree}`);
	const commit = github.api<{ sha: string; verification: { verified: boolean; reason: string } }>(
		'POST',
		'git/commits',
		{
			message,
			tree,
			parents,
		},
	);
	try {
		github.api('PATCH', `git/refs/heads/${branch}`, { sha: commit.sha, force: false });
	} catch (error) {
		if (error instanceof GitHubError && error.status === 422) return undefined;
		throw error;
	}
	return { sha: commit.sha, verified: commit.verification.verified, reason: commit.verification.reason };
}
