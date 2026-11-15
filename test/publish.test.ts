import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { git, gitOut } from '../src/git.ts';
import { attributesTree, type Prepared, prepare } from '../src/merge.ts';
import { applyPlan, publish, treeChanges } from '../src/publish.ts';
import type { PlanFile } from '../src/regen.ts';
import { FakeGitHub } from './fake-github.ts';
import { makeRepo, type Repo, tempDir } from './repo.ts';

const config = parseConfig(
	JSON.stringify({
		rules: [
			{ cause: 'changelog', paths: ['CHANGES.txt'], union: true },
			{ cause: 'lockfile', paths: ['app.lock'], regen: 'true' },
			{ cause: 'generated', paths: ['gen/**'], regen: 'true' },
		],
	}),
);

const file = (path: string, content: string | null, mode: PlanFile['mode'] = '100644'): PlanFile => ({
	path,
	mode,
	content: content === null ? null : Buffer.from(content).toString('base64'),
});

let repo: Repo;
let scratch: string;
let main: string;
let head: string;
beforeEach(() => {
	repo = makeRepo();
	scratch = tempDir();
	repo.commit({ 'CHANGES.txt': 'one\n', 'app.lock': 'v1\n', 'old.txt': 'old\n' }, 'start');
	repo.checkout('pr', true);
	head = repo.commit({ 'CHANGES.txt': 'one\npr\n', 'app.lock': 'v2\n' }, 'pr');
	repo.checkout('main');
	const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`many/${i}.txt`, `${i}\n`]));
	main = repo.commit({ 'CHANGES.txt': 'one\nmain\n', 'app.lock': 'v3\n', 'old.txt': null, ...many }, 'main');
});
afterEach(() => repo.cleanup());

function merged(): Prepared {
	return prepare(repo.dir, join(scratch, 'w'), head, main, attributesTree(repo.dir, main, config), config);
}

/** A bare copy of the repository as GitHub has it before the push. */
function remote(): FakeGitHub {
	const bare = join(scratch, 'remote.git');
	git(scratch, ['clone', '--quiet', '--bare', repo.dir, bare]);
	return new FakeGitHub(bare);
}

describe('applyPlan', () => {
	it('finishes the merge with the rebuilt files', () => {
		const { dir, classification } = merged();
		const tree = applyPlan(dir, classification, [file('app.lock', 'v4\n')]);
		assert.equal(gitOut(dir, ['cat-file', 'blob', `${tree}:app.lock`]), 'v4');
		assert.equal(gitOut(dir, ['cat-file', 'blob', `${tree}:CHANGES.txt`]), 'one\npr\nmain');
	});

	it('takes a deletion', () => {
		const { dir, classification } = merged();
		const tree = applyPlan(dir, classification, [file('app.lock', null)]);
		assert.equal(git(dir, ['cat-file', '-e', `${tree}:app.lock`], { ok: [0, 128] }).code, 128);
	});

	it('refuses a file no conflicting regen rule names', () => {
		const { dir, classification } = merged();
		assert.throws(
			() => applyPlan(dir, classification, [file('app.lock', 'v4\n'), file('src/evil.ts', 'x')]),
			/rebuilt src\/evil.ts, which no conflicting regen rule names/,
		);
		// gen/ is a regen rule's, but nothing under it conflicted.
		assert.throws(() => applyPlan(dir, classification, [file('gen/x', 'x')]), /rebuilt gen\/x/);
	});

	it('refuses modes other than plain and executable files', () => {
		const { dir, classification } = merged();
		const link = { path: 'app.lock', mode: '120000', content: '' } as unknown as PlanFile;
		assert.throws(() => applyPlan(dir, classification, [link]), /app.lock has mode 120000/);
	});

	it('refuses when a conflict is left', () => {
		const { dir, classification } = merged();
		assert.throws(() => applyPlan(dir, classification, []), /still conflicting: app.lock/);
	});

	it('refuses a merge with conflicts no rule resolves', () => {
		repo.checkout('pr');
		head = repo.commit({ 'old.txt': 'changed\n' });
		repo.checkout('main');
		const { dir, classification } = merged();
		assert.throws(() => applyPlan(dir, classification, [file('app.lock', 'v4\n')]), /no rule resolves/);
	});
});

describe('publish', () => {
	it('writes the merge commit through the API and moves the branch', () => {
		const github = remote();
		const { dir, classification } = merged();
		const tree = applyPlan(dir, classification, [file('app.lock', 'v4\n', '100755')]);
		const changes = treeChanges(dir, head, tree);
		assert.ok(changes.some((entry) => entry.path === 'old.txt' && entry.sha === null));
		assert.equal(changes.length, 603);

		const published = publish(github, dir, 'pr', [head, main], tree, "Merge branch 'main' into pr");
		assert.ok(published);
		assert.deepEqual(
			{ verified: published.verified, reason: published.reason },
			{ verified: false, reason: 'unsigned' },
		);
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/pr']), published.sha);
		assert.equal(gitOut(github.remote, ['rev-parse', `${published.sha}^{tree}`]), tree);
		assert.equal(
			gitOut(github.remote, ['rev-list', '--parents', '-n', '1', published.sha]),
			`${published.sha} ${head} ${main}`,
		);
		// Only the two blobs neither parent has went up, and the 603 changes in two batches.
		assert.deepEqual(
			github.calls.filter((call) => call !== 'POST git/trees'),
			['POST git/blobs', 'POST git/blobs', 'POST git/commits', 'PATCH git/refs/heads/pr'],
		);
		assert.equal(github.calls.filter((call) => call === 'POST git/trees').length, 2);
	});

	it('passes on any other failure to move the branch', () => {
		const github = remote();
		github.failures.set('PATCH git/refs/heads/pr', 500);
		const { dir, classification } = merged();
		const tree = applyPlan(dir, classification, [file('app.lock', 'v4\n')]);
		assert.throws(() => publish(github, dir, 'pr', [head, main], tree, 'merge'), /failed \(HTTP 500\)/);
	});

	it("doesn't move a branch someone pushed to since", () => {
		const github = remote();
		const elsewhere = makeRepo();
		git(elsewhere.dir, ['fetch', '--quiet', github.remote, 'pr']);
		elsewhere.checkout('FETCH_HEAD');
		const moved = elsewhere.commit({ 'new.txt': 'new\n' });
		git(elsewhere.dir, ['push', '--quiet', github.remote, `${moved}:refs/heads/pr`]);
		elsewhere.cleanup();

		const { dir, classification } = merged();
		const tree = applyPlan(dir, classification, [file('app.lock', 'v4\n')]);
		assert.equal(publish(github, dir, 'pr', [head, main], tree, 'merge'), undefined);
		assert.equal(gitOut(github.remote, ['rev-parse', 'refs/heads/pr']), moved);
	});
});
