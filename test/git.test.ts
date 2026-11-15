import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { git, readObject, shell } from '../src/git.ts';
import { tempDir } from './repo.ts';

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
