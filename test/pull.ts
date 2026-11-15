import type { Pull } from '../src/select.ts';

/** An open, DIRTY pull request against main, with any fields replaced. */
export function pull(number: number, fields: Partial<Pull> = {}): Pull {
	return {
		number,
		title: `pull ${number}`,
		url: `https://github.com/o/r/pull/${number}`,
		headRefName: `branch-${number}`,
		headRefOid: `${number}`.padStart(40, '0'),
		baseRefName: 'main',
		mergeStateStatus: 'DIRTY',
		isCrossRepository: false,
		labels: [],
		approvals: [],
		commits: [],
		ci: null,
		...fields,
	};
}
