import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig, ruleFor, unionAttributes } from '../src/config.ts';

const config = parseConfig(
	JSON.stringify({
		rules: [
			{ cause: 'lockfile', paths: ['**/Cargo.lock'], regen: 'cargo metadata > /dev/null' },
			{ cause: 'committed numbers', paths: ['benchmarks/budgets/**'] },
			{ cause: 'changelog', paths: ['CHANGES.txt', 'docs/*.list'], union: true },
		],
		approvers: ['bnb'],
	}),
);

describe('parseConfig', () => {
	it('fills in defaults', () => {
		assert.deepEqual(parseConfig('{}'), { rules: [], approvers: [], since: '30 days ago', label: 'needs-owner' });
	});

	it('keeps each rule as written', () => {
		assert.deepEqual(config.rules[0], {
			cause: 'lockfile',
			paths: ['**/Cargo.lock'],
			regen: 'cargo metadata > /dev/null',
		});
		assert.deepEqual(config.rules[1], { cause: 'committed numbers', paths: ['benchmarks/budgets/**'] });
		assert.equal(config.rules[2]?.union, true);
		assert.deepEqual(config.approvers, ['bnb']);
	});

	it('allows a $schema key', () => {
		assert.deepEqual(parseConfig('{"$schema": "x", "label": "conflict"}').label, 'conflict');
	});

	const invalid: [string, string, RegExp][] = [
		['not JSON', '{', /not JSON/],
		['a list', '[]', /must be an object/],
		['an unknown key', '{"rule": []}', /unknown keys: rule/],
		['rules not a list', '{"rules": {}}', /rules must be a list/],
		['a rule not an object', '{"rules": [1]}', /rules\[0\] isn't an object/],
		['a rule with an unknown key', '{"rules": [{"cause": "x", "paths": ["a"], "run": "y"}]}', /unknown keys: run/],
		['a rule without a cause', '{"rules": [{"paths": ["a"]}]}', /cause must be/],
		['a rule without paths', '{"rules": [{"cause": "x", "paths": []}]}', /paths must be/],
		['union not a boolean', '{"rules": [{"cause": "x", "paths": ["a"], "union": "yes"}]}', /union must be/],
		['an empty regen', '{"rules": [{"cause": "x", "paths": ["a"], "regen": ""}]}', /regen must be a command/],
		[
			'union and regen',
			'{"rules": [{"cause": "x", "paths": ["a"], "union": true, "regen": "y"}]}',
			/both union and regen/,
		],
		['approvers not logins', '{"approvers": [1]}', /approvers must be/],
		['an empty since', '{"since": ""}', /since must be/],
		['an empty label', '{"label": ""}', /label must be/],
	];
	for (const [name, text, error] of invalid) {
		it(`rejects ${name}`, () => assert.throws(() => parseConfig(text), error));
	}
});

describe('ruleFor', () => {
	it('matches globs from the root', () => {
		assert.equal(ruleFor(config, 'Cargo.lock')?.cause, 'lockfile');
		assert.equal(ruleFor(config, 'fuzz/Cargo.lock')?.cause, 'lockfile');
		assert.equal(ruleFor(config, 'benchmarks/budgets/cli.json')?.cause, 'committed numbers');
		assert.equal(ruleFor(config, 'docs/a.list')?.cause, 'changelog');
		assert.equal(ruleFor(config, 'sub/CHANGES.txt'), undefined);
		assert.equal(ruleFor(config, 'src/main.rs'), undefined);
	});

	it('takes the first rule that matches', () => {
		const both = parseConfig(
			JSON.stringify({
				rules: [
					{ cause: 'first', paths: ['*.json'] },
					{ cause: 'second', paths: ['a.json'] },
				],
			}),
		);
		assert.equal(ruleFor(both, 'a.json')?.cause, 'first');
	});
});

describe('unionAttributes', () => {
	it('anchors each union glob to the root', () => {
		assert.equal(unionAttributes(config), '/CHANGES.txt merge=union\n/docs/*.list merge=union\n');
	});

	it('is empty without union rules', () => {
		assert.equal(unionAttributes(parseConfig('{}')), '');
	});
});
