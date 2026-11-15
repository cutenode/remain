import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, gitOut } from '../src/git.ts';

// The machine's own git config (signing, rerere, conflict styles) stays out of the tests.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

/** Git with an identity and no signing. */
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

export interface Repo {
	dir: string;
	/** Writes files (null deletes one) and commits them, returning the commit. */
	commit(files: Record<string, string | null>, message?: string, options?: { executable?: string[] }): string;
	checkout(rev: string, create?: boolean): void;
	git(...args: string[]): string;
	cleanup(): void;
}

export function tempDir(prefix = 'remain-test-'): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function makeRepo(): Repo {
	const root = tempDir();
	const dir = join(root, 'repo');
	mkdirSync(dir);
	git(dir, ['init', '--quiet', '--initial-branch=main']);
	return {
		dir,
		commit(files, message = 'change', options = {}) {
			for (const [path, content] of Object.entries(files)) {
				const full = join(dir, path);
				if (content === null) {
					rmSync(full, { force: true });
					continue;
				}
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
				if (options.executable?.includes(path)) chmodSync(full, 0o755);
			}
			git(dir, ['add', '--all']);
			git(dir, [...IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', message]);
			return gitOut(dir, ['rev-parse', 'HEAD']);
		},
		checkout(rev, create = false) {
			git(dir, create ? ['checkout', '--quiet', '-b', rev] : ['checkout', '--quiet', rev]);
		},
		git(...args) {
			return gitOut(dir, [...IDENTITY, ...args]);
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * Commits a merge of `theirs` into the current branch, resolving every conflict with `resolved`.
 * Stands for a merge someone made by hand.
 */
export function handMerge(repo: Repo, theirs: string, resolved: Record<string, string>): string {
	git(repo.dir, [...IDENTITY, 'merge', '--no-ff', '--no-commit', theirs], { ok: [0, 1] });
	for (const [path, content] of Object.entries(resolved)) writeFileSync(join(repo.dir, path), content);
	git(repo.dir, ['add', '--all']);
	git(repo.dir, [...IDENTITY, 'commit', '--quiet', '--no-edit']);
	return gitOut(repo.dir, ['rev-parse', 'HEAD']);
}
