import { posix } from 'node:path';

/**
 * One kind of file, matched by its paths. A rule with `union` lets git keep both sides' lines, one
 * with `regen` rebuilds the files with that shell command, and one with neither only names the cause
 * in the comment on a pull request that needs its owner.
 */
export interface Rule {
	cause: string;
	paths: string[];
	union?: boolean;
	regen?: string;
}

export interface Config {
	rules: Rule[];
	/** Logins whose approval makes a pull request's own merges safe to learn resolutions from. */
	approvers: string[];
	/** How far back the default branch's merges are learned from, as `git log --since` reads it. */
	since: string;
	label: string;
}

/** The cause given to a conflicting file no rule names. */
export const UNNAMED_CAUSE = 'code or prose';

function fail(message: string): never {
	throw new Error(`remain config: ${message}`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseRule(value: unknown, index: number): Rule {
	if (typeof value !== 'object' || value === null) fail(`rules[${index}] isn't an object`);
	const { cause, paths, union, regen, ...rest } = value as Record<string, unknown>;
	const unknownKeys = Object.keys(rest);
	if (unknownKeys.length > 0) fail(`rules[${index}] has unknown keys: ${unknownKeys.join(', ')}`);
	if (typeof cause !== 'string' || cause === '') fail(`rules[${index}].cause must be a non-empty string`);
	if (!isStringArray(paths) || paths.length === 0) fail(`rules[${index}].paths must be a non-empty list of globs`);
	if (union !== undefined && typeof union !== 'boolean') fail(`rules[${index}].union must be true or false`);
	if (regen !== undefined && (typeof regen !== 'string' || regen === ''))
		fail(`rules[${index}].regen must be a command`);
	if (union && regen !== undefined) fail(`rules[${index}] can't both union and regen`);
	const rule: Rule = { cause, paths };
	if (union) rule.union = true;
	if (regen !== undefined) rule.regen = regen;
	return rule;
}

export function parseConfig(text: string): Config {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		fail(`not JSON: ${(error as Error).message}`);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be an object');
	const {
		rules = [],
		approvers = [],
		since = '30 days ago',
		label = 'needs-owner',
		...rest
	} = value as Record<string, unknown>;
	const unknownKeys = Object.keys(rest).filter((key) => key !== '$schema');
	if (unknownKeys.length > 0) fail(`unknown keys: ${unknownKeys.join(', ')}`);
	if (!Array.isArray(rules)) fail('rules must be a list');
	if (!isStringArray(approvers)) fail('approvers must be a list of logins');
	if (typeof since !== 'string' || since === '') fail('since must be a date git understands');
	if (typeof label !== 'string' || label === '') fail('label must be a non-empty string');
	return { rules: rules.map(parseRule), approvers, since, label };
}

export function matches(rule: Rule, path: string): boolean {
	return rule.paths.some((glob) => posix.matchesGlob(path, glob));
}

/** The first rule that names `path`. */
export function ruleFor(config: Config, path: string): Rule | undefined {
	return config.rules.find((rule) => matches(rule, path));
}

/**
 * .gitattributes lines that turn on git's union merge for every `union` rule's globs. They go after
 * the default branch's own lines, so they win over any earlier line for the same files. Each is
 * anchored with a leading `/`, since git matches a pattern without a slash at any depth and the
 * config's globs match from the root.
 */
export function unionAttributes(config: Config): string {
	return config.rules
		.filter((rule) => rule.union)
		.flatMap((rule) => rule.paths.map((glob) => `/${glob} merge=union\n`))
		.join('');
}
