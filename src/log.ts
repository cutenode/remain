import { createRequestLogger } from 'evlog';
import type { Classification } from './classify.ts';
import type { Pull } from './select.ts';

/**
 * One wide event per pull request a run looks at: what the merge found, what it did, and why it
 * stopped. The caller sets fields as it goes and emits once.
 */
export function pullEvent(mode: string, pull: Pull) {
	const event = createRequestLogger();
	event.set({ mode, pull: pull.number, base: pull.baseRefName, head: pull.headRefOid });
	return event;
}

export type PullEvent = ReturnType<typeof pullEvent>;

/** A classification as event fields: the files each way of resolving took, and the owner's by cause. */
export function classificationFields(classification: Classification) {
	return {
		union: classification.union,
		rerere: classification.rerere,
		regen: Object.fromEntries(classification.regen.map((group) => [group.rule.cause, group.paths])),
		owner: Object.fromEntries(classification.owner.map((group) => [group.cause, group.paths])),
	};
}

/** A GitHub annotation, which the run's summary page shows. */
export function annotate(level: 'notice' | 'warning', message: string): void {
	console.log(`::${level}::${message}`);
}
