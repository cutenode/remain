// The action's entry: reads its inputs and the runner's environment, and runs one mode.
import { join, resolve } from 'node:path';
import { initLogger } from 'evlog';
import { GitHub } from './github.ts';
import { type Mode, run } from './run.ts';

// One JSON line per event in the job's log.
initLogger({ env: { service: 'remain' }, pretty: false });

const isMode = (value: string): value is Mode => ['list', 'merge', 'push'].includes(value);

function input(name: string, fallback = ''): string {
	return process.env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;
}

try {
	const mode = input('mode');
	if (!isMode(mode)) throw new Error(`mode must be list, merge or push, not "${mode}"`);
	const repo = process.env.GITHUB_REPOSITORY ?? '';
	const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
	const token = input('token');
	const appToken = input('app-token');
	const appSlug = input('app-slug');
	const summary = process.env.GITHUB_STEP_SUMMARY;
	const output = process.env.GITHUB_OUTPUT;
	const pull = input('pull');
	run(mode, {
		repo: resolve(process.env.GITHUB_WORKSPACE ?? '.'),
		github: new GitHub(repo, token),
		...(appToken && appSlug ? { app: { github: new GitHub(repo, appToken), login: `${appSlug}[bot]` } } : {}),
		...(input('base') ? { base: input('base') } : {}),
		token,
		server,
		scratch: join(process.env.RUNNER_TEMP ?? resolve('..'), 'remain'),
		config: input('config', '.github/remain.json'),
		plans: resolve(input('plans', 'remain-plans')),
		digest: resolve(input('digest', 'remain-digest')),
		commentAuthor: input('comment-author', 'github-actions[bot]'),
		runUrl: `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
		...(summary ? { summary } : {}),
		...(output ? { output } : {}),
		...(pull ? { pull: Number(pull) } : {}),
	});
} catch (error) {
	console.log(`::error::${(error as Error).message}`);
	process.exitCode = 1;
}
