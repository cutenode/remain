// Properties of the pure parts: what decides whether a file is resolved, which pull requests are
// touched, and what the comment and digest carry. Pull requests run a fixed seed, so a failure
// reproduces; scheduled.yml runs more cases with a random one. A failure prints its seed and path,
// and FC_SEED and FC_PATH replay it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import { classify, isMechanical } from '../src/classify.ts';
import { type Config, parseConfig, ruleFor, unionAttributes } from '../src/config.ts';
import { digest, renderDigest, sinceApproval } from '../src/report.ts';
import { type Pull, select } from '../src/select.ts';
import { pull } from './pull.ts';

const params: fc.Parameters<unknown> = {
	numRuns: Number(process.env.FC_RUNS ?? 300),
	...(process.env.FC_RANDOM ? {} : { seed: Number(process.env.FC_SEED ?? 1) }),
	...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
};

/** Paths from a small set of names, so rules and conflicts overlap often. */
const segment = fc.constantFrom('a', 'b', 'lock', 'docs', 'src');
const path = fc
	.array(segment, { minLength: 1, maxLength: 3 })
	.chain((parts) => fc.constantFrom('.txt', '.json', '.lock', '').map((ext) => `${parts.join('/')}${ext}`));
const glob = fc.oneof(
	path,
	segment.map((dir) => `${dir}/**`),
	fc.constantFrom('*.txt', '**/*.lock', '**'),
);
const rule = fc.record({
	cause: fc.constantFrom('lockfile', 'list', 'numbers', 'docs'),
	paths: fc.array(glob, { minLength: 1, maxLength: 3 }),
	kind: fc.constantFrom('union', 'regen', 'label'),
});
const config = fc.array(rule, { maxLength: 4 }).map((rules): Config =>
	parseConfig(
		JSON.stringify({
			rules: rules.map(({ kind, ...rest }) =>
				kind === 'union' ? { ...rest, union: true } : kind === 'regen' ? { ...rest, regen: 'make' } : rest,
			),
		}),
	),
);

describe('classify, for any config and conflicts', () => {
	it('puts each conflicting file in exactly one place, and resolves only what a rule names', () => {
		fc.assert(
			fc.property(
				config,
				fc.uniqueArray(path),
				fc.uniqueArray(path),
				fc.uniqueArray(path),
				(cfg, plain, left, replayed) => {
					const remaining = left;
					const rerere = replayed.filter((file) => plain.includes(file) && !remaining.includes(file));
					const result = classify(cfg, plain, remaining, rerere);
					const regen = result.regen.flatMap((group) => group.paths);
					const owner = result.owner.flatMap((group) => group.paths);
					const placed = [...result.union, ...result.rerere, ...regen, ...owner];
					assert.equal(new Set(placed).size, placed.length);
					assert.deepEqual(new Set(placed), new Set([...plain, ...remaining]));
					for (const file of regen) assert.ok(ruleFor(cfg, file)?.regen);
					for (const file of owner) assert.ok(!ruleFor(cfg, file)?.regen);
					for (const group of result.regen)
						for (const file of group.paths) assert.equal(ruleFor(cfg, file), group.rule);
					assert.equal(
						isMechanical(result),
						remaining.every((file) => ruleFor(cfg, file)?.regen !== undefined),
					);
				},
			),
			params,
		);
	});
});

describe('config, for any rules', () => {
	it('reads back what it wrote, and anchors one union line per glob', () => {
		fc.assert(
			fc.property(config, (cfg) => {
				assert.deepEqual(parseConfig(JSON.stringify(cfg)), cfg);
				const lines = unionAttributes(cfg).split('\n').filter(Boolean);
				const globs = cfg.rules.filter((item) => item.union).flatMap((item) => item.paths);
				assert.deepEqual(
					lines,
					globs.map((item) => `/${item} merge=union`),
				);
			}),
			params,
		);
	});
});

const pulls = fc
	.array(
		fc.record({
			status: fc.constantFrom('DIRTY', 'CLEAN', 'BLOCKED', 'UNKNOWN'),
			fork: fc.boolean(),
			base: fc.integer({ min: 0, max: 8 }),
		}),
		{ maxLength: 8 },
	)
	.map((items) =>
		items.map((item, i) =>
			pull(i + 1, {
				mergeStateStatus: item.status,
				isCrossRepository: item.fork,
				baseRefName: item.base === 0 ? 'main' : `branch-${item.base}`,
			}),
		),
	);

describe('select, for any pull requests', () => {
	it('picks only DIRTY ones, merges only into those based on main or on a parent that is done', () => {
		fc.assert(
			fc.property(pulls, (list: Pull[]) => {
				const picks = select(list, 'main');
				assert.deepEqual(
					picks.map((pick) => pick.pull.number),
					list.filter((item) => item.mergeStateStatus === 'DIRTY').map((item) => item.number),
				);
				for (const pick of picks) {
					if (pick.action === 'skip') continue;
					assert.equal(pick.pull.isCrossRepository, false);
					if (pick.pull.baseRefName === 'main') continue;
					const parent = list.find((item) => !item.isCrossRepository && item.headRefName === pick.pull.baseRefName);
					assert.ok(parent && parent.mergeStateStatus !== 'DIRTY');
				}
			}),
			params,
		);
	});
});

const sha = fc.stringMatching(/^[0-9a-f]{40}$/);

describe('the digest, for any history', () => {
	it("list a pull request only when every commit since the newest approval is the bot's", () => {
		const history = fc.record({
			commits: fc.uniqueArray(sha, { minLength: 1, maxLength: 6 }),
			approvedAt: fc.array(fc.nat(5), { maxLength: 3 }),
			botFrom: fc.nat(6),
			title: fc.string(),
		});
		fc.assert(
			fc.property(history, ({ commits, approvedAt, botFrom, title }) => {
				const approvals = approvedAt
					.filter((i) => i < commits.length)
					.map((i) => ({ login: 'bnb', oid: commits[i] ?? '' }));
				const item = pull(1, { commits, approvals, headRefOid: commits.at(-1) ?? '', title });
				const pushed = new Set(commits.slice(botFrom));
				const range = sinceApproval(item, ['bnb']);
				const entries = digest([item], ['bnb'], (commit) => pushed.has(commit));
				if (!range) {
					assert.equal(approvals.length, 0);
					assert.deepEqual(entries, []);
					return;
				}
				assert.equal(commits.indexOf(range.approved), Math.max(...approvedAt.filter((i) => i < commits.length)));
				const listed = range.since.length > 0 && range.since.every((commit) => pushed.has(commit));
				assert.equal(entries.length, listed ? 1 : 0);
				const rows = renderDigest(entries).split('\n').slice(2).filter(Boolean);
				for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length, 5);
			}),
			params,
		);
	});
});
