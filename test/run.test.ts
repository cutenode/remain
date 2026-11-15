import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { git, gitOut } from '../src/git.ts';
import { MARKER } from '../src/report.ts';
import { type Options, run } from '../src/run.ts';
import { FakeGitHub } from './fake-github.ts';
import { pull } from './pull.ts';
import { makeRepo, type Repo, tempDir } from './repo.ts';

const config = (regen: string) =>
	JSON.stringify({
		rules: [
			{ cause: 'changelog', paths: ['CHANGES.txt'], union: true },
			{ cause: 'index', paths: ['items.index'], regen },
			{ cause: 'committed numbers', paths: ['budgets/*'] },
		],
		approvers: ['bnb'],
	});

let upstream: Repo;
let scratch: string;
let github: FakeGitHub;
let heads: Record<string, string>;
let main: string;

/**
 * A repository on the fake GitHub with five open pull requests: #1 conflicts only in a union list
 * and a generated index, #2 in code, #3 is stacked on #2, #4 was labelled but its owner has since
 * resolved it, and #5 is from a fork.
 */
function setUp(regen: string): void {
	upstream = makeRepo();
	scratch = tempDir();
	const start = upstream.commit(
		{
			'.github/remain.json': config(regen),
			'CHANGES.txt': 'one\n',
			'items/a': '',
			'items.index': 'a\n',
			'code.txt': 'x\n',
		},
		'start',
	);
	heads = {};
	const branch = (name: string, from: string, files: Record<string, string>) => {
		upstream.git('checkout', '--quiet', '-b', name, from);
		heads[name] = upstream.commit(files, name);
	};
	branch('branch-1', start, { 'CHANGES.txt': 'one\npr1\n', 'items/p1': '', 'items.index': 'a\np1\n' });
	branch('branch-2', start, { 'code.txt': 'P\n' });
	branch('branch-3', heads['branch-2'] ?? '', { 'three.txt': '3\n' });
	branch('branch-4', start, { 'four.txt': '4\n' });
	upstream.checkout('main');
	main = upstream.commit(
		{ 'CHANGES.txt': 'one\nmain\n', 'items/m': '', 'items.index': 'a\nm\n', 'code.txt': 'M\n' },
		'main',
	);

	const bare = join(scratch, 'origin.git');
	git(scratch, ['clone', '--quiet', '--bare', upstream.dir, bare]);
	for (const [number, name] of [
		[1, 'branch-1'],
		[2, 'branch-2'],
		[3, 'branch-3'],
		[4, 'branch-4'],
	] as const) {
		git(bare, ['update-ref', `refs/pull/${number}/head`, heads[name] ?? '']);
	}
	git(scratch, ['clone', '--quiet', bare, join(scratch, 'checkout')]);

	github = new FakeGitHub(bare);
	const ref = (name: string) => ({ headRefName: name, headRefOid: heads[name] ?? '' });
	github.pullList = [
		pull(1, { ...ref('branch-1'), approvals: [{ login: 'bnb', oid: heads['branch-1'] ?? '' }] }),
		pull(2, ref('branch-2')),
		pull(3, { ...ref('branch-3'), baseRefName: 'branch-2' }),
		pull(4, { ...ref('branch-4'), mergeStateStatus: 'CLEAN', labels: ['needs-owner'] }),
		pull(5, { headRefName: 'patch-1', isCrossRepository: true }),
	];
	github.comments.set(4, [
		{ id: 99, body: `${MARKER}\nold\n<!-- remain:pushed abc -->`, user: { login: 'github-actions[bot]' } },
	]);
}

function options(): Options {
	return {
		repo: join(scratch, 'checkout'),
		github,
		appGitHub: github.as('remain[bot]'),
		token: 'token',
		server: 'https://github.com',
		scratch: join(scratch, 'runner'),
		config: '.github/remain.json',
		plans: join(scratch, 'plans'),
		digest: join(scratch, 'digest'),
		commentAuthor: 'github-actions[bot]',
		runUrl: 'https://github.com/o/r/actions/runs/1',
		summary: join(scratch, 'summary.md'),
	};
}

const commentOn = (number: number) => github.comments.get(number)?.map((comment) => comment.body) ?? [];
const labelsOn = (number: number) => github.pullList.find((item) => item.number === number)?.labels;
const show = (rev: string) => gitOut(github.remote, ['show', rev]);

afterEach(() => upstream.cleanup());

describe('run', () => {
	beforeEach(() => setUp('ls items | sort > items.index'));

	it('merges the default branch into a pull request whose conflicts are all mechanical', () => {
		run('merge', options());
		assert.deepEqual(
			['1.json', '2.json'].map((file) => existsSync(join(scratch, 'plans', file))),
			[true, false],
		);
		assert.equal(readFileSync(join(scratch, 'plans', 'index.json'), 'utf8'), '[1]');
		run('push', options());

		const pushed = gitOut(github.remote, ['rev-parse', 'refs/heads/branch-1']);
		assert.equal(
			gitOut(github.remote, ['rev-list', '--parents', '-n', '1', pushed]),
			`${pushed} ${heads['branch-1']} ${main}`,
		);
		assert.equal(show(`${pushed}:items.index`), 'a\nm\np1');
		assert.equal(show(`${pushed}:CHANGES.txt`), 'one\npr1\nmain');
		assert.equal(gitOut(github.remote, ['log', '-1', '--format=%s', pushed]), "Merge branch 'main' into branch-1");
		assert.deepEqual(commentOn(1), [
			[
				MARKER,
				`Merged \`main\` in with ${pushed.slice(0, 9)}:`,
				'',
				"- `CHANGES.txt`: kept both sides' lines",
				'- `items.index`: rebuilt with `ls items | sort > items.index`',
				`<!-- remain:pushed ${pushed} -->`,
			].join('\n'),
		]);
		assert.deepEqual(labelsOn(1), []);

		const digest = JSON.parse(readFileSync(join(scratch, 'digest', 'digest.json'), 'utf8')) as { number: number }[];
		assert.deepEqual(
			digest.map((entry) => entry.number),
			[1],
		);
		assert.match(readFileSync(join(scratch, 'summary.md'), 'utf8'), /^## Re-approve\n\n\| Pull request/);
	});

	it('labels the rest for their owners, and leaves stacks and clean pull requests alone', () => {
		run('merge', options());
		run('push', options());

		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-2']), heads['branch-2']);
		assert.deepEqual(labelsOn(2), ['needs-owner']);
		assert.match(commentOn(2)[0] ?? '', /\*\*code or prose\*\*\n- `code.txt`/);

		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-3']), heads['branch-3']);
		assert.deepEqual(labelsOn(3), []);
		assert.deepEqual(commentOn(3), []);

		assert.deepEqual(labelsOn(4), []);
		assert.deepEqual(commentOn(4), [`${MARKER}\nNo conflicts left.\n<!-- remain:pushed abc -->`]);

		assert.deepEqual(labelsOn(5), ['needs-owner']);
		assert.match(commentOn(5)[0] ?? '', /its branch is on a fork/);
	});

	it('edits its comment in place on a later run', () => {
		run('merge', options());
		run('push', options());
		run('push', options());
		assert.equal(commentOn(2).length, 1);
		assert.equal(commentOn(5).length, 1);
	});

	it("doesn't push without the merge job's rebuilt files", () => {
		run('push', options());
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-1']), heads['branch-1']);
		assert.deepEqual(commentOn(1), []);
	});

	it('merges another base when told to, and skips a pull request that already has it', () => {
		run('merge', { ...options(), base: 'branch-2' });
		run('push', { ...options(), base: 'branch-2' });
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-3']), heads['branch-3']);
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-1']), heads['branch-1']);
		assert.deepEqual(commentOn(3), []);
	});

	it("doesn't touch a pull request someone pushed to after the merge job", () => {
		run('merge', options());
		upstream.checkout('branch-1');
		const moved = upstream.commit({ 'late.txt': 'late\n' });
		git(upstream.dir, ['push', '--quiet', github.remote, 'branch-1']);
		run('push', options());
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-1']), moved);
		assert.deepEqual(commentOn(1), []);
	});

	it("doesn't comment when GitHub refuses the branch update as not a fast-forward", () => {
		run('merge', options());
		github.failures.set('PATCH git/refs/heads/branch-1', 422);
		run('push', options());
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-1']), heads['branch-1']);
		assert.deepEqual(commentOn(1), []);
	});

	it('stops on a GitHub error, after logging which pull request it was on', () => {
		run('merge', options());
		github.failures.set('POST issues/2/labels', 500);
		assert.throws(() => run('push', options()), /POST issues\/2\/labels failed/);
		github.failures.clear();
		github.failures.set('DELETE issues/4/labels/needs-owner', 500);
		assert.throws(() => run('push', options()), /DELETE issues\/4\/labels\/needs-owner failed/);
	});

	it('stops when it cannot write a plan', () => {
		mkdirSync(join(scratch, 'plans', '1.json'), { recursive: true });
		assert.throws(() => run('merge', options()), /EISDIR/);
	});

	it('needs the App to push', () => {
		const { appGitHub: _, ...withoutApp } = options();
		assert.throws(() => run('push', withoutApp), /push mode needs app-token/);
	});

	it('needs a config on the default branch', () => {
		upstream.cleanup();
		setUp('true');
		assert.throws(
			() => run('merge', { ...options(), config: '.github/missing.json' }),
			/main has no .github\/missing.json/,
		);
	});
});

describe('run, when a regenerate command fails', () => {
	beforeEach(() => setUp('exit 1'));

	it("labels the pull request and doesn't push", () => {
		run('merge', options());
		run('push', options());
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/branch-1']), heads['branch-1']);
		assert.deepEqual(labelsOn(1), ['needs-owner']);
		assert.match(
			commentOn(1)[0] ?? '',
			/rebuilding a generated file failed\. \[Run\]\(https:\/\/github.com\/o\/r\/actions\/runs\/1\)/,
		);
	});
});
