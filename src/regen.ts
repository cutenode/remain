import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Rule, matches } from './config.ts';
import { git, gitOut, readObject, shell, splitZ } from './git.ts';

/** A rebuilt file as the push job takes it: its new bytes and mode, or null when it's gone. */
export interface PlanFile {
	path: string;
	mode: '100644' | '100755';
	content: string | null;
}

export type RegenResult = { ok: true; files: PlanFile[] } | { ok: false; error: string };

/** Everything a command left different from the index: changed, deleted and new files. */
function changed(dir: string): string[] {
	const modified = splitZ(gitOut(dir, ['diff', '--name-only', '-z']));
	const added = splitZ(gitOut(dir, ['ls-files', '--others', '--exclude-standard', '-z']));
	return [...new Set([...modified, ...added])].toSorted();
}

/**
 * The environment a regenerate command gets: the job's, less anything that could act for the job.
 * The merge job holds no secrets, but its inputs and the runner's own tokens are still in the
 * environment, and the command is the pull request's code.
 */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([key]) => !/^(INPUT_|ACTIONS_)|TOKEN|SECRET|PASSWORD|_KEY$/i.test(key)),
	);
}

/**
 * Rebuilds one rule's conflicting files: takes the base's copy of each (so the index has no
 * conflict left), runs the rule's command, and stages what it wrote. Fails when the command fails,
 * writes a file outside the rule's paths, or writes something different on a second run (its output
 * isn't settled, so it can't be trusted to be what a fresh checkout would make).
 */
export function regenerate(
	dir: string,
	rule: Rule & { regen: string },
	conflicts: string[],
	base: string,
): RegenResult {
	for (const path of conflicts) {
		if (readObject(dir, `${base}:${path}`) === undefined) git(dir, ['rm', '--quiet', '--force', '--', path]);
		else git(dir, ['checkout', base, '--', path]);
	}
	const env = commandEnv(process.env);
	const written = new Set<string>();
	for (const pass of [1, 2]) {
		const result = shell(rule.regen, dir, env);
		if (result.code !== 0) {
			return { ok: false, error: `\`${rule.regen}\` exited ${result.code}: ${result.stderr.trim().slice(-2000)}` };
		}
		const paths = changed(dir);
		const outside = paths.filter((path) => !matches(rule, path));
		if (outside.length > 0)
			return { ok: false, error: `\`${rule.regen}\` changed files outside its paths: ${outside.join(', ')}` };
		if (pass === 2 && paths.length > 0)
			return { ok: false, error: `\`${rule.regen}\` wrote different output on a second run: ${paths.join(', ')}` };
		if (paths.length > 0) git(dir, ['add', '--all', '--', ...paths]);
		for (const path of paths) written.add(path);
	}
	for (const path of conflicts) written.add(path);
	return { ok: true, files: [...written].toSorted().map((path) => planFile(dir, path)) };
}

function planFile(dir: string, path: string): PlanFile {
	const full = join(dir, path);
	if (!existsSync(full)) return { path, mode: '100644', content: null };
	const executable = (lstatSync(full).mode & 0o111) !== 0;
	return { path, mode: executable ? '100755' : '100644', content: readFileSync(full).toString('base64') };
}
