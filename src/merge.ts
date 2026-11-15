import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Classification, classify, rerereResolved } from './classify.ts';
import { type Config, unionAttributes } from './config.ts';
import { EMPTY_TREE, git, gitOut, lines, readObject, splitZ } from './git.ts';

/**
 * A tree holding the default branch's files with the union lines added to its root .gitattributes.
 * Merges read attributes from it (`attr.tree`), never from the pull request's own .gitattributes,
 * so a pull request can't mark its own files as safe to union.
 */
export function attributesTree(repo: string, defaultRev: string, config: Config): string {
	const own = readObject(repo, `${defaultRev}:.gitattributes`)?.toString('utf8') ?? '';
	const text = `${own}${own === '' || own.endsWith('\n') ? '' : '\n'}${unionAttributes(config)}`;
	const blob = gitOut(repo, ['hash-object', '-w', '--stdin'], { input: text });
	const env = { ...process.env, GIT_INDEX_FILE: join(tmpdir(), `remain-index-${process.pid}`) };
	try {
		git(repo, ['read-tree', defaultRev], { env });
		git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},.gitattributes`], { env });
		return gitOut(repo, ['write-tree'], { env });
	} finally {
		rmSync(env.GIT_INDEX_FILE, { force: true });
	}
}

/** The settings every merge the bot makes or learns from runs with. */
export function mergeFlags(attrTree: string): string[] {
	return [
		'-c',
		`attr.tree=${attrTree}`,
		'-c',
		'rerere.enabled=true',
		'-c',
		'rerere.autoupdate=true',
		'-c',
		'user.name=remain',
		'-c',
		'user.email=remain@users.noreply.github.com',
		'-c',
		'commit.gpgsign=false',
	];
}

/** The files that conflict when `a` and `b` merge, as GitHub sees it: no attributes, no rerere. */
export function plainConflicts(repo: string, a: string, b: string, attrTree = EMPTY_TREE): string[] {
	const result = git(
		repo,
		['-c', `attr.tree=${attrTree}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', a, b],
		{
			ok: [0, 1],
		},
	);
	return result.code === 0 ? [] : lines(result.stdout).slice(1);
}

export function unmerged(dir: string): string[] {
	return [...new Set(splitZ(gitOut(dir, ['diff', '--name-only', '-z', '--diff-filter=U'])))];
}

export interface Prepared {
	dir: string;
	plain: string[];
	classification: Classification;
}

/**
 * Merges `base` into `head` in a fresh worktree at `dir`, with the union attributes and rerere on,
 * and sorts what's left. The worktree stays mid-merge for the caller to finish or drop.
 */
export function prepare(
	repo: string,
	dir: string,
	head: string,
	base: string,
	attrTree: string,
	config: Config,
): Prepared {
	const plain = plainConflicts(repo, head, base);
	removeWorktree(repo, dir);
	git(repo, ['worktree', 'add', '--force', '--detach', dir, head]);
	const merge = git(dir, [...mergeFlags(attrTree), 'merge', '--no-ff', '--no-commit', base], { ok: 'any' });
	const remaining = unmerged(dir);
	const rerere = rerereResolved(`${merge.stdout}\n${merge.stderr}`);
	return { dir, plain, classification: classify(config, plain, remaining, rerere) };
}

export function removeWorktree(repo: string, dir: string): void {
	git(repo, ['worktree', 'remove', '--force', dir], { ok: 'any' });
	rmSync(dir, { recursive: true, force: true });
	git(repo, ['worktree', 'prune']);
}
