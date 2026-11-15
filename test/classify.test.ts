import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, isMechanical, rerereResolved } from '../src/classify.ts';
import { parseConfig } from '../src/config.ts';

const config = parseConfig(
	JSON.stringify({
		rules: [
			{ cause: 'lockfile', paths: ['**/Cargo.lock', 'pnpm-lock.yaml'], regen: 'regen-locks' },
			{ cause: 'generated docs', paths: ['docs/rpc/*'], regen: 'regen-rpc' },
			{ cause: 'committed numbers', paths: ['budgets/*.json'] },
			{ cause: 'changelog', paths: ['CHANGES.txt'], union: true },
		],
	}),
);

describe('classify', () => {
	it('is mechanical when only union, rerere and regen files conflict', () => {
		const result = classify(
			config,
			['CHANGES.txt', 'src/plugins.rs', 'fuzz/Cargo.lock', 'Cargo.lock', 'docs/rpc/schema.json'],
			['fuzz/Cargo.lock', 'Cargo.lock', 'docs/rpc/schema.json'],
			['src/plugins.rs'],
		);
		assert.deepEqual(result.union, ['CHANGES.txt']);
		assert.deepEqual(result.rerere, ['src/plugins.rs']);
		assert.deepEqual(
			result.regen.map((group) => [group.rule.cause, group.paths]),
			[
				['lockfile', ['Cargo.lock', 'fuzz/Cargo.lock']],
				['generated docs', ['docs/rpc/schema.json']],
			],
		);
		assert.deepEqual(result.owner, []);
		assert.equal(isMechanical(result), true);
	});

	it('sends everything else to its owner, by cause, with unnamed files last', () => {
		const result = classify(
			config,
			['src/a.rs', 'budgets/cli.json', 'README.md', 'Cargo.lock'],
			['src/a.rs', 'budgets/cli.json', 'README.md', 'Cargo.lock'],
			[],
		);
		assert.deepEqual(result.owner, [
			{ cause: 'committed numbers', paths: ['budgets/cli.json'] },
			{ cause: 'code or prose', paths: ['README.md', 'src/a.rs'] },
		]);
		assert.equal(isMechanical(result), false);
		assert.deepEqual(result.regen[0]?.paths, ['Cargo.lock']);
	});

	it('sends a union file that still conflicts to its owner', () => {
		const result = classify(config, ['CHANGES.txt'], ['CHANGES.txt'], []);
		assert.deepEqual(result.owner, [{ cause: 'changelog', paths: ['CHANGES.txt'] }]);
		assert.deepEqual(result.union, []);
	});

	it('is mechanical with nothing conflicting', () => {
		assert.equal(isMechanical(classify(config, [], [], [])), true);
	});
});

describe('rerereResolved', () => {
	it('reads the paths rerere resolved from git merge output', () => {
		const output = [
			'Auto-merging list.txt',
			"Staged 'src/plugins.rs' using previous resolution.",
			"Resolved 'a b.txt' using previous resolution.",
			'CONFLICT (content): Merge conflict in code.txt',
		].join('\n');
		assert.deepEqual(rerereResolved(output), ['src/plugins.rs', 'a b.txt']);
	});
});
