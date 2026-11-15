/** An approval of one commit by one login. */
interface Approval {
	login: string;
	oid: string;
}

/** What the bot reads of an open pull request (GraphQL's names). */
export interface Pull {
	number: number;
	title: string;
	url: string;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	mergeStateStatus: string;
	isCrossRepository: boolean;
	labels: string[];
	/** Every approval, including ones GitHub dismissed after a push. */
	approvals: Approval[];
	/** The last 100 commits' SHAs, oldest first. */
	commits: string[];
	/** The head commit's combined check state: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED or null. */
	ci: string | null;
}

export type Pick = { pull: Pull; action: 'merge' } | { pull: Pull; action: 'skip'; reason: string };

/**
 * Which pull requests to merge into. Only ones GitHub marks DIRTY: a clean pull request never gets
 * its base merged in, since the merge queue tests it against main anyway and every push costs a
 * re-approval. A stacked pull request (based on another one's branch) waits until its parent isn't
 * DIRTY, so a stack is worked from the bottom up, one level per run. Forks are left to their owners:
 * the bot can't push to them and their code is less trusted.
 */
export function select(pulls: Pull[], defaultBranch: string): Pick[] {
	const byHead = new Map(pulls.filter((pull) => !pull.isCrossRepository).map((pull) => [pull.headRefName, pull]));
	return pulls
		.filter((pull) => pull.mergeStateStatus === 'DIRTY')
		.map((pull): Pick => {
			if (pull.isCrossRepository) return { pull, action: 'skip', reason: 'its branch is on a fork' };
			if (pull.baseRefName === defaultBranch) return { pull, action: 'merge' };
			const parent = byHead.get(pull.baseRefName);
			if (!parent) return { pull, action: 'skip', reason: `no open pull request has ${pull.baseRefName}` };
			if (parent.mergeStateStatus === 'DIRTY') return { pull, action: 'skip', reason: `waiting on #${parent.number}` };
			return { pull, action: 'merge' };
		})
		.toSorted((a, b) => a.pull.number - b.pull.number);
}
