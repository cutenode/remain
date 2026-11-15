import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitOut, lines } from './git.ts';
import { mergeFlags, plainConflicts, removeWorktree } from './merge.ts';

/** Merges already learned from, kept in the rr-cache so a restored cache isn't learned again. */
function trainedFile(repo: string): string {
	return join(gitOut(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'rr-cache', 'trained');
}

/**
 * Teaches rerere the resolutions in `merges`, the way git's contrib/rerere-train.sh does: redo each
 * merge, let rerere record the conflict, then show it the merge's committed result. Merges that
 * replay without a conflict are skipped before any checkout, since there's nothing to learn and
 * most of a repository's merges are clean ones.
 */
export function train(repo: string, dir: string, merges: string[], attrTree: string): string[] {
	const file = trainedFile(repo);
	mkdirSync(join(file, '..'), { recursive: true });
	const done = new Set(existsSync(file) ? lines(readFileSync(file, 'utf8')) : []);
	const learned: string[] = [];
	let worktree = false;
	try {
		for (const merge of merges) {
			if (done.has(merge)) continue;
			done.add(merge);
			appendFileSync(file, `${merge}\n`);
			const parents = gitOut(repo, ['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1);
			if (parents.length !== 2) continue;
			const [ours = '', theirs = ''] = parents;
			if (plainConflicts(repo, ours, theirs, attrTree).length === 0) continue;
			if (!worktree) {
				removeWorktree(repo, dir);
				git(repo, ['worktree', 'add', '--force', '--detach', dir, ours]);
				worktree = true;
			}
			git(dir, ['checkout', '--quiet', '--force', '--detach', ours]);
			git(dir, [...mergeFlags(attrTree), 'merge', '--no-ff', '--no-commit', theirs], { ok: 'any' });
			git(dir, ['checkout', merge, '--', '.']);
			git(dir, [...mergeFlags(attrTree), 'rerere']);
			git(dir, ['merge', '--abort'], { ok: 'any' });
			git(dir, ['reset', '--quiet', '--hard']);
			learned.push(merge);
		}
	} finally {
		if (worktree) removeWorktree(repo, dir);
	}
	return learned;
}

/** The default branch's merges since `since`, oldest first. */
export function defaultBranchMerges(repo: string, rev: string, since: string): string[] {
	return lines(gitOut(repo, ['rev-list', '--merges', '--reverse', `--since=${since}`, rev]));
}

/** The merges on a pull request's branch up to `approved`, that aren't on the default branch yet. */
export function approvedMerges(repo: string, approved: string, defaultRev: string): string[] {
	return lines(gitOut(repo, ['rev-list', '--merges', '--reverse', approved, `^${defaultRev}`]));
}
