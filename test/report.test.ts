import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify } from '../src/classify.ts';
import { parseConfig } from '../src/config.ts';
import {
	ciState,
	clearedComment,
	digest,
	failedComment,
	MARKER,
	ownerComment,
	parsePushed,
	pushedComment,
	renderDigest,
	sinceApproval,
} from '../src/report.ts';
import { pull } from './pull.ts';

const config = parseConfig(
	JSON.stringify({
		rules: [
			{ cause: 'lockfile', paths: ['Cargo.lock'], regen: 'cargo metadata' },
			{ cause: 'committed numbers', paths: ['budgets/*'] },
			{ cause: 'changelog', paths: ['CHANGES.txt'], union: true },
		],
	}),
);

describe('comments', () => {
	it('lists what needs the owner by cause, and what would have been resolved', () => {
		const classification = classify(
			config,
			['budgets/cli.json', 'src/a.rs', 'Cargo.lock', 'CHANGES.txt'],
			['budgets/cli.json', 'src/a.rs', 'Cargo.lock'],
			[],
		);
		assert.equal(
			ownerComment('main', classification, []),
			[
				MARKER,
				"`main` can't be merged in automatically. These files need you:",
				'',
				'**committed numbers**',
				'- `budgets/cli.json`',
				'',
				'**code or prose**',
				'- `src/a.rs`',
				'',
				'These would have been resolved:',
				'',
				"- `CHANGES.txt`: kept both sides' lines",
				'- `Cargo.lock`: rebuilt with `cargo metadata`',
			].join('\n'),
		);
	});

	it('says what a push resolved, and keeps the pushed commits', () => {
		const classification = classify(config, ['CHANGES.txt', 'src/a.rs'], [], ['src/a.rs']);
		const body = pushedComment('main', 'abcdef0123456789', classification, ['1111', 'abcdef0123456789']);
		assert.equal(
			body,
			[
				MARKER,
				'Merged `main` in with abcdef012:',
				'',
				"- `CHANGES.txt`: kept both sides' lines",
				'- `src/a.rs`: replayed an earlier reviewed resolution',
				'<!-- remain:pushed 1111 abcdef0123456789 -->',
			].join('\n'),
		);
		assert.deepEqual(parsePushed(body), ['1111', 'abcdef0123456789']);
	});

	it('carries the pushed commits through every kind of comment', () => {
		assert.deepEqual(parsePushed(clearedComment(['aa'])), ['aa']);
		assert.deepEqual(parsePushed(failedComment('main', 'x', 'https://run', ['bb'])), ['bb']);
		assert.equal(clearedComment([]), `${MARKER}\nNo conflicts left.`);
		assert.equal(
			failedComment('dev', 'its branch is on a fork', 'https://run', []),
			`${MARKER}\n\`dev\` can't be merged in automatically: its branch is on a fork. [Run](https://run)`,
		);
		assert.deepEqual(parsePushed('no marker'), []);
	});
});

describe('ciState', () => {
	it('reads the head commit check rollup', () => {
		assert.equal(ciState(pull(1, { ci: 'SUCCESS' })), 'passing');
		assert.equal(ciState(pull(1, { ci: 'FAILURE' })), 'failing');
		assert.equal(ciState(pull(1, { ci: 'ERROR' })), 'failing');
		assert.equal(ciState(pull(1, { ci: 'PENDING' })), 'pending');
		assert.equal(ciState(pull(1, { ci: null })), 'pending');
	});
});

describe('sinceApproval', () => {
	it('starts after the newest approved commit, dismissed approvals included', () => {
		const approved = pull(1, {
			commits: ['a', 'b', 'c', 'd'],
			approvals: [
				{ login: 'bnb', oid: 'a' },
				{ login: 'bnb', oid: 'b' },
				{ login: 'someone', oid: 'c' },
			],
		});
		assert.deepEqual(sinceApproval(approved, ['bnb']), { approved: 'b', since: ['c', 'd'] });
	});

	it('has nothing to build on without an approver, or once the approved commit is gone', () => {
		assert.equal(sinceApproval(pull(1, { commits: ['a'], approvals: [{ login: 'x', oid: 'a' }] }), ['bnb']), undefined);
		assert.equal(
			sinceApproval(pull(1, { commits: ['b'], approvals: [{ login: 'bnb', oid: 'a' }] }), ['bnb']),
			undefined,
		);
	});
});

const pushed = () => ['m1', 'm2'];

describe('digest', () => {
	const approvedThenPushed = pull(2, {
		title: 'a | b',
		headRefOid: 'm2',
		commits: ['a', 'm1', 'm2'],
		approvals: [{ login: 'bnb', oid: 'a' }],
		ci: 'SUCCESS',
	});
	const someoneElsePushed = pull(3, { commits: ['a', 'x', 'm1'], approvals: [{ login: 'bnb', oid: 'a' }] });
	const stillApproved = pull(4, { commits: ['a'], approvals: [{ login: 'bnb', oid: 'a' }] });
	const neverApproved = pull(5, { commits: ['m1'] });

	it("lists only pull requests where everything since the approval is the bot's", () => {
		const entries = digest([someoneElsePushed, approvedThenPushed, stillApproved, neverApproved], ['bnb'], pushed);
		assert.deepEqual(entries, [
			{
				number: 2,
				title: 'a | b',
				url: 'https://github.com/o/r/pull/2',
				compare: 'https://github.com/o/r/compare/a...m2',
				ci: 'passing',
			},
		]);
		assert.equal(
			renderDigest(entries),
			[
				'| Pull request | CI | Since your approval |',
				'| --- | --- | --- |',
				'| [#2](https://github.com/o/r/pull/2) a \\| b | passing | [changes](https://github.com/o/r/compare/a...m2) |',
				'',
			].join('\n'),
		);
	});

	it('lists them by number', () => {
		const earlier = { ...approvedThenPushed, number: 1, url: 'https://github.com/o/r/pull/1' };
		assert.deepEqual(
			digest([approvedThenPushed, earlier], ['bnb'], pushed).map((entry) => entry.number),
			[1, 2],
		);
	});

	it('says so when there is nothing to re-approve', () => {
		assert.equal(renderDigest(digest([stillApproved], ['bnb'], pushed)), 'Nothing to re-approve.\n');
	});
});
