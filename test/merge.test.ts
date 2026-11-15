import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isMechanical } from '../src/classify.ts';
import { parseConfig } from '../src/config.ts';
import { attributesTree, plainConflicts, prepare, removeWorktree } from '../src/merge.ts';
import { approvedMerges, defaultBranchMerges, train } from '../src/rerere.ts';
import { handMerge, makeRepo, type Repo, tempDir } from './repo.ts';

const config = parseConfig(
	JSON.stringify({
		rules: [
			{ cause: 'changelog', paths: ['CHANGES.txt'], union: true },
			{ cause: 'lockfile', paths: ['app.lock'], regen: 'true' },
		],
	}),
);

let repo: Repo;
let scratch: string;
beforeEach(() => {
	repo = makeRepo();
	scratch = tempDir();
	repo.commit({ 'CHANGES.txt': 'one\n', 'code.txt': 'x\n', 'app.lock': 'v1\n', 'notes.txt': 'a\n' }, 'start');
});
afterEach(() => repo.cleanup());

/** Main and a pull request branch that both changed `files` from the start. */
function diverge(main: Record<string, string>, pr: Record<string, string>): { main: string; head: string } {
	repo.checkout('pr', true);
	const head = repo.commit(pr, 'pr');
	repo.checkout('main');
	return { main: repo.commit(main, 'main'), head };
}

describe('prepare', () => {
	it('unions the configured lists and leaves code and regen files', () => {
		const { main, head } = diverge(
			{ 'CHANGES.txt': 'one\nmain\n', 'code.txt': 'M\n', 'app.lock': 'v2\n' },
			{ 'CHANGES.txt': 'one\npr\n', 'code.txt': 'P\n', 'app.lock': 'v3\n' },
		);
		assert.deepEqual(plainConflicts(repo.dir, head, main), ['CHANGES.txt', 'app.lock', 'code.txt']);
		const dir = join(scratch, 'w');
		const { classification } = prepare(repo.dir, dir, head, main, attributesTree(repo.dir, main, config), config);
		assert.deepEqual(classification.union, ['CHANGES.txt']);
		assert.deepEqual(readFileSync(join(dir, 'CHANGES.txt'), 'utf8'), 'one\npr\nmain\n');
		assert.deepEqual(
			classification.regen.map((group) => group.paths),
			[['app.lock']],
		);
		assert.deepEqual(classification.owner, [{ cause: 'code or prose', paths: ['code.txt'] }]);
		removeWorktree(repo.dir, dir);
	});

	it("ignores the pull request's own .gitattributes", () => {
		const { main, head } = diverge({ 'code.txt': 'M\n' }, { 'code.txt': 'P\n', '.gitattributes': '* merge=union\n' });
		const dir = join(scratch, 'w');
		const { classification } = prepare(repo.dir, dir, head, main, attributesTree(repo.dir, main, config), config);
		assert.deepEqual(classification.owner, [{ cause: 'code or prose', paths: ['code.txt'] }]);
		assert.equal(isMechanical(classification), false);
	});

	it("honours the default branch's own .gitattributes", () => {
		const { main, head } = diverge(
			{ 'notes.txt': 'a\nmain\n', '.gitattributes': 'notes.txt merge=union\n' },
			{ 'notes.txt': 'a\npr\n' },
		);
		const dir = join(scratch, 'w');
		const { classification } = prepare(repo.dir, dir, head, main, attributesTree(repo.dir, main, config), config);
		assert.deepEqual(classification.union, ['notes.txt']);
		assert.equal(isMechanical(classification), true);
	});
});

describe('rerere', () => {
	it('replays a resolution learned from an approved merge on a sibling branch', () => {
		const start = repo.git('rev-parse', 'HEAD');
		const main = repo.commit({ 'code.txt': 'M\n' }, 'main');
		repo.checkout('first', true);
		repo.git('reset', '--hard', start);
		repo.commit({ 'code.txt': 'P\n' }, 'first');
		const approved = handMerge(repo, main, { 'code.txt': 'P and M\n' });
		repo.checkout('second', true);
		repo.git('reset', '--hard', start);
		const head = repo.commit({ 'code.txt': 'P\n', 'other.txt': 'second\n' }, 'second');

		const attrTree = attributesTree(repo.dir, main, config);
		const merges = approvedMerges(repo.dir, approved, main);
		assert.deepEqual(merges, [approved]);
		assert.deepEqual(train(repo.dir, join(scratch, 'train'), merges, attrTree), [approved]);
		// Already learned: a restored cache isn't learned from again.
		assert.deepEqual(train(repo.dir, join(scratch, 'train'), merges, attrTree), []);

		const dir = join(scratch, 'w');
		const { classification } = prepare(repo.dir, dir, head, main, attrTree, config);
		assert.deepEqual(classification.rerere, ['code.txt']);
		assert.equal(isMechanical(classification), true);
		assert.equal(readFileSync(join(dir, 'code.txt'), 'utf8'), 'P and M\n');
	});

	it("learns nothing from clean merges and the default branch's history", () => {
		repo.checkout('side', true);
		const side = repo.commit({ 'other.txt': 'side\n' });
		repo.checkout('main');
		repo.commit({ 'notes.txt': 'b\n' });
		const merge = handMerge(repo, side, {});
		const merges = defaultBranchMerges(repo.dir, 'main', '1 year ago');
		assert.deepEqual(merges, [merge]);
		assert.deepEqual(train(repo.dir, join(scratch, 'train'), merges, attributesTree(repo.dir, 'main', config)), []);
	});
});
