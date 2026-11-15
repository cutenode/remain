import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { git, gitOut, readObject, shell } from '../src/git.ts';
import { makeRepo, tempDir } from './repo.ts';

describe('git', () => {
	it('throws with the exit code and stderr when git fails', () => {
		assert.throws(() => git(tempDir(), ['rev-parse', 'HEAD']), /exited 128: fatal: not a git repository/);
	});

	it("throws when it can't start at all", () => {
		assert.throws(() => git(join(tempDir(), 'missing'), ['status']), /ENOENT/);
		assert.throws(() => readObject(join(tempDir(), 'missing'), 'HEAD:x'), /ENOENT/);
	});

	it('lets a shell command fail without throwing', () => {
		assert.deepEqual(shell('echo out; echo err >&2; exit 4', tempDir(), process.env), {
			code: 4,
			stdout: 'out\n',
			stderr: 'err\n',
		});
	});
});

/** A repository whose refs, HEAD and config the tests below expect to stay as they are. */
function decoy() {
	const repo = makeRepo();
	repo.commit({ 'decoy.txt': 'decoy\n' }, 'decoy');
	const gitDir = join(repo.dir, '.git');
	const state = () =>
		[
			gitOut(repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)']),
			gitOut(repo.dir, ['symbolic-ref', 'HEAD']),
			gitOut(repo.dir, ['config', '--local', '--list']),
		].join('\n');
	return { repo, gitDir, before: state(), state };
}

// Git exports GIT_DIR and friends to the hooks it runs, and the pre-push hook runs these tests.
describe('git, run from inside a git hook', () => {
	it("works in the repository it's given, not the one GIT_DIR names", () => {
		const { repo, gitDir, before, state } = decoy();
		const hook = { GIT_DIR: gitDir, GIT_WORK_TREE: repo.dir, GIT_INDEX_FILE: join(gitDir, 'index') };
		Object.assign(process.env, hook);
		try {
			const other = makeRepo();
			const commit = other.commit({ 'other.txt': 'other\n' }, 'other');
			assert.equal(readObject(other.dir, `${commit}:other.txt`)?.toString(), 'other\n');
			assert.equal(gitOut(other.dir, ['log', '--format=%s']), 'other');
		} finally {
			for (const key of Object.keys(hook)) delete process.env[key];
		}
		assert.equal(state(), before);
	});

	it('leaves the outer repository alone through a whole test file', () => {
		const { gitDir, before, state } = decoy();
		// A test runner of its own: without NODE_TEST_CONTEXT it runs the file instead of reporting to
		// this one, and without NODE_V8_COVERAGE it doesn't write coverage this run would pick up.
		const { NODE_TEST_CONTEXT: _, NODE_V8_COVERAGE: __, ...env } = process.env;
		const result = spawnSync(process.execPath, ['--test', join(import.meta.dirname, 'merge.test.ts')], {
			env: { ...env, GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, 'index') },
			encoding: 'utf8',
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /^ℹ pass 5$/m);
		assert.equal(state(), before);
	});
});
