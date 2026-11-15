import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfig, type Rule } from '../src/config.ts';
import { attributesTree, prepare } from '../src/merge.ts';
import { commandEnv, regenerate } from '../src/regen.ts';
import { makeRepo, type Repo, tempDir } from './repo.ts';

/** items.index lists the files under items/, so both sides adding an item conflict on it. */
const INDEX = 'ls items | sort > items.index';

let repo: Repo;
let scratch: string;
beforeEach(() => {
	repo = makeRepo();
	scratch = tempDir();
	repo.commit({ 'items/a': '', 'items.index': 'a\n', 'tool.sh': '#!/bin/sh\n' }, 'start');
});
afterEach(() => repo.cleanup());

/** Both sides add an item, then the pull request's index conflicts with main's. */
function conflictingIndex(regen: string, paths = ['items.index']) {
	repo.checkout('pr', true);
	const head = repo.commit({ 'items/p': '', 'items.index': 'a\np\n' });
	repo.checkout('main');
	const main = repo.commit({ 'items/m': '', 'items.index': 'a\nm\n' });
	const config = parseConfig(JSON.stringify({ rules: [{ cause: 'index', paths, regen }] }));
	const dir = join(scratch, 'w');
	const { classification } = prepare(repo.dir, dir, head, main, attributesTree(repo.dir, main, config), config);
	const group = classification.regen[0];
	assert.ok(group);
	return { dir, main, rule: group.rule as Rule & { regen: string }, conflicts: group.paths };
}

describe('regenerate', () => {
	it("rebuilds the conflicting file with the rule's command", () => {
		const { dir, main, rule, conflicts } = conflictingIndex(INDEX);
		const result = regenerate(dir, rule, conflicts, main);
		assert.deepEqual(result, {
			ok: true,
			files: [{ path: 'items.index', mode: '100644', content: Buffer.from('a\nm\np\n').toString('base64') }],
		});
	});

	it('reports a file the command deleted, and the mode of one it made executable', () => {
		const { dir, main, rule, conflicts } = conflictingIndex(
			'rm -f items.index; touch items.list; chmod +x items.list',
			['items.*'],
		);
		const result = regenerate(dir, rule, conflicts, main);
		assert.deepEqual(result, {
			ok: true,
			files: [
				{ path: 'items.index', mode: '100644', content: null },
				{ path: 'items.list', mode: '100755', content: '' },
			],
		});
		assert.equal(existsSync(join(dir, 'items.index')), false);
	});

	it('fails when the command fails', () => {
		const { dir, main, rule, conflicts } = conflictingIndex('echo broken >&2; exit 3');
		assert.deepEqual(regenerate(dir, rule, conflicts, main), {
			ok: false,
			error: '`echo broken >&2; exit 3` exited 3: broken',
		});
	});

	it('fails when the command writes outside its paths', () => {
		const { dir, main, rule, conflicts } = conflictingIndex(`${INDEX}; echo x > tool.sh`);
		const result = regenerate(dir, rule, conflicts, main);
		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : result.error, /changed files outside its paths: tool.sh/);
	});

	it("fails when a second run's output differs", () => {
		const { dir, main, rule, conflicts } = conflictingIndex('date +%s%N > items.index');
		const result = regenerate(dir, rule, conflicts, main);
		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : result.error, /different output on a second run: items.index/);
	});

	it('takes the base copy of a file the base deleted before running', () => {
		repo.checkout('pr', true);
		const head = repo.commit({ 'items.index': 'changed\n' });
		repo.checkout('main');
		const main = repo.commit({ 'items.index': null });
		const config = parseConfig(JSON.stringify({ rules: [{ cause: 'index', paths: ['items.index'], regen: 'true' }] }));
		const dir = join(scratch, 'w');
		const { classification } = prepare(repo.dir, dir, head, main, attributesTree(repo.dir, main, config), config);
		const group = classification.regen[0];
		assert.ok(group);
		const result = regenerate(dir, group.rule as Rule & { regen: string }, group.paths, main);
		assert.deepEqual(result, { ok: true, files: [{ path: 'items.index', mode: '100644', content: null }] });
	});
});

describe('commandEnv', () => {
	it("drops the action's inputs and anything that looks like a credential", () => {
		const env = commandEnv({
			PATH: '/bin',
			HOME: '/home',
			INPUT_TOKEN: 't',
			GITHUB_TOKEN: 't',
			GH_TOKEN: 't',
			ACTIONS_RUNTIME_TOKEN: 't',
			ACTIONS_CACHE_URL: 'u',
			NPM_PASSWORD: 'p',
			DEPLOY_KEY: 'k',
			MY_SECRET_VALUE: 's',
			CARGO_TERM_COLOR: 'always',
		});
		assert.deepEqual(env, { PATH: '/bin', HOME: '/home', CARGO_TERM_COLOR: 'always' });
	});
});
