import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Pull, select } from '../src/select.ts';
import { pull } from './pull.ts';

const summary = (pulls: Pull[]) =>
	select(pulls, 'main').map((pick) => [pick.pull.number, pick.action === 'skip' ? pick.reason : 'merge']);

describe('select', () => {
	it('only picks pull requests GitHub marks DIRTY', () => {
		const pulls = ['CLEAN', 'BEHIND', 'BLOCKED', 'UNKNOWN', 'UNSTABLE', 'DIRTY'].map((status, i) =>
			pull(i + 1, { mergeStateStatus: status }),
		);
		assert.deepEqual(summary(pulls), [[6, 'merge']]);
	});

	it('leaves forks to their owners', () => {
		assert.deepEqual(summary([pull(1, { isCrossRepository: true })]), [[1, 'its branch is on a fork']]);
	});

	it('works a stack from the bottom up', () => {
		const pulls = [
			pull(3, { baseRefName: 'branch-2' }),
			pull(2, { baseRefName: 'branch-1' }),
			pull(1),
			pull(5, { baseRefName: 'branch-4' }),
			pull(4, { mergeStateStatus: 'CLEAN' }),
		];
		assert.deepEqual(summary(pulls), [
			[1, 'merge'],
			[2, 'waiting on #1'],
			[3, 'waiting on #2'],
			[5, 'merge'],
		]);
	});

	it('skips a stacked pull request whose base has no pull request', () => {
		assert.deepEqual(summary([pull(1, { baseRefName: 'gone' })]), [[1, 'no open pull request has gone']]);
	});

	it("doesn't take a fork's branch for a parent", () => {
		const pulls = [
			pull(1, { baseRefName: 'shared' }),
			pull(2, { headRefName: 'shared', isCrossRepository: true, mergeStateStatus: 'CLEAN' }),
		];
		assert.deepEqual(summary(pulls), [[1, 'no open pull request has shared']]);
	});
});
