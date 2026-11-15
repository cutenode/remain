import { spawnSync } from 'node:child_process';

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** The empty tree's hash. As attr.tree it makes git read no .gitattributes at all. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060af63bece73b5b6c2b4b9';

/**
 * Variables that point git at a repository. Git exports some of them to hooks, so when a hook runs
 * remain or its tests, every git call would otherwise go to the hook's repository instead of the
 * one in `cwd`.
 */
const REPOSITORY_VARIABLES = new Set([
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_COMMON_DIR',
	'GIT_PREFIX',
	'GIT_NAMESPACE',
	'GIT_QUARANTINE_PATH',
]);

/** This process's environment without the repository variables, plus `extra`, which may set them. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const inherited = Object.entries(process.env).filter(([key]) => !REPOSITORY_VARIABLES.has(key));
	return { ...Object.fromEntries(inherited), ...extra };
}

export interface RunOptions {
	input?: string | Buffer;
	/** The whole environment [default: gitEnv()]. */
	env?: NodeJS.ProcessEnv;
	/** Exit codes that aren't failures (git merge exits 1 on a conflict), or 'any'. */
	ok?: number[] | 'any';
}

function run(command: string, args: string[], cwd: string, options: RunOptions): Result {
	const result = spawnSync(command, args, {
		cwd,
		input: options.input,
		env: options.env ?? gitEnv(),
		encoding: 'utf8',
		maxBuffer: 1 << 30,
	});
	if (result.error) throw result.error;
	const code = result.status ?? 1;
	const ok = options.ok ?? [0];
	if (ok !== 'any' && !ok.includes(code)) {
		throw new Error(`${command} ${args.join(' ')} exited ${code}: ${result.stderr.trim()}`);
	}
	return { code, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs git with hooks off: nothing a pull request's branch holds (or a runner's git config) gets
 * to run code while the bot merges.
 */
export function git(cwd: string, args: string[], options: RunOptions = {}): Result {
	return run('git', ['-c', 'core.hooksPath=/dev/null', ...args], cwd, options);
}

/** git's stdout, trimmed. */
export function gitOut(cwd: string, args: string[], options: RunOptions = {}): string {
	return git(cwd, args, options).stdout.trim();
}

/** A blob's bytes (`<sha>` or `<rev>:<path>`), or undefined when there's no such blob. */
export function readObject(cwd: string, spec: string): Buffer | undefined {
	const result = spawnSync('git', ['cat-file', 'blob', spec], { cwd, env: gitEnv(), maxBuffer: 1 << 30 });
	if (result.error) throw result.error;
	return result.status === 0 ? result.stdout : undefined;
}

/** NUL-separated output split into its entries. */
export function splitZ(text: string): string[] {
	return text.split('\0').filter((entry) => entry !== '');
}

export function lines(text: string): string[] {
	return text.split('\n').filter((line) => line !== '');
}

export function shell(command: string, cwd: string, env: NodeJS.ProcessEnv): Result {
	return run('bash', ['-euo', 'pipefail', '-c', command], cwd, { env, ok: 'any' });
}
