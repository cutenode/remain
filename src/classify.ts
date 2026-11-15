import { type Config, type Rule, ruleFor, UNNAMED_CAUSE } from './config.ts';

export interface Classification {
	/** Files git's union merge resolved. */
	union: string[];
	/** Files rerere resolved with an earlier, reviewed resolution. */
	rerere: string[];
	/** Conflicting files to rebuild, by the rule that rebuilds them. */
	regen: { rule: Rule; paths: string[] }[];
	/** Conflicting files that need a person, by cause. */
	owner: { cause: string; paths: string[] }[];
}

/**
 * Sorts a merge's conflicts by what resolves them. `plain` is what conflicts with no attributes and
 * no rerere (what GitHub sees), `remaining` what still conflicts after git's merge with the union
 * attributes and rerere, and `rerere` what rerere resolved. A file the config doesn't name is never
 * resolved: it goes to its owner.
 */
export function classify(config: Config, plain: string[], remaining: string[], rerere: string[]): Classification {
	const left = new Set(remaining);
	const replayed = new Set(rerere);
	const regen = new Map<Rule, string[]>();
	const owner = new Map<string, string[]>();
	for (const path of [...remaining].toSorted()) {
		const rule = ruleFor(config, path);
		if (rule?.regen) {
			regen.set(rule, [...(regen.get(rule) ?? []), path]);
			continue;
		}
		const cause = rule?.cause ?? UNNAMED_CAUSE;
		owner.set(cause, [...(owner.get(cause) ?? []), path]);
	}
	return {
		union: plain.filter((path) => !left.has(path) && !replayed.has(path)).toSorted(),
		rerere: plain.filter((path) => !left.has(path) && replayed.has(path)).toSorted(),
		regen: [...regen].map(([rule, paths]) => ({ rule, paths })),
		owner: [...owner]
			.map(([cause, paths]) => ({ cause, paths }))
			.toSorted(
				(a, b) =>
					Number(a.cause === UNNAMED_CAUSE) - Number(b.cause === UNNAMED_CAUSE) || a.cause.localeCompare(b.cause),
			),
	};
}

export function isMechanical(classification: Classification): boolean {
	return classification.owner.length === 0;
}

/** The paths rerere says it resolved, from `git merge`'s output. */
export function rerereResolved(output: string): string[] {
	return [...output.matchAll(/^(?:Staged|Resolved) '(.+)' using previous resolution\.$/gm)].map(
		(match) => match[1] ?? '',
	);
}
