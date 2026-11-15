import { join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/error-brand-D4i1NkSd.mjs
/**
* Prototype brand read by {@link isEvlogError}. `instanceof` compares class
* identity, which differs between duplicate installs of evlog, a
* registry-shared symbol does not.
*
* @internal
*/
const evlogErrorBrand = Symbol.for("evlog.error.brand");
/**
* Whether `error` is an `EvlogError`, including one thrown by a different copy
* of evlog. Kept out of `error.ts` so browser-side callers such as `parseError`
* can ask the question without pulling the class into their bundle.
*
* @internal Use `EvlogError.isEvlogError` from application code.
*/
function isEvlogError(error) {
	return typeof error === "object" && error !== null && error[evlogErrorBrand] === true;
}

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/utils.mjs
/**
* Milliseconds elapsed since `startTime`, never negative.
*
* `Date.now()` is wall-clock: an NTP step or a manual clock change during a
* request can move it backwards. Clamping keeps the duration a valid
* non-negative measurement rather than leaking a negative number to drains.
*/
function elapsedMs(startTime) {
	return Math.max(0, Date.now() - startTime);
}
function formatDuration(ms) {
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	return `${(ms / 1e3).toFixed(2)}s`;
}
function isBrowser() {
	if (typeof window === "undefined") return false;
	if (typeof document === "undefined") return false;
	if (typeof navigator !== "undefined" && navigator.product === "ReactNative") return false;
	return true;
}
function isDev() {
	if (typeof process !== "undefined") return process.env.NODE_ENV !== "production";
	if (typeof window !== "undefined") return true;
	return false;
}
function detectEnvironment() {
	const env = typeof process !== "undefined" ? process.env : {};
	const defaultEnvironment = isDev() ? "development" : "production";
	return {
		environment: env.NODE_ENV || defaultEnvironment,
		service: env.SERVICE_NAME || "app",
		version: env.APP_VERSION,
		commitHash: env.COMMIT_SHA || env.GITHUB_SHA || env.VERCEL_GIT_COMMIT_SHA || env.CF_PAGES_COMMIT_SHA,
		region: env.VERCEL_REGION || env.AWS_REGION || env.FLY_REGION || env.CF_REGION
	};
}
const LEVEL_ORDER = {
	trace: 0,
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	fatal: 4
};
/**
* True if `level` is at least as severe as `minLevel`
* (trace and debug < info < warn < error < fatal).
* Trace shares debug's rank: visibility is gated like debug, retention is the
* opt-in via `sampling.rates.trace` (default 0).
*/
function isLevelEnabled(level, minLevel) {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}
/**
* Console method for a level. `console.fatal` / `console.trace` do not exist:
* fatal prints as error, trace prints as log (like debug).
*/
function getConsoleMethod(level) {
	if (level === "fatal") return "error";
	if (level === "trace") return "log";
	return level;
}
const colors = {
	reset: "\x1B[0m",
	bold: "\x1B[1m",
	dim: "\x1B[2m",
	red: "\x1B[31m",
	green: "\x1B[32m",
	yellow: "\x1B[33m",
	blue: "\x1B[34m",
	magenta: "\x1B[35m",
	cyan: "\x1B[36m",
	white: "\x1B[37m",
	gray: "\x1B[90m"
};
const levelColorMap = {
	error: colors.red,
	fatal: colors.red,
	warn: colors.yellow,
	info: colors.cyan,
	debug: colors.gray,
	trace: colors.gray
};
function getLevelColor(level) {
	return levelColorMap[level] ?? colors.white;
}
const cssColors = {
	dim: "color: #6b7280",
	red: "color: #ef4444; font-weight: bold",
	green: "color: #22c55e",
	yellow: "color: #f59e0b; font-weight: bold",
	cyan: "color: #06b6d4; font-weight: bold",
	gray: "color: #6b7280; font-weight: bold",
	reset: "color: inherit; font-weight: normal"
};
const cssLevelColorMap = {
	error: cssColors.red,
	fatal: cssColors.red,
	warn: cssColors.yellow,
	info: cssColors.cyan,
	debug: cssColors.gray,
	trace: cssColors.gray
};
function getCssLevelColor(level) {
	return cssLevelColorMap[level] ?? cssColors.reset;
}
/**
* Escape `%` in strings interpolated into `console.log` format strings
* to prevent `%c`, `%s`, `%d` etc. in user data from being interpreted
* as formatting directives.
*/
function escapeFormatString(str) {
	return str.replace(/%/g, "%%");
}
const CONTROL_CHAR = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/g;
/**
* Escape control characters in a value printed to a terminal, so it cannot
* move the cursor, erase or start a line, or send an escape sequence.
* Tab is kept, newline and carriage return become `\n` and `\r`, and the
* others become `\uXXXX` (`\u001b` for ESC).
*/
function escapeControlChars(str) {
	return str.replace(CONTROL_CHAR, (char) => {
		if (char === "\n") return "\\n";
		if (char === "\r") return "\\r";
		return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}
/**
* True when a message string contains a `%s`, `%d` or `%j` specifier, so
* trailing log arguments have something to interpolate into.
*/
function hasMessageSpecifiers(format) {
	return /%[sdj]/.test(format);
}
/**
* Interpolate trailing log arguments into a message with the printf subset
* pino and consola call sites rely on: `%s`, `%d`, `%j` and `%%`. Unknown
* specifiers and specifiers past the last argument stay literal, surplus
* arguments are appended space-separated, and a message without arguments is
* returned unchanged. Objects and arrays render as JSON instead of node's
* `util.inspect` to keep the formatter free of bundle weight.
*
* @param format - Message possibly containing format specifiers
* @param args - Values for the specifiers
*/
function formatMessage(format, args) {
	if (args.length === 0) return format;
	let argIndex = 0;
	const interpolated = format.replace(/%(.)/g, (specifier, char) => {
		if (char === "%") return "%";
		if (char !== "s" && char !== "d" && char !== "j") return specifier;
		if (argIndex >= args.length) return specifier;
		return renderMessageValue(char, args[argIndex++]);
	});
	if (argIndex >= args.length) return interpolated;
	const extras = [];
	while (argIndex < args.length) extras.push(renderMessageValue("s", args[argIndex++]));
	return `${interpolated} ${extras.join(" ")}`;
}
function renderMessageValue(specifier, value) {
	if (specifier === "j") return renderMessageJson(value);
	if (typeof value === "bigint") return `${value}n`;
	if (specifier === "d") return String(Number(value));
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return String(value);
	return renderMessageJson(value);
}
function renderMessageJson(value) {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
/** Headers that should never be passed to hooks for security */
const SENSITIVE_HEADERS = [
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"proxy-authorization"
];
const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADERS);
const patternCache = /* @__PURE__ */ new Map();
/**
* Compile a glob pattern to a anchored RegExp.
*
* - `*` matches any characters except the separator
* - `**` matches any characters including the separator
* - `?` matches one character except the separator
*/
function globToRegExp(pattern, separator = "/") {
	const cacheKey = `${separator}:${pattern}`;
	let regex = patternCache.get(cacheKey);
	if (!regex) {
		const segment = separator === "/" ? "[^/]*" : "[^.]*";
		const char = separator === "/" ? "[^/]" : "[^.]";
		const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "{{GLOBSTAR}}").replace(/\*/g, segment).replace(/{{GLOBSTAR}}/g, ".*").replace(/\?/g, char);
		regex = new RegExp(`^${regexPattern}$`);
		patternCache.set(cacheKey, regex);
	}
	return regex;
}
/**
* Match a path against a glob pattern.
* Supports * (any chars except /) and ** (any chars including /).
*/
function matchesPattern(path, pattern) {
	return globToRegExp(pattern, "/").test(path);
}
/** Reused Date for ISO formatting — avoids allocating on second rollover. */
const _isoDate = /* @__PURE__ */ new Date();
let _isoCachedSecond = -1;
let _isoCachedPrefix = "";
/**
* Current wall-clock time as an ISO-8601 UTC string (`YYYY-MM-DDTHH:mm:ss.sssZ`).
*
* Caches the formatted prefix through the second and only appends milliseconds on
* each call — same technique as pino / h3's logger, so hot emit paths avoid
* re-running `toISOString()` thousands of times per second.
*/
function isoNow() {
	const now = Date.now();
	const sec = Math.floor(now / 1e3);
	if (sec !== _isoCachedSecond) {
		_isoCachedSecond = sec;
		_isoDate.setTime(now);
		_isoCachedPrefix = _isoDate.toISOString().slice(0, 19);
	}
	return `${_isoCachedPrefix}.${String(now % 1e3).padStart(3, "0")}Z`;
}
/**
* Reads a field of an error the way the serializers copy it. The legacy
* `statusCode`, `statusText` and `statusMessage` of an `EvlogError` are getters
* over `status` and `message`, so they are read from those fields directly and
* the getters are left for user code to call.
*/
function readErrorField(error, key) {
	if (isEvlogError(error)) {
		if (key === "statusCode") return error.status;
		if (key === "statusText" || key === "statusMessage") return error.message;
	}
	return error[key];
}

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/globalRegistry-DxlJ7DCO.mjs
function logPluginError(name, hook, err) {
	console.error(`[evlog/${name}] ${hook} failed:`, err);
}
/** De-duplicates by `name` — last registration wins. */
function createPluginRunner(plugins = []) {
	const byName = /* @__PURE__ */ new Map();
	for (const plugin of plugins) byName.set(plugin.name, plugin);
	const list = Array.from(byName.values());
	return {
		plugins: list,
		hasEnrich: list.some((p) => typeof p.enrich === "function"),
		hasDrain: list.some((p) => typeof p.drain === "function"),
		hasKeep: list.some((p) => typeof p.keep === "function"),
		hasRequestLifecycle: list.some((p) => typeof p.onRequestStart === "function" || typeof p.onRequestFinish === "function"),
		hasClientLog: list.some((p) => typeof p.onClientLog === "function"),
		hasExtendLogger: list.some((p) => typeof p.extendLogger === "function"),
		applyExtendLogger(logger) {
			for (const plugin of list) {
				if (!plugin.extendLogger) continue;
				try {
					plugin.extendLogger(logger);
				} catch (err) {
					logPluginError(plugin.name, "extendLogger", err);
				}
			}
		},
		runOnRequestStart(ctx) {
			for (const plugin of list) {
				if (!plugin.onRequestStart) continue;
				try {
					plugin.onRequestStart(ctx);
				} catch (err) {
					logPluginError(plugin.name, "onRequestStart", err);
				}
			}
		},
		runOnRequestFinish(ctx) {
			for (const plugin of list) {
				if (!plugin.onRequestFinish) continue;
				try {
					plugin.onRequestFinish(ctx);
				} catch (err) {
					logPluginError(plugin.name, "onRequestFinish", err);
				}
			}
		},
		async runEnrich(ctx) {
			for (const plugin of list) {
				if (!plugin.enrich) continue;
				try {
					await plugin.enrich(ctx);
				} catch (err) {
					logPluginError(plugin.name, "enrich", err);
				}
			}
		},
		async runDrain(ctx) {
			const drains = list.filter((p) => typeof p.drain === "function");
			if (drains.length === 0) return;
			await Promise.allSettled(drains.map(async (plugin) => {
				try {
					await plugin.drain(ctx);
				} catch (err) {
					logPluginError(plugin.name, "drain", err);
				}
			}));
		},
		async runKeep(ctx) {
			for (const plugin of list) {
				if (!plugin.keep) continue;
				try {
					await plugin.keep(ctx);
				} catch (err) {
					logPluginError(plugin.name, "keep", err);
				}
			}
		},
		runOnClientLog(ctx) {
			for (const plugin of list) {
				if (!plugin.onClientLog) continue;
				try {
					plugin.onClientLog(ctx);
				} catch (err) {
					logPluginError(plugin.name, "onClientLog", err);
				}
			}
		},
		async runSetup(ctx) {
			for (const plugin of list) {
				if (!plugin.setup) continue;
				try {
					await plugin.setup(ctx);
				} catch (err) {
					logPluginError(plugin.name, "setup", err);
				}
			}
		}
	};
}
const emptyRunner = createPluginRunner([]);
/** Shared no-op runner used when no plugins are registered. */
function getEmptyPluginRunner() {
	return emptyRunner;
}
/**
* Major version this build belongs to. Bump on every major release — the
* registry key embeds it so two majors never share mutable state.
*
* Kept in sync with `package.json` by `test/toolkit/duplicate-install.test.ts`.
*/
const EVLOG_MAJOR = 2;
/**
* Registry key. Every 2.x copy of evlog in a dependency graph resolves the
* same slot, so `initLogger()` and `withEvlog()` work across duplicate installs
* (pnpm/bun hash our 18 optional peers into store paths, so two workspaces
* resolving `ai` or `zod` differently get physically distinct evlog copies).
*/
const REGISTRY_KEY = Symbol.for(`evlog.registry.v${EVLOG_MAJOR}`);
/** Unversioned slot used only to detect — and warn about — multi-major installs. */
const MAJORS_KEY = Symbol.for("evlog.majors");
function createConfig() {
	return {
		env: {
			service: "app",
			environment: "development"
		},
		pretty: isDev(),
		prettyError: {
			snippet: isDev(),
			stackDepth: 2,
			compact: isDev(),
			detail: "full"
		},
		sampling: {},
		stringify: true,
		drain: void 0,
		redact: void 0,
		enabled: true,
		silent: false,
		minLevel: "debug",
		locked: false,
		initialized: false,
		warnedUninitialized: false,
		pluginRunner: getEmptyPluginRunner()
	};
}
function warnOnMultiMajor(host) {
	const majors = host[MAJORS_KEY] ??= /* @__PURE__ */ new Set();
	if (majors.has(EVLOG_MAJOR)) return;
	majors.add(EVLOG_MAJOR);
	if (majors.size > 1) console.warn(`[evlog] Multiple major versions of evlog are loaded in this process (${[...majors].map((m) => `${m}.x`).join(", ")}). They cannot share request scope or logger configuration: events emitted through the other copy will be undrained and unredacted, and useLogger() may throw. Deduplicate evlog to a single major.`);
}
function getRegistry() {
	const host = globalThis;
	warnOnMultiMajor(host);
	return host[REGISTRY_KEY] ??= {
		config: createConfig(),
		storages: /* @__PURE__ */ new Map()
	};
}
/**
* The shared logger configuration record. The reference is stable for the
* lifetime of the process, so callers may hold it at module scope.
*/
const globalConfig = getRegistry().config;

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/pretty-error-O-wT2Lsc.mjs
let snippetReader = null;
/** Tree-only breathing line (connector without content). */
const PRETTY_ERROR_TREE_SPACER = "__EVLOG_TREE_SPACER__";
function pushTreeSpacer(children) {
	children.push(PRETTY_ERROR_TREE_SPACER);
}
const SKIP_PATH_RE = /(?:^|[/\\])(?:node_modules|\.nuxt|\.next|\.output)(?:[/\\]|$)/;
const SKIP_FRAME_PATH_RE = /(?:^|[/\\])(?:packages[/\\]evlog|evlog[/\\](?:dist|src))(?:[/\\]|$)/;
const SKIP_FRAME_FN_RE = /^(?:createError|EvlogError|new EvlogError)$/;
function isPlainObject$2(val) {
	return val !== null && typeof val === "object" && !Array.isArray(val);
}
function pickString(obj, key) {
	const val = obj[key];
	return typeof val === "string" && val.length > 0 ? val : void 0;
}
function pickNumber(obj, key) {
	const val = obj[key];
	return typeof val === "number" ? val : void 0;
}
function extractGuidance(data) {
	return {
		code: pickString(data, "code"),
		why: pickString(data, "why"),
		fix: pickString(data, "fix"),
		link: pickString(data, "link")
	};
}
/**
* Extract structured error fields from a wide-event `error` value.
*/
function normalizeErrorContext(error) {
	if (error === null || error === void 0) return null;
	if (typeof error === "string") return { message: error };
	if (!isPlainObject$2(error)) return { message: String(error) };
	const result = {
		message: pickString(error, "message") ?? pickString(error, "statusText") ?? pickString(error, "statusMessage") ?? "Unknown error",
		name: pickString(error, "name"),
		code: pickString(error, "code"),
		why: pickString(error, "why"),
		fix: pickString(error, "fix"),
		link: pickString(error, "link"),
		status: pickNumber(error, "status") ?? pickNumber(error, "statusCode"),
		stack: pickString(error, "stack")
	};
	const { data, cause } = error;
	if (isPlainObject$2(data)) {
		const guidance = extractGuidance(data);
		if (!result.code) result.code = guidance.code;
		if (!result.why) result.why = guidance.why;
		if (!result.fix) result.fix = guidance.fix;
		if (!result.link) result.link = guidance.link;
	}
	if (cause instanceof Error) result.cause = cause.message;
	else if (isPlainObject$2(cause) && pickString(cause, "message")) result.cause = pickString(cause, "message");
	return result;
}
/** Decode a `file://` URL or path for display and snippet lookup. */
function decodeFileUrl(file) {
	if (file.startsWith("file://")) try {
		return decodeURIComponent(new URL(file).pathname);
	} catch {
		return file.slice(7);
	}
	return file;
}
function isAppPath(file) {
	const normalized = decodeFileUrl(file).replace(/\\/g, "/");
	if (normalized.startsWith("node:")) return false;
	if (SKIP_PATH_RE.test(normalized)) return false;
	if (isFrameworkRuntimePath(normalized)) return false;
	return true;
}
function formatDisplayPath(file, cwd) {
	const decoded = decodeFileUrl(file).replace(/\\/g, "/");
	const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	if (cwdNorm && decoded.startsWith(`${cwdNorm}/`)) {
		const rel = decoded.slice(cwdNorm.length + 1);
		return rel.startsWith("./") ? rel.slice(2) : rel;
	}
	const serverIdx = decoded.indexOf("/server/");
	if (serverIdx >= 0) return decoded.slice(serverIdx + 1);
	const srcIdx = decoded.indexOf("/src/");
	if (srcIdx >= 0) return decoded.slice(srcIdx + 1);
	return decoded;
}
/**
* Compact a stack trace for wide-event storage (drains, NDJSON).
* Drops node_modules, build output, and evlog internals; keeps up to five useful frames.
* Returns the stack unchanged when no app frame survives the filter.
*/
function compactStackForStorage(stack, maxFrames = 5) {
	if (!stack) return void 0;
	const head = stack.split("\n")[0] ?? "";
	const useful = parseStackFrames(stack).filter((f) => f.file && f.line && f.isApp && !isInternalErrorFrame(f)).slice(0, maxFrames);
	if (useful.length === 0) return stack;
	return [head, ...useful.map((f) => f.raw)].join("\n");
}
/** `file:line:column`, the end of a frame line. */
const FRAME_LOCATION = /^(.+):(\d+):(\d+)$/;
/**
* Parse a V8 stack trace string into frames.
*/
function parseStackFrames(stack) {
	if (!stack) return [];
	const lines = stack.split("\n");
	const frames = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("at ")) continue;
		const open = trimmed.indexOf(" (", 4);
		const withFn = open !== -1 && trimmed.endsWith(")") ? trimmed.slice(open + 2, -1).match(FRAME_LOCATION) : null;
		if (withFn) {
			const [, file, lineStr, colStr] = withFn;
			frames.push({
				raw: trimmed,
				fn: trimmed.slice(3, open),
				file,
				line: Number(lineStr),
				column: Number(colStr),
				isApp: isAppPath(file)
			});
			continue;
		}
		const withoutFn = trimmed.slice(3).match(FRAME_LOCATION);
		if (withoutFn) {
			const [, file, lineStr, colStr] = withoutFn;
			frames.push({
				raw: trimmed,
				file,
				line: Number(lineStr),
				column: Number(colStr),
				isApp: isAppPath(file)
			});
		}
	}
	return frames;
}
/** True for Next.js runtime internals (route-modules, next/dist, bundled next-server). */
function isFrameworkRuntimePath(path) {
	const normalized = path.replace(/\\/g, "/");
	return normalized.includes("route-modules/") || normalized.includes("webpack://next/") || normalized.includes("/next/dist/") || normalized.includes("/compiled/next-server/");
}
function isFrameworkRuntimeFrame(frame) {
	if (!frame.file) return false;
	return isFrameworkRuntimePath(decodeFileUrl(frame.file));
}
function isInternalErrorFrame(frame) {
	if (isFrameworkRuntimeFrame(frame)) return true;
	if (frame.fn) {
		const fn = frame.fn.replace(/^async /, "");
		if (SKIP_FRAME_FN_RE.test(fn)) return true;
	}
	if (!frame.file) return true;
	const path = decodeFileUrl(frame.file).replace(/\\/g, "/");
	if (SKIP_FRAME_PATH_RE.test(path)) return true;
	if (path.includes(".nuxt/")) return true;
	if (path.includes(".next/")) return true;
	return false;
}
/**
* Pick the most useful frame for code snippets (topmost app throw site).
*/
function pickPrimaryFrame(frames) {
	for (const frame of frames) if (frame.isApp && frame.file && frame.line && !isInternalErrorFrame(frame)) return frame;
}
/**
* Read source lines around a stack frame when a server snippet reader is registered.
*/
function readCodeSnippet(file, line, contextLines = 2) {
	if (!isDev() || isBrowser() || !snippetReader) return null;
	const path = decodeFileUrl(file).replace(/\\/g, "/");
	if (path.includes(".next/") || path.includes(".nuxt/") || path.includes(".output/")) return null;
	return snippetReader(file, line, contextLines);
}
function formatSnippetLines(snippet) {
	const width = String(snippet[snippet.length - 1]?.line ?? 0).length;
	return snippet.map(({ line, content, isErrorLine }) => {
		const marker = isErrorLine ? `${colors.red}❯${colors.reset}` : `${colors.dim} ${colors.reset}`;
		const numColor = isErrorLine ? colors.red : colors.gray;
		const trimmed = content.length > 120 ? `${content.slice(0, 117)}…` : content;
		return `${marker} ${numColor}${String(line).padStart(width, " ")}${colors.reset} ${colors.dim}┃${colors.reset} ${colors.dim}${trimmed}${colors.reset}`;
	});
}
function formatFrameLocation(frame, cwd) {
	const file = frame.file ? formatDisplayPath(frame.file, cwd) : "unknown";
	const loc = frame.line ? `${file}:${frame.line}` : file;
	const fn = frame.fn && frame.fn !== "<unknown>" ? frame.fn : void 0;
	return fn ? `at ${fn} (${loc})` : `at ${loc}`;
}
function formatCollapsedFrame(frame, cwd) {
	const file = frame.file ? formatDisplayPath(frame.file, cwd) : "unknown";
	const loc = frame.line ? `${file}:${frame.line}` : file;
	const prefix = frame.fn?.startsWith("async") ? "at async " : "at ";
	const fn = frame.fn?.replace(/^async /, "");
	if (fn && fn !== "<unknown>" && fn !== loc) return `${prefix}${fn} (${loc})`;
	return `${prefix}${loc}`;
}
const GUIDANCE_WRAP_WIDTH = 76;
const GUIDANCE_CONTINUATION = "     ";
/** Wrap guidance text with hanging indent for long Why/Fix lines. */
function formatGuidanceLine(label, text, labelColor) {
	const prefix = `${labelColor}${label}:${colors.reset} `;
	const lines = [];
	let remaining = text.trim();
	let first = true;
	while (remaining.length > 0) {
		const budget = first ? Math.max(24, GUIDANCE_WRAP_WIDTH - prefix.length) : Math.max(24, 71);
		if (remaining.length <= budget) {
			lines.push(first ? `${prefix}${remaining}` : `${GUIDANCE_CONTINUATION}${remaining}`);
			break;
		}
		let split = remaining.lastIndexOf(" ", budget);
		if (split <= 0) split = budget;
		const chunk = remaining.slice(0, split).trimEnd();
		lines.push(first ? `${prefix}${chunk}` : `${GUIDANCE_CONTINUATION}${chunk}`);
		remaining = remaining.slice(split).trimStart();
		first = false;
	}
	return lines;
}
/**
* Build pretty-print tree entries for a wide-event `error` field.
*/
function buildErrorEntries(error, options = {}) {
	const normalized = normalizeErrorContext(error);
	if (!normalized) return [];
	const printable = isBrowser() ? (text) => text : escapeControlChars;
	const cwd = options.cwd ?? (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : ".");
	const compact = options.compact ?? isDev();
	const guidanceOnly = (options.detail ?? "full") === "guidance";
	const showFrames = !guidanceOnly && !isBrowser() && (options.snippet ?? isDev());
	const stackDepth = guidanceOnly ? 0 : options.stackDepth ?? (compact ? 2 : 3);
	const snippetContextLines = compact ? 1 : 2;
	const children = [];
	const frames = guidanceOnly ? [] : parseStackFrames(normalized.stack);
	const primary = guidanceOnly ? void 0 : pickPrimaryFrame(frames);
	if (!guidanceOnly && primary?.file && primary.line) {
		pushTreeSpacer(children);
		if (showFrames) {
			const snippet = readCodeSnippet(primary.file, primary.line, snippetContextLines);
			children.push(`${colors.dim}   ${printable(formatFrameLocation(primary, cwd))}${colors.reset}`);
			if (snippet) children.push(...formatSnippetLines(snippet));
		} else children.push(`${colors.dim}   ${printable(formatFrameLocation(primary, cwd))}${colors.reset}`);
	}
	if (normalized.code) children.push(`${colors.dim}Code:${colors.reset} ${printable(normalized.code)}`);
	if (Boolean(normalized.why || normalized.fix || normalized.link)) pushTreeSpacer(children);
	if (normalized.why) children.push(...formatGuidanceLine("Why", printable(normalized.why), colors.yellow));
	if (normalized.fix) children.push(...formatGuidanceLine("Fix", printable(normalized.fix), colors.cyan));
	if (normalized.link) children.push(`${colors.dim}More:${colors.reset} ${printable(normalized.link)}`);
	if (normalized.cause && normalized.cause !== normalized.message) children.push(`${colors.dim}Caused by:${colors.reset} ${printable(normalized.cause)}`);
	const hiddenCount = guidanceOnly ? 0 : frames.filter((f) => !f.isApp || isInternalErrorFrame(f)).length;
	const tailFrames = stackDepth > 0 ? frames.filter((f) => f !== primary && !isInternalErrorFrame(f)).slice(0, stackDepth) : [];
	if (!guidanceOnly && (hiddenCount > 0 || tailFrames.length > 0)) {
		pushTreeSpacer(children);
		if (hiddenCount > 0) children.push(`${colors.gray}stack (${hiddenCount} frame${hiddenCount === 1 ? "" : "s"} hidden in node_modules)${colors.reset}`);
		else children.push(`${colors.gray}stack${colors.reset}`);
		for (const frame of tailFrames) children.push(`${colors.gray}  ${printable(formatCollapsedFrame(frame, cwd))}${colors.reset}`);
	}
	return [{
		key: "error",
		value: `${colors.red}${colors.bold}${printable(normalized.message)}${colors.reset}`,
		children: children.length > 0 ? children : void 0
	}];
}

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/dev-terminal-CDXEC6Wl.mjs
const DEV_PRESETS = {
	evlog: {
		frameworkOverlay: false,
		detail: "full"
	},
	nitro: {
		frameworkOverlay: true,
		detail: "guidance"
	},
	both: {
		frameworkOverlay: true,
		detail: "full"
	}
};
function finalizePrettyError(partial, frameworkOverlay, pretty, inDev) {
	const compact = partial.compact ?? (inDev && pretty);
	const detail = partial.detail ?? (frameworkOverlay ? "guidance" : "full");
	const stackDepth = detail === "guidance" ? 0 : partial.stackDepth ?? (compact ? 2 : 3);
	return {
		snippet: partial.snippet ?? (detail === "full" && pretty && inDev),
		stackDepth,
		compact,
		detail
	};
}
/**
* Resolve dev terminal settings from `dev` presets or explicit objects.
*/
function resolveDevTerminal(input = {}) {
	const pretty = input.pretty ?? isDev();
	const inDev = isDev();
	let frameworkOverlay;
	let prettyError = {};
	if (typeof input.dev === "string" && input.dev in DEV_PRESETS) {
		const { frameworkOverlay: presetOverlay, detail } = DEV_PRESETS[input.dev];
		frameworkOverlay = presetOverlay;
		prettyError = { detail };
	} else if (input.dev && typeof input.dev === "object") {
		const { frameworkOverlay: devOverlay, prettyError: devPrettyError } = input.dev;
		frameworkOverlay = devOverlay;
		if (devPrettyError) prettyError = devPrettyError;
	}
	if (frameworkOverlay === void 0) frameworkOverlay = !(pretty && inDev);
	return {
		frameworkOverlay,
		prettyError: finalizePrettyError(prettyError, frameworkOverlay, pretty, inDev)
	};
}

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/wideEventChannel-BABjYpvc.mjs
let publisher = null;
/**
* Hand an emitted wide event to the registered publisher, if any.
*
* Subscriber failures are contained the same way drain failures are: logged,
* never propagated to the request.
*
* @internal
*/
function publishWideEvent(event) {
	if (!publisher) return;
	try {
		publisher(event);
	} catch (err) {
		console.error("[evlog] diagnostics channel publish failed:", err);
	}
}

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/serialize-error-CH3Pz-jz.mjs
/** Logged after `name`, `message` and `stack`, before `cause`. */
const ERROR_FIELDS = [
	"code",
	"status",
	"statusText",
	"statusCode",
	"statusMessage",
	"data",
	"internal",
	"why",
	"fix",
	"link"
];
const NONE = [];
/**
* The payload fields (`data`, `internal`) an error's own `toJSON` leaves out,
* which its serialized form leaves out too. `EvlogError#toJSON` shapes the HTTP
* response and omits `internal`, which logs keep, so it does not count.
*/
function payloadFieldsHiddenBy(error) {
	const { toJSON } = error;
	if (typeof toJSON !== "function" || isEvlogError(error)) return NONE;
	const shown = toJSON.call(error);
	return ["data", "internal"].filter((key) => typeof shown !== "object" || shown === null || !(key in shown));
}
/**
* h3 wraps a thrown error in an H3Error that keeps the original as `cause` and
* reads its stack from it, so the pair describe the same failure. Serializing
* both repeats the message, the stack and the payload.
*/
function isWrapperOf(error, cause) {
	return cause instanceof Error && cause !== error && cause.message === error.message && cause.stack === error.stack;
}
const H3_INPUT_FIELDS = {
	message: "message",
	stack: "stack",
	statusCode: "statusCode",
	status: "statusCode",
	statusMessage: "statusMessage",
	statusText: "statusMessage",
	data: "data",
	fatal: "fatal",
	unhandled: "unhandled"
};
/**
* h3's `createError({ statusCode, message })` keeps the options object itself
* as `cause`. It only restates fields the error already carries, so it counts
* as a copy when every key is one h3 reads and every value matches the error.
*/
function isH3InputOf(error, cause) {
	if (typeof cause !== "object" || cause === null || cause instanceof Error || Array.isArray(cause)) return false;
	const keys = Object.keys(cause);
	if (keys.length === 0) return false;
	const causeRecord = cause;
	return keys.every((key) => {
		const target = H3_INPUT_FIELDS[key];
		if (!target) return false;
		const value = causeRecord[key];
		if (value === void 0 || value === readErrorField(error, target)) return true;
		return target === "statusCode" && Number(value) === readErrorField(error, "statusCode");
	});
}
/**
* Builds the error serializer a logger uses. Both loggers share one, so an
* error is logged the same way on the server and in the browser.
*
* @param formatStack - Applied to every serialized stack. The server shortens
* stacks in development; the browser keeps them as they are.
*/
function createErrorSerializer(formatStack = (stack) => stack) {
	/**
	* `ancestors` holds the errors and objects on the current path, so a value
	* reached twice through different branches is kept and only a cycle is cut.
	*/
	function serialize(error, ancestors) {
		const { cause } = error;
		ancestors.add(error);
		if (isWrapperOf(error, cause) && !ancestors.has(cause)) {
			const serialized = serialize(cause, ancestors);
			const hidden = payloadFieldsHiddenBy(error);
			for (const key of [
				"statusCode",
				"statusMessage",
				"data"
			]) {
				const value = readErrorField(error, key);
				if (value !== void 0 && !hidden.includes(key)) serialized[key] = walk(value, ancestors);
			}
			ancestors.delete(error);
			return serialized;
		}
		const serialized = {
			name: error.name,
			message: error.message,
			stack: formatStack(error.stack)
		};
		const hidden = payloadFieldsHiddenBy(error);
		for (const key of ERROR_FIELDS) {
			const value = readErrorField(error, key);
			if (value !== void 0 && !hidden.includes(key)) serialized[key] = walk(value, ancestors);
		}
		if (isH3InputOf(error, cause)) {
			if (cause.fatal !== void 0) serialized.fatal = cause.fatal;
			if (cause.unhandled !== void 0) serialized.unhandled = cause.unhandled;
		} else if (cause !== void 0) serialized.cause = walk(cause, ancestors);
		ancestors.delete(error);
		return serialized;
	}
	/** Copies an object or array only once one of its values changes, so an event without errors is returned as it is. */
	function walk(value, ancestors) {
		if (value === null || typeof value !== "object") return value;
		if (ancestors.has(value)) return "[Circular]";
		if (value instanceof Error) return serialize(value, ancestors);
		if (typeof value.toJSON === "function") return value;
		ancestors.add(value);
		let copy;
		if (Array.isArray(value)) {
			let items;
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				const result = walk(item, ancestors);
				if (items) items[i] = result;
				else if (!Object.is(result, item)) (items = value.slice())[i] = result;
			}
			copy = items;
		} else {
			const entries = Object.entries(value);
			let changed = false;
			for (const entry of entries) {
				const result = walk(entry[1], ancestors);
				if (!Object.is(result, entry[1])) {
					entry[1] = result;
					changed = true;
				}
			}
			if (changed) {
				const proto = Object.getPrototypeOf(value);
				copy = Object.fromEntries(entries);
				if (proto !== Object.prototype) Object.setPrototypeOf(copy, proto);
			}
		}
		ancestors.delete(value);
		return copy ?? value;
	}
	return {
		serializeError: (error) => serialize(error, /* @__PURE__ */ new WeakSet()),
		serializeErrorsIn: (value) => walk(value, /* @__PURE__ */ new WeakSet())
	};
}

// node_modules/.pnpm/evlog@2.35.1/node_modules/evlog/dist/audit-CccFziel.mjs
const DEFAULT_REPLACEMENT = "[REDACTED]";
/** Literal prefixes of the `apiKeys` built-in, longest match first where one prefix extends another. */
const API_KEY_PREFIXES = [
	"github_pat_",
	"ghp_",
	"gho_",
	"ghu_",
	"ghs_",
	"ghr_",
	"npm_",
	"sk-ant-",
	"sk-proj-",
	"sk_live_",
	"rk_live_",
	"xoxb-",
	"xoxp-",
	"xapp-",
	"AKIA",
	"ASIA"
];
/**
* Normalize a redact path pattern.
* Single segments without wildcards are shorthand for `**.<segment>`.
*/
function normalizeRedactPathPattern(pattern) {
	if (!pattern.includes("*") && !pattern.includes(".")) return `**.${pattern}`;
	return pattern;
}
/**
* Compile `RedactConfig.paths` into exact paths, path globs, and key globs.
* Returns `undefined` when `patterns` is empty.
*/
function compileRedactPathMatchers(patterns) {
	if (!patterns?.length) return void 0;
	const exactPaths = /* @__PURE__ */ new Set();
	const pathGlobs = [];
	const keyGlobs = [];
	const caseInsensitiveLeaves = /* @__PURE__ */ new Set();
	for (const raw of patterns) {
		if (!raw.includes("*")) {
			if (raw.includes(".")) exactPaths.add(raw);
			else addPathGlobPattern(normalizeRedactPathPattern(raw), exactPaths, pathGlobs, caseInsensitiveLeaves);
			continue;
		}
		if (!raw.includes(".")) keyGlobs.push(globToRegExp(raw, "."));
		else addPathGlobPattern(raw, exactPaths, pathGlobs, caseInsensitiveLeaves);
	}
	if (exactPaths.size === 0 && pathGlobs.length === 0 && keyGlobs.length === 0 && caseInsensitiveLeaves.size === 0) return;
	return {
		exactPaths,
		pathGlobs,
		keyGlobs,
		caseInsensitiveLeaves
	};
}
/** `**.segment` also matches a top-level `segment` field. */
function addPathGlobPattern(pattern, exactPaths, pathGlobs, caseInsensitiveLeaves) {
	pathGlobs.push(globToRegExp(pattern, "."));
	const leaf = pattern.match(/^\*\*\.([^.?*]+)$/);
	if (leaf) {
		exactPaths.add(leaf[1]);
		caseInsensitiveLeaves.add(leaf[1].toLowerCase());
	}
}
/**
* Whether a field at `fullPath` (dot-notation from root) with leaf key `leafKey`
* should be fully redacted.
*/
function matchesRedactPath(fullPath, leafKey, matchers) {
	if (matchers.exactPaths.has(fullPath)) return true;
	if (matchers.caseInsensitiveLeaves.has(leafKey.toLowerCase())) return true;
	for (const glob of matchers.pathGlobs) {
		glob.lastIndex = 0;
		if (glob.test(fullPath)) return true;
	}
	for (const glob of matchers.keyGlobs) {
		glob.lastIndex = 0;
		if (glob.test(leafKey)) return true;
	}
	return false;
}
/**
* Resolve a {@link RedactReplacement} for one matched value.
*
* A throwing or non-string-returning function falls back to the default
* replacement: a broken policy must degrade to over-redaction, never to
* emitting the raw value it was meant to scrub.
*/
function resolveReplacement(replacement, matched, ctx) {
	if (typeof replacement === "string") return replacement;
	try {
		const result = replacement(matched, ctx);
		if (typeof result !== "string") {
			console.error(`[evlog] redact replacement returned ${typeof result} for "${ctx.path}", expected string — using ${DEFAULT_REPLACEMENT}`);
			return DEFAULT_REPLACEMENT;
		}
		return result;
	} catch (err) {
		console.error(`[evlog] redact replacement failed for "${ctx.path}":`, err);
		return DEFAULT_REPLACEMENT;
	}
}
/**
* Redact fields matching path globs recursively. Mutates `obj` in place (use on a clone).
*/
function redactPathsInTree(obj, matchers, replacement, prefix = "") {
	if (obj === null || obj === void 0) return;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			const segment = String(i);
			const fullPath = prefix ? `${prefix}.${segment}` : segment;
			redactPathsInTree(obj[i], matchers, replacement, fullPath);
		}
		return;
	}
	if (typeof obj === "object") {
		const record = obj;
		for (const key of redactableKeys(record)) {
			const fullPath = prefix ? `${prefix}.${key}` : key;
			if (matchesRedactPath(fullPath, key, matchers)) setRedacted(record, key, resolveReplacement(replacement, record[key], {
				path: fullPath,
				key
			}), fullPath);
			else redactPathsInTree(record[key], matchers, replacement, fullPath);
		}
	}
}
/**
* Own enumerable keys only.
*
* `for…in` walks the prototype chain, which on platform objects hands back
* getter-only accessors — a `DOMException` cause yields `code`, `name` and 25
* legacy constants, none of them assignable. Own keys keep the walk on data the
* caller actually set, on plain records and class instances alike.
*/
function redactableKeys(record) {
	return Object.keys(record);
}
/**
* Write a redacted value onto a record evlog does not own. `Reflect.set` reports
* failure instead of throwing, so a field that cannot be scrubbed degrades to a
* warning rather than taking down the request that produced the event.
*/
function setRedacted(record, key, value, path) {
	if (Reflect.set(record, key, value)) return;
	const desc = Object.getOwnPropertyDescriptor(record, key);
	if (desc && "value" in desc && desc.configurable) {
		Object.defineProperty(record, key, {
			...desc,
			value
		});
		return;
	}
	console.warn(`[evlog] redact could not rewrite read-only field "${path}" — value left as-is`);
}
/**
* Built-in PII detection patterns with smart masking.
* Each builtin preserves just enough signal for debugging while scrubbing PII.
* They run on every string of every wide event, so each must stay linear in the input length.
* They run in this order. Bearer comes first so its token is masked whole before
* a shorter pattern rewrites part of it. The credential patterns follow for the same
* reason: `email` would otherwise rewrite the `pass@host` part of a URL first.
* IBAN comes before credit cards, whose pattern matches the digits inside a spaced
* IBAN and would leave the rest of it in the clear.
*/
const builtinPatterns = {
	/** Bearer tokens → Bearer *** */
	bearer: {
		pattern: /\bBearer\s+[\w\-.~+/]{8,}=*/gi,
		mask: () => "Bearer ***"
	},
	/** Provider API keys and tokens by fixed prefix → ghp_*** (GitHub, npm, Anthropic, OpenAI, Stripe, Slack, AWS) */
	apiKeys: {
		pattern: /github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{36,}|npm_[A-Za-z0-9]{36,}|sk-ant-[A-Za-z0-9_-]{32,}|sk-proj-[A-Za-z0-9_-]{32,}|[sr]k_live_[A-Za-z0-9]{24,}|xox[bp]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
		mask: (m) => `${API_KEY_PREFIXES.find((prefix) => m.startsWith(prefix)) ?? ""}***`
	},
	/** PEM private key blocks → -----BEGIN RSA PRIVATE KEY-----*** */
	privateKey: {
		pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
		mask: (m) => `${m.slice(0, m.indexOf("-----", 5) + 5)}***`
	},
	/** URLs with a password → postgres://user:***@host, redis://:***@host */
	urlPassword: {
		pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@]{0,256}:(?!\d{1,5}[?#])[^\s/@]+(?:@[^\s/?#@]*)*@/gi,
		mask: (m) => `${m.slice(0, m.indexOf(":", m.indexOf("://") + 3) + 1)}***@`
	},
	/** IBAN → FR76****189 (country + check digits + last 3) */
	iban: {
		pattern: /\b[A-Z]{2}\d{2}[\s-]?[\dA-Z]{4}[\s-]?[\dA-Z]{4}[\s-]?[\dA-Z]{4}[\s-]?[\dA-Z]{0,4}[\s-]?[\dA-Z]{0,4}[\s-]?[\dA-Z]{0,4}\b/g,
		mask: (m) => {
			const clean = m.replace(/[\s-]/g, "");
			return `${clean.slice(0, 4)}****${clean.slice(-3)}`;
		}
	},
	/** Credit card numbers → ****1111 (PCI DSS: last 4 allowed) */
	creditCard: {
		pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
		mask: (m) => `****${m.replace(/[\s-]/g, "").slice(-4)}`
	},
	/** Email addresses → a***@***.com */
	email: {
		pattern: /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})*\.[a-zA-Z]{2,63}\b/g,
		mask: (m) => {
			if (m.indexOf("@") < 1) return "***@***";
			const tld = m.slice(m.lastIndexOf("."));
			return `${m[0]}***@***${tld}`;
		}
	},
	/** IPv4 addresses → ***.***.***.100 (last octet only) */
	ipv4: {
		pattern: /\b(?!0\.0\.0\.0\b)(?!127\.0\.0\.1\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
		mask: (m) => `***.***.***.${m.split(".").pop()}`
	},
	/**
	* International phone numbers → `+33******78` (country code + last 2 digits).
	*
	* Requires an explicit phone signal (`+countryCode` prefix or `(areaCode)`
	* parens) to avoid false positives on digit-rich identifiers (UUIDs,
	* idempotency keys, order ids, hex hashes). Bare digit runs like `12345678`
	* are intentionally not matched — opt in via custom `patterns` if your app
	* stores phones in unformatted form.
	*/
	phone: {
		pattern: /(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?|\(\d{1,4}\))(?:[\s.-]?\d{2,4}){2,4}\b/g,
		mask: (m) => {
			const digits = m.replace(/[^\d]/g, "");
			if (m.startsWith("+") && digits.length > 4) {
				const ccMatch = m.match(/^\+\d{1,3}/);
				return `${ccMatch ? ccMatch[0] : "+"}******${digits.slice(-2)}`;
			}
			if (digits.length > 2) return `${"*".repeat(digits.length - 2)}${digits.slice(-2)}`;
			return "***";
		}
	},
	/** JWT tokens → eyJ***.*** */
	jwt: {
		pattern: /\beyJ(?:(?!-eyJ)[\w-])*\.[\w-]*\.[\w-]*\b/g,
		mask: () => "eyJ***.***"
	}
};
/** Built-ins that run only when listed in `builtins`: `redact: true` and a config without `builtins` leave them off. */
const OPT_IN_BUILTINS = /* @__PURE__ */ new Set([
	"apiKeys",
	"privateKey",
	"urlPassword"
]);
/**
* Keys whose name ends in `password`, `passwd`, `secret` or `token`, case-insensitive:
* `password`, `newPassword`, `client_secret`, `accessToken`, `API_TOKEN`. Plural
* counters such as `totalTokens` or `tokensPerSecond` do not match.
*/
const SECRET_KEY = /(?:password|passwd|secret|token)$/i;
/**
* Replace every value stored under a {@link SECRET_KEY} key, at any depth.
* Booleans and `null` carry no secret (`hasPassword: true`) and are kept.
* Mutates `obj` in place (use on a clone).
*/
function redactSecretKeys(obj, replacement, prefix = "") {
	if (obj === null || typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) redactSecretKeys(obj[i], replacement, prefix ? `${prefix}.${i}` : String(i));
		return;
	}
	const record = obj;
	for (const key of redactableKeys(record)) {
		const fullPath = prefix ? `${prefix}.${key}` : key;
		const value = record[key];
		if (SECRET_KEY.test(key) && value !== null && value !== void 0 && typeof value !== "boolean") setRedacted(record, key, resolveReplacement(replacement, value, {
			path: fullPath,
			key
		}), fullPath);
		else redactSecretKeys(value, replacement, fullPath);
	}
}
/**
* Resolve a `redact` option (boolean or object) into a concrete `RedactConfig`.
*
* - `true` → the default built-in patterns with smart masking, no custom paths
* - `{ ... }` → built-in maskers merged with user config (opt-out: `builtins: false`)
* - `false` / `undefined` → `undefined` (no redaction)
*
* The default built-ins are every pattern except `apiKeys`, `privateKey` and
* `urlPassword`, which run only when `builtins` lists them.
*/
function resolveRedactConfig(input) {
	if (input === void 0 || input === false) return void 0;
	if (input === true) return {
		_maskers: builtinMaskers(isDefaultBuiltin),
		_secretKeys: true
	};
	if (input.builtins === false) return {
		...input,
		_pathMatchers: compileRedactPathMatchers(input.paths)
	};
	const { builtins } = input;
	const maskers = Array.isArray(builtins) ? builtinMaskers((name) => builtins.includes(name)) : builtinMaskers(isDefaultBuiltin);
	return {
		...input,
		_maskers: maskers,
		_secretKeys: !Array.isArray(input.builtins) || input.builtins.includes("secrets"),
		_pathMatchers: compileRedactPathMatchers(input.paths)
	};
}
function isDefaultBuiltin(name) {
	return !OPT_IN_BUILTINS.has(name);
}
/** Fresh maskers for the selected built-ins, in {@link builtinPatterns} order. */
function builtinMaskers(include) {
	return Object.keys(builtinPatterns).filter(include).map((name) => [cloneRegex(builtinPatterns[name].pattern), builtinPatterns[name].mask]);
}
function cloneRegex(re) {
	return new RegExp(re.source, re.flags);
}
/** @internal Set on wide events after initLogger redaction so middleware skips a second pass. */
const globallyRedacted = Symbol.for("evlog.globallyRedacted");
/** @internal Mark a wide event as already redacted by {@link initLogger}. */
function markGloballyRedacted(event) {
	Object.defineProperty(event, globallyRedacted, {
		value: true,
		enumerable: false,
		configurable: true
	});
}
/**
* Clone before redaction. Wide events are JSON-shaped; fall back when
* `structuredClone` rejects non-cloneable values (functions, symbols, etc.).
*/
function cloneForRedaction(event) {
	try {
		return structuredClone(event);
	} catch {
		try {
			return JSON.parse(JSON.stringify(event));
		} catch {
			console.warn("[cloneForRedaction] Shallow clone used — nested objects may be mutated by redactPath, redactPatterns, and applyMaskersToTree");
			return { ...event };
		}
	}
}
/**
* Redact sensitive data from a wide event without mutating the input.
*
* Returns a deep clone with redaction applied. Strategies run in order:
* 0. **Transform**: user hook, sees raw values so it can derive replacements; the stages below still run after it.
* 1. **Path-based**: dot-notation paths with optional globs (`password`, `**.password`, `*_token`, `user.*`) — full value replacement.
*    The `secrets` built-in adds every key ending in `password`, `passwd`, `secret` or `token`.
* 2. **Masker-based**: built-in patterns with smart partial masking (e.g. `****1111`).
* 3. **Pattern-based**: custom RegExp patterns on string values replaced with `replacement`.
*
* @param event - The wide event object (not mutated).
* @param config - Redaction configuration.
* @returns A redacted deep clone of `event`.
*/
function redactEvent(event, config) {
	const clone = cloneForRedaction(event);
	const replacement = config.replacement ?? DEFAULT_REPLACEMENT;
	if (config.transform) try {
		config.transform(clone);
	} catch (err) {
		console.error("[evlog] redact transform failed:", err);
	}
	const pathMatchers = config._pathMatchers ?? compileRedactPathMatchers(config.paths);
	if (pathMatchers) redactPathsInTree(clone, pathMatchers, replacement);
	if (config._secretKeys) redactSecretKeys(clone, replacement);
	if (config._maskers?.length) applyMaskersToTree(clone, config._maskers);
	if (config.patterns?.length) redactPatterns(clone, config.patterns, replacement);
	return clone;
}
function redactPatterns(obj, patterns, replacement, prefix = "") {
	if (obj === null || obj === void 0) return;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			const key = String(i);
			const fullPath = prefix ? `${prefix}.${key}` : key;
			if (typeof obj[i] === "string") obj[i] = applyPatterns(obj[i], patterns, replacement, fullPath, key);
			else if (typeof obj[i] === "object") redactPatterns(obj[i], patterns, replacement, fullPath);
		}
		return;
	}
	if (typeof obj === "object") {
		const record = obj;
		for (const key of redactableKeys(record)) {
			const val = record[key];
			const fullPath = prefix ? `${prefix}.${key}` : key;
			if (typeof val === "string") setRedacted(record, key, applyPatterns(val, patterns, replacement, fullPath, key), fullPath);
			else if (typeof val === "object") redactPatterns(val, patterns, replacement, fullPath);
		}
	}
}
function applyPatterns(value, patterns, replacement, path, key) {
	let result = value;
	for (const pattern of patterns) {
		if (typeof replacement === "string") {
			result = result.replace(pattern, replacement);
			continue;
		}
		result = result.replace(pattern, (...args) => {
			const match = args[0];
			return resolveReplacement(replacement, match, {
				path,
				key,
				groups: captureGroups(args)
			});
		});
	}
	return result;
}
/**
* Extract the capture groups from a `String.prototype.replace` callback's args.
* Trailing args are `offset, string` — plus a named-groups object when the
* pattern declares any.
*/
function captureGroups(args) {
	const last = args.at(-1);
	const trailing = typeof last === "object" && last !== null ? 3 : 2;
	return args.slice(1, Math.max(1, args.length - trailing));
}
function applyMaskersToTree(obj, maskers) {
	if (obj === null || obj === void 0) return;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) if (typeof obj[i] === "string") obj[i] = applyMaskers(obj[i], maskers);
		else if (typeof obj[i] === "object") applyMaskersToTree(obj[i], maskers);
		return;
	}
	if (typeof obj === "object") {
		const record = obj;
		for (const key of redactableKeys(record)) {
			const val = record[key];
			if (typeof val === "string") setRedacted(record, key, applyMaskers(val, maskers), key);
			else if (typeof val === "object") applyMaskersToTree(val, maskers);
		}
	}
}
function applyMaskers(value, maskers) {
	let result = value;
	for (const [pattern, mask] of maskers) result = result.replace(pattern, mask);
	return result;
}
const { serializeError, serializeErrorsIn } = createErrorSerializer((stack) => isDev() ? compactStackForStorage(stack) : stack);
const nativeStdoutWrite = typeof process !== "undefined" && typeof process.stdout?.write === "function" ? process.stdout.write.bind(process.stdout) : void 0;
function writeOwnOutput(write) {
	const global = globalThis;
	global.__evlogOwnOutput = true;
	try {
		write();
	} finally {
		global.__evlogOwnOutput = false;
	}
}
function isPlainObject$1(val) {
	return val !== null && typeof val === "object" && !Array.isArray(val);
}
function isPlainRecord(val) {
	if (!isPlainObject$1(val)) return false;
	const proto = Object.getPrototypeOf(val);
	return proto === Object.prototype || proto === null;
}
/** Shown after post-emit warnings so users can fix fire-and-forget / ALS continuations. */
const POST_EMIT_FORK_HINT = "For intentional background work tied to this request, use log.fork('label', fn) when your integration supports it (see https://evlog.dev).";
function warnPostEmit(method, detail) {
	console.warn(`[evlog] ${method} called after the wide event was emitted — ${detail} This data will not appear in observability. ${POST_EMIT_FORK_HINT}`);
}
function setField(target, key, value) {
	if (key === "__proto__") Reflect.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true
	});
	else Reflect.set(target, key, value);
}
function writableChild(target, key) {
	const child = target[key];
	const copy = { ...child };
	const { toJSON } = child;
	if (typeof toJSON === "function" && !Object.hasOwn(copy, "toJSON")) Object.defineProperty(copy, "toJSON", {
		value: toJSON,
		enumerable: false,
		writable: true,
		configurable: true
	});
	setField(target, key, copy);
	return copy;
}
function mergeInto(target, source) {
	for (const key in source) {
		const sourceVal = source[key];
		if (sourceVal === void 0 || sourceVal === null) continue;
		const targetVal = key === "__proto__" && !Object.hasOwn(target, key) ? void 0 : target[key];
		if (sourceVal === targetVal) continue;
		if (isPlainRecord(sourceVal) && isPlainRecord(targetVal)) mergeInto(writableChild(target, key), sourceVal);
		else if (Array.isArray(targetVal) && Array.isArray(sourceVal)) setField(target, key, [...targetVal, ...sourceVal]);
		else setField(target, key, sourceVal);
	}
}
function mergeFields(target, fields) {
	mergeInto(target, serializeErrorsIn(fields));
}
const pendingDrainState = /* @__PURE__ */ new WeakMap();
function isAiOnlyFieldUpdate(data) {
	const keys = Object.keys(data);
	return keys.length === 1 && keys[0] === "ai";
}
/**
* Process-wide configuration, shared with every other copy of evlog the package
* manager may have installed (see `shared/globalRegistry.ts`). The reference is
* stable, so reads stay a plain property access on the hot path.
*/
const state = globalConfig;
/**
* Initialize the logger with configuration.
* Call this once at application startup.
*
* Every field is overwritten on each call, and the state is process-wide —
* shared with any duplicate install of the same major. Last call wins, so a
* second `initLogger()` without a `drain` clears the drain for every copy.
* Integrations that initialize implicitly must therefore check
* {@link isLoggerLocked} / {@link isLoggerInitialized} first, as `next/handler`
* and `eve` do.
*/
function initLogger(config = {}) {
	state.enabled = config.enabled ?? true;
	const detected = detectEnvironment();
	state.env = {
		service: config.env?.service ?? detected.service ?? "app",
		environment: config.env?.environment ?? detected.environment ?? "development",
		version: config.env?.version ?? detected.version,
		commitHash: config.env?.commitHash ?? detected.commitHash,
		region: config.env?.region ?? detected.region
	};
	state.pretty = config.pretty ?? isDev();
	state.prettyError = resolveDevTerminal(config).prettyError;
	state.sampling = config.sampling ?? {};
	state.stringify = config.stringify ?? true;
	state.drain = config.drain;
	state.redact = resolveRedactConfig(config.redact ?? !isDev());
	state.silent = config.silent ?? false;
	state.minLevel = config.minLevel ?? "debug";
	state.pluginRunner = config.plugins?.length ? createPluginRunner(config.plugins) : getEmptyPluginRunner();
	if (state.pluginRunner.plugins.length > 0) state.pluginRunner.runSetup({ env: { ...state.env } });
	const hasAnyDrain = !!state.drain || state.pluginRunner.hasDrain;
	if (state.silent && !hasAnyDrain && !config._suppressDrainWarning) console.warn("[evlog] silent mode is enabled but no drain is configured. Events will be built and sampled but not output anywhere. Set a drain via initLogger({ drain }) or a framework hook (evlog:drain).");
	state.initialized = true;
}
/**
* Determine if a log at the given level should be emitted based on sampling config.
* Error defaults to 100% unless explicitly configured otherwise.
* Trace defaults to 0% (opt-in via `sampling.rates.trace`).
* Fatal is force-kept regardless of the sampling configuration.
*/
function shouldSample(level) {
	if (level === "fatal") return true;
	const { rates } = state.sampling;
	if (!rates) return level !== "trace";
	const percentage = level === "error" && rates.error === void 0 ? 100 : level === "trace" && rates.trace === void 0 ? 0 : rates[level] ?? 100;
	if (percentage <= 0) return false;
	if (percentage >= 100) return true;
	return Math.random() * 100 < percentage;
}
/**
* Evaluate tail sampling conditions to determine if a log should be force-kept.
* Returns true if ANY condition matches (OR logic).
*/
function shouldKeep(ctx) {
	const { keep } = state.sampling;
	if (!keep?.length) return false;
	return keep.some((condition) => {
		if (condition.status !== void 0 && ctx.status !== void 0 && ctx.status >= condition.status) return true;
		if (condition.duration !== void 0 && ctx.duration !== void 0 && ctx.duration >= condition.duration) return true;
		if (condition.path && ctx.path && matchesPattern(ctx.path, condition.path)) return true;
		return false;
	});
}
/**
* Production without `initLogger()` still emits (the defaults are safe to run),
* but the events carry no redaction, the default service/environment and no
* drain. Warn once per process so the misconfiguration is visible instead of
* silent; `noopLogger` stays reserved for the explicit `enabled: false`.
*/
function warnOnceUninitializedProduction() {
	if (state.initialized || isDev() || state.warnedUninitialized) return;
	state.warnedUninitialized = true;
	console.warn("[evlog] running in production without initLogger(). Events are emitted with the default service and environment, without redaction, and no drain is configured so nothing reaches observability. Call initLogger({ drain }) once at startup, or wire a framework hook (evlog:drain).");
}
function emitWideEvent(level, event, options = {}) {
	const { deferDrain = false, ownsEvent = false, waitUntil } = options;
	if (!state.enabled) return null;
	warnOnceUninitializedProduction();
	if (!ownsEvent) {
		if (!isLevelEnabled(level, state.minLevel)) return null;
		if (!shouldSample(level)) return null;
	}
	let formatted;
	if (ownsEvent) {
		event.timestamp = isoNow();
		event.level = level;
		if (event.service === void 0) event.service = state.env.service;
		if (event.environment === void 0) event.environment = state.env.environment;
		if (state.env.version !== void 0 && event.version === void 0) event.version = state.env.version;
		if (state.env.commitHash !== void 0 && event.commitHash === void 0) event.commitHash = state.env.commitHash;
		if (state.env.region !== void 0 && event.region === void 0) event.region = state.env.region;
		formatted = event;
	} else formatted = {
		timestamp: isoNow(),
		level,
		...state.env,
		...event
	};
	finalizeAudit(formatted);
	if (state.redact) {
		formatted = redactEvent(formatted, state.redact);
		markGloballyRedacted(formatted);
	}
	if (!deferDrain) {
		outputWideEvent(formatted);
		publishWideEvent(formatted);
		const drainPromises = [];
		if (state.drain) drainPromises.push((async () => {
			try {
				await state.drain({ event: formatted });
			} catch (err) {
				console.error("[evlog] drain failed:", err);
			}
		})());
		if (state.pluginRunner.hasDrain) drainPromises.push(state.pluginRunner.runDrain({ event: formatted }));
		if (drainPromises.length > 0 && waitUntil) waitUntil(Promise.all(drainPromises));
	}
	return formatted;
}
/**
* Write an emitted wide event to the console, honoring `silent`, `pretty` and
* `stringify`. Runners call it once enrichers have run.
* @internal
*/
function outputWideEvent(event) {
	if (state.silent) return;
	if (state.pretty) prettyPrintWideEvent(event);
	else if (state.stringify) writeOwnOutput(() => console[getConsoleMethod(event.level)](JSON.stringify(event)));
	else writeOwnOutput(() => console[getConsoleMethod(event.level)](event));
}
function emitTaggedLog(level, tag, message) {
	if (!state.enabled) return;
	if (state.pretty && !state.silent) {
		if (!isLevelEnabled(level, state.minLevel)) return;
		if (!shouldSample(level)) return;
		if (isBrowser()) {
			const levelColor = getCssLevelColor(level);
			const timestamp = isoNow().slice(11, 23);
			console.log(`%c${timestamp}%c %c[${escapeFormatString(tag)}]%c ${escapeFormatString(message)}`, cssColors.dim, cssColors.reset, levelColor, cssColors.reset);
		} else {
			const color = getLevelColor(level);
			const timestamp = isoNow().slice(11, 23);
			writeOwnOutput(() => console.log(`${colors.dim}${timestamp}${colors.reset} ${color}[${escapeControlChars(tag)}]${colors.reset} ${escapeControlChars(message)}`));
		}
		return;
	}
	emitWideEvent(level, {
		tag,
		message
	});
}
function formatValue(value) {
	if (value === null || value === void 0) return String(value);
	if (Array.isArray(value)) return JSON.stringify(value);
	if (isPlainObject$1(value)) {
		const pairs = [];
		for (const [k, v] of Object.entries(value)) if (v !== void 0 && v !== null) {
			if (typeof v === "object") pairs.push(`${k}=${JSON.stringify(v)}`);
			else pairs.push(`${k}=${v}`);
		}
		return pairs.join(" ");
	}
	return String(value);
}
function formatCost(cost) {
	if (cost < .01) return `$${cost.toFixed(6)}`;
	if (cost < 1) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}
function asNumber(value) {
	return typeof value === "number" ? value : void 0;
}
function asStringArray(value) {
	if (!Array.isArray(value)) return void 0;
	return value.every((item) => typeof item === "string") ? value : void 0;
}
function isToolUsageEntry(value) {
	return isPlainObject$1(value) && typeof value.name === "string" && typeof value.durationMs === "number" && typeof value.success === "boolean";
}
function asToolUsageArray(value) {
	if (!Array.isArray(value)) return void 0;
	return value.every(isToolUsageEntry) ? value : void 0;
}
function serializeToolInput(input) {
	if (typeof input === "string") return input;
	const seen = /* @__PURE__ */ new WeakSet();
	try {
		return JSON.stringify(input, (_key, value) => {
			if (typeof value === "bigint") return value.toString();
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		}) ?? "";
	} catch {
		return "[unserializable tool input]";
	}
}
function isToolCallEntry(value) {
	return isPlainObject$1(value) && typeof value.name === "string" && "input" in value;
}
function asToolCallArray(value) {
	if (!Array.isArray(value)) return void 0;
	return value.every(isToolCallEntry) ? value : void 0;
}
const CAPTURED_LINE_MAX_LENGTH = 160;
const CAPTURED_MAX_LINES = 8;
function asCapturedLines(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const lines = value.split("\n").map((line) => {
		return line.length > CAPTURED_LINE_MAX_LENGTH ? `${line.slice(0, CAPTURED_LINE_MAX_LENGTH)}…` : line;
	});
	if (lines.length > CAPTURED_MAX_LINES) {
		lines.length = CAPTURED_MAX_LINES;
		lines.push(`+${value.split("\n").length - CAPTURED_MAX_LINES} more lines (full text in the event)`);
	}
	return lines;
}
function buildAIEntries(ai) {
	const entries = [];
	const headerParts = [];
	if (ai.model) {
		let m = String(ai.model);
		if (ai.provider) m += ` (${ai.provider})`;
		headerParts.push(m);
	}
	if (ai.calls) {
		const calls = asNumber(ai.calls);
		if (calls !== void 0) headerParts.push(`${calls} call${calls > 1 ? "s" : ""}`);
	}
	const steps = asNumber(ai.steps);
	if (steps !== void 0 && steps > 1) headerParts.push(`${steps} steps`);
	entries.push({
		key: "ai",
		value: headerParts.join(" · ")
	});
	const inputTokens = asNumber(ai.inputTokens);
	const outputTokens = asNumber(ai.outputTokens);
	const totalTokens = asNumber(ai.totalTokens);
	if (inputTokens !== void 0 && outputTokens !== void 0) {
		let tokLine = `${inputTokens} in → ${outputTokens} out`;
		if (totalTokens) tokLine += ` (${totalTokens} total)`;
		const extras = [];
		if (ai.cacheReadTokens) extras.push(`${ai.cacheReadTokens} cache read`);
		if (ai.cacheWriteTokens) extras.push(`${ai.cacheWriteTokens} cache write`);
		if (ai.reasoningTokens) extras.push(`${ai.reasoningTokens} reasoning`);
		if (extras.length) tokLine += ` · ${extras.join(" · ")}`;
		entries.push({
			key: "ai.tokens",
			value: tokLine
		});
	}
	const msFirst = asNumber(ai.msToFirstChunk);
	const msFinish = asNumber(ai.msToFinish);
	const tps = asNumber(ai.tokensPerSecond);
	if (msFirst !== void 0 || msFinish !== void 0) {
		const parts = [];
		if (msFirst !== void 0) parts.push(`${formatDuration(msFirst)} to first chunk`);
		if (msFinish !== void 0) parts.push(`${formatDuration(msFinish)} total`);
		let streamLine = parts.join(" → ");
		if (tps) streamLine += ` · ${tps} tok/s`;
		entries.push({
			key: "ai.streaming",
			value: streamLine
		});
	}
	const estimatedCost = asNumber(ai.estimatedCost);
	if (estimatedCost !== void 0) entries.push({
		key: "ai.cost",
		value: formatCost(estimatedCost)
	});
	const totalDurationMs = asNumber(ai.totalDurationMs);
	if (totalDurationMs !== void 0) entries.push({
		key: "ai.totalDuration",
		value: formatDuration(totalDurationMs)
	});
	const toolCalls = Array.isArray(ai.toolCalls) ? ai.toolCalls : void 0;
	const tools = asToolUsageArray(ai.tools);
	const toolCallEntries = toolCalls ? asToolCallArray(toolCalls) : void 0;
	const hasInputs = toolCallEntries !== void 0 && toolCallEntries.length > 0;
	if (tools?.length) {
		const children = tools.map((t, idx) => {
			const mark = t.success ? "✓" : "✗";
			let line = `${t.name} ${formatDuration(t.durationMs)} ${mark}`;
			if (t.error) line += ` ${t.error}`;
			if (hasInputs && toolCallEntries && idx < toolCallEntries.length) {
				const tc = toolCallEntries[idx];
				const inputStr = serializeToolInput(tc.input);
				const truncated = inputStr.length > 100 ? `${inputStr.slice(0, 100)}…` : inputStr;
				line += ` ${truncated}`;
			}
			return line;
		});
		entries.push({
			key: "ai.tools",
			value: "",
			children
		});
	} else if (toolCalls?.length) {
		if (toolCallEntries?.length) {
			const children = toolCallEntries.map((tc) => {
				const inputStr = serializeToolInput(tc.input);
				const truncated = inputStr.length > 100 ? `${inputStr.slice(0, 100)}…` : inputStr;
				return `${tc.name}(${truncated})`;
			});
			entries.push({
				key: "ai.tools",
				value: "",
				children
			});
		} else {
			const names = asStringArray(toolCalls);
			if (names?.length) entries.push({
				key: "ai.tools",
				value: names.join(", ")
			});
		}
	}
	const stepsUsage = Array.isArray(ai.stepsUsage) ? ai.stepsUsage.filter(isPlainObject$1) : void 0;
	if (stepsUsage?.length) {
		const firstModel = stepsUsage[0]?.model;
		const allSameModel = firstModel !== void 0 && stepsUsage.every((s) => s.model === firstModel);
		const children = stepsUsage.map((s) => {
			let line = `${allSameModel ? "" : `${String(s.model)} `}${s.inputTokens} in → ${s.outputTokens} out`;
			const stepTools = asStringArray(s.toolCalls);
			if (stepTools?.length) line += ` [${stepTools.join(", ")}]`;
			return line;
		});
		entries.push({
			key: "ai.steps",
			value: "",
			children
		});
	} else if (steps !== void 0 && steps > 1) entries.push({
		key: "ai.steps",
		value: String(steps)
	});
	const promptLines = asCapturedLines(ai.prompt);
	if (promptLines) entries.push({
		key: "ai.prompt",
		value: "",
		children: promptLines
	});
	const outputLines = asCapturedLines(ai.output);
	if (outputLines) entries.push({
		key: "ai.output",
		value: "",
		children: outputLines
	});
	const embedding = isPlainObject$1(ai.embedding) ? ai.embedding : void 0;
	if (embedding) {
		const parts = [];
		if (embedding.model) parts.push(String(embedding.model));
		parts.push(`${embedding.tokens} tokens`);
		if (embedding.dimensions) parts.push(`${embedding.dimensions}d`);
		if (embedding.count) parts.push(`${embedding.count} items`);
		entries.push({
			key: "ai.embedding",
			value: parts.join(" · ")
		});
	}
	if (ai.finishReason) entries.push({
		key: "ai.finishReason",
		value: String(ai.finishReason)
	});
	if (ai.error) entries.push({
		key: "ai.error",
		value: String(ai.error)
	});
	if (ai.responseId) entries.push({
		key: "ai.responseId",
		value: String(ai.responseId)
	});
	return entries;
}
/** Field and AI entries hold no colour codes of their own, so every string in them is escaped. */
function escapeTreeEntry(entry) {
	return {
		key: escapeControlChars(entry.key),
		value: escapeControlChars(entry.value),
		children: entry.children?.map(escapeControlChars)
	};
}
function flushPrettyLines(lines) {
	if (lines.length === 0) return;
	if (nativeStdoutWrite && !isBrowser() && process.env.VITEST !== "true") {
		writeOwnOutput(() => nativeStdoutWrite(`${lines.join("\n")}\n`));
		return;
	}
	writeOwnOutput(() => console.log(lines.join("\n")));
}
function prettyPrintWideEvent(event) {
	const { timestamp, level, service, environment, version, ...rest } = event;
	const ts = typeof timestamp === "string" ? timestamp.slice(11, 23) : "";
	const levelLabel = typeof level === "string" ? level : "info";
	const browser = isBrowser();
	const lines = [];
	const writeLine = (...args) => {
		if (browser) {
			console.log(...args);
			return;
		}
		const [line] = args;
		if (typeof line === "string") lines.push(line);
	};
	const parts = [];
	const styles = [];
	if (browser) {
		const lc = getCssLevelColor(levelLabel);
		parts.push(`%c${ts}%c %c${levelLabel.toUpperCase()}%c %c[${escapeFormatString(String(service))}]%c`);
		styles.push(cssColors.dim, cssColors.reset, lc, cssColors.reset, cssColors.cyan, cssColors.reset);
	} else {
		const lc = getLevelColor(levelLabel);
		parts.push(`${colors.dim}${ts}${colors.reset} ${lc}${levelLabel.toUpperCase()}${colors.reset} ${colors.cyan}[${escapeControlChars(String(service))}]${colors.reset}`);
	}
	if (rest.method && rest.path) {
		parts.push(browser ? ` ${escapeFormatString(String(rest.method))} ${escapeFormatString(String(rest.path))}` : ` ${escapeControlChars(String(rest.method))} ${escapeControlChars(String(rest.path))}`);
		delete rest.method;
		delete rest.path;
	}
	if (rest.status) {
		const statusCode = asNumber(rest.status) ?? Number(rest.status);
		const sc = browser ? statusCode >= 400 ? cssColors.red : cssColors.green : statusCode >= 400 ? colors.red : colors.green;
		if (browser) {
			parts.push(` %c${rest.status}%c`);
			styles.push(sc, cssColors.reset);
		} else parts.push(` ${sc}${escapeControlChars(String(rest.status))}${colors.reset}`);
		delete rest.status;
	}
	if (rest.duration) {
		if (browser) {
			parts.push(` %c${escapeFormatString(`in ${rest.duration}`)}%c`);
			styles.push(cssColors.dim, cssColors.reset);
		} else parts.push(` ${colors.dim}in ${escapeControlChars(String(rest.duration))}${colors.reset}`);
		delete rest.duration;
	}
	delete rest.durationMs;
	writeLine(parts.join(""), ...styles);
	const aiData = isPlainObject$1(rest.ai) ? rest.ai : void 0;
	if (aiData) delete rest.ai;
	const errorData = rest.error;
	if (errorData !== void 0) delete rest.error;
	const restEntries = Object.entries(rest).filter(([_, v]) => v !== void 0);
	const aiEntries = aiData ? buildAIEntries(aiData) : [];
	const errorEntries = errorData !== void 0 ? buildErrorEntries(errorData, state.prettyError) : [];
	const fieldEntries = [...restEntries.map(([key, value]) => ({
		key,
		value: formatValue(value)
	})), ...aiEntries];
	const contextEntries = browser ? fieldEntries : fieldEntries.map(escapeTreeEntry);
	const allEntries = errorEntries.length > 0 ? [...errorEntries, ...contextEntries] : contextEntries;
	for (let i = 0; i < allEntries.length; i++) {
		const entry = allEntries[i];
		if (!entry) continue;
		const { children } = entry;
		const hasChildren = children !== void 0 && children.length > 0;
		const prefix = i === allEntries.length - 1 && !hasChildren ? "└─" : "├─";
		if (browser) {
			const val = entry.value ? ` ${escapeFormatString(entry.value)}` : "";
			writeLine(`  %c${prefix}%c %c${escapeFormatString(entry.key)}:%c${val}`, cssColors.dim, cssColors.reset, cssColors.cyan, cssColors.reset);
		} else {
			const val = entry.value ? ` ${entry.value}` : "";
			writeLine(`  ${colors.dim}${prefix}${colors.reset} ${colors.cyan}${entry.key}:${colors.reset}${val}`);
		}
		if (hasChildren && children) {
			const connector = i === allEntries.length - 1 ? " " : "│";
			for (let j = 0; j < children.length; j++) {
				const child = children[j];
				if (child === void 0) continue;
				if (child === "__EVLOG_TREE_SPACER__") {
					writeLine(`  ${colors.dim}${connector}${colors.reset}`);
					continue;
				}
				const childPrefix = j === children.length - 1 ? "└─" : "├─";
				if (child === "") {
					writeLine("");
					continue;
				}
				if (browser) writeLine(`  %c${connector}  ${childPrefix}%c ${escapeFormatString(child)}`, cssColors.dim, cssColors.reset);
				else if (child.startsWith(" ") || child.startsWith("\x1B")) writeLine(`  ${colors.dim}${connector}${colors.reset}${child}`);
				else writeLine(`  ${colors.dim}${connector}  ${childPrefix}${colors.reset} ${child}`);
			}
		}
	}
	if (!browser && lines.length > 0) flushPrettyLines(lines);
}
function createLogMethod(level) {
	return function logMethod(tagOrEvent, message, ...args) {
		if (typeof tagOrEvent === "string") {
			if (message === void 0) emitTaggedLog(level, "log", formatMessage(tagOrEvent, args));
			else if (hasMessageSpecifiers(tagOrEvent)) emitTaggedLog(level, "log", formatMessage(tagOrEvent, [message, ...args]));
			else emitTaggedLog(level, tagOrEvent, formatMessage(message, args));
		} else if (tagOrEvent instanceof Error) emitWideEvent(level, { error: serializeError(tagOrEvent) });
		else if (typeof tagOrEvent === "object") emitWideEvent(level, serializeErrorsIn(tagOrEvent));
		else emitTaggedLog(level, "log", String(tagOrEvent));
	};
}
/**
* Simple logging API - as easy as console.log
*
* @example
* ```ts
* log.info('auth', 'User logged in')
* log.error({ action: 'payment', error: 'failed' })
* ```
*/
const _log = {
	info: createLogMethod("info"),
	error: createLogMethod("error"),
	warn: createLogMethod("warn"),
	debug: createLogMethod("debug"),
	fatal: createLogMethod("fatal"),
	trace: createLogMethod("trace")
};
/** @internal Accepts every call and emits nothing; reused wherever logging must not fail the caller. */
const noopLogger = {
	set() {},
	setLevel() {},
	error() {},
	fatal() {},
	info() {},
	warn() {},
	debug() {},
	trace() {},
	emit() {
		return null;
	},
	getContext() {
		return {};
	},
	audit: Object.assign(() => {}, { deny: () => {} })
};
/**
* Create a scoped logger for building wide events.
* Use this for any context: workflows, jobs, scripts, queues, etc.
*
* After `emit()` (including when sampling returns `null`), the logger is sealed and
* further mutations log `[evlog]` warnings. Standalone loggers do not have `fork`;
* that method is only attached by supported framework integrations.
*
* @example
* ```ts
* const log = createLogger({ jobId: job.id, queue: 'emails' })
* log.set({ batch: { size: 50, processed: 12 } })
* log.emit()
* ```
*/
function createLogger(initialContext = {}, internalOptions) {
	if (!state.enabled) return noopLogger;
	const deferDrain = internalOptions?._deferDrain ?? false;
	const waitUntil = internalOptions?.waitUntil;
	const startTime = Date.now();
	const context = { ...serializeErrorsIn(initialContext) };
	let hasError = false;
	let hasFatal = false;
	let hasWarn = false;
	let manualLevel;
	let emitted = false;
	let pendingWideEvent = null;
	function addLog(level, message) {
		if (!Array.isArray(context.requestLogs)) context.requestLogs = [];
		context.requestLogs.push({
			level,
			message,
			timestamp: isoNow()
		});
	}
	const auditMethod = function audit(input) {
		if (emitted) {
			warnPostEmit("log.audit()", `Audit dropped: action=${input.action}.`);
			return;
		}
		const fields = buildAuditFields(input);
		if (!isPlainRecord(context.audit)) context.audit = fields;
		else mergeInto(writableChild(context, "audit"), fields);
		context._auditForceKeep = true;
	};
	auditMethod.deny = function deny(reason, input) {
		auditMethod({
			...input,
			outcome: "denied",
			reason
		});
	};
	return {
		audit: auditMethod,
		set(data) {
			if (emitted) {
				const record = data;
				const pendingState = pendingWideEvent ? pendingDrainState.get(pendingWideEvent) : void 0;
				if (pendingWideEvent && pendingState && !pendingState.drainStarted && isAiOnlyFieldUpdate(record)) {
					mergeInto(pendingWideEvent, record);
					return;
				}
				const keys = Object.keys(record);
				warnPostEmit("log.set()", `Keys dropped: ${keys.length ? keys.join(", ") : "(empty)"}.`);
				return;
			}
			mergeFields(context, data);
		},
		setLevel(level) {
			if (emitted) {
				warnPostEmit("log.setLevel()", `Level dropped: ${level}.`);
				return;
			}
			manualLevel = level;
		},
		error(error, errorContext) {
			if (emitted) {
				warnPostEmit("log.error()", `Keys dropped: ${(errorContext ? [...Object.keys(errorContext), "error"] : ["error"]).join(", ")}.`);
				return;
			}
			hasError = true;
			const err = typeof error === "string" ? new Error(error) : error;
			if (errorContext) mergeFields(context, errorContext);
			const errorObj = serializeError(err);
			if (isPlainRecord(context.error)) mergeInto(writableChild(context, "error"), errorObj);
			else context.error = errorObj;
		},
		fatal(message, fatalContext) {
			if (emitted) {
				warnPostEmit("log.fatal()", `Keys dropped: ${(fatalContext ? ["message", ...Object.keys(fatalContext).filter((k) => k !== "requestLogs")] : ["message"]).join(", ")}.`);
				return;
			}
			hasFatal = true;
			addLog("fatal", message);
			if (fatalContext) {
				const { requestLogs: _, ...rest } = fatalContext;
				mergeFields(context, rest);
			}
		},
		info(message, infoContext) {
			if (emitted) {
				warnPostEmit("log.info()", `Keys dropped: ${(infoContext ? ["message", ...Object.keys(infoContext).filter((k) => k !== "requestLogs")] : ["message"]).join(", ")}.`);
				return;
			}
			addLog("info", message);
			if (infoContext) {
				const { requestLogs: _, ...rest } = infoContext;
				mergeFields(context, rest);
			}
		},
		warn(message, warnContext) {
			if (emitted) {
				warnPostEmit("log.warn()", `Keys dropped: ${(warnContext ? ["message", ...Object.keys(warnContext).filter((k) => k !== "requestLogs")] : ["message"]).join(", ")}.`);
				return;
			}
			hasWarn = true;
			addLog("warn", message);
			if (warnContext) {
				const { requestLogs: _, ...rest } = warnContext;
				mergeFields(context, rest);
			}
		},
		debug(message, debugContext) {
			if (emitted) {
				warnPostEmit("log.debug()", `Keys dropped: ${(debugContext ? ["message", ...Object.keys(debugContext).filter((k) => k !== "requestLogs")] : ["message"]).join(", ")}.`);
				return;
			}
			addLog("debug", message);
			if (debugContext) {
				const { requestLogs: _, ...rest } = debugContext;
				mergeFields(context, rest);
			}
		},
		trace(message, traceContext) {
			if (emitted) {
				warnPostEmit("log.trace()", `Keys dropped: ${(traceContext ? ["message", ...Object.keys(traceContext).filter((k) => k !== "requestLogs")] : ["message"]).join(", ")}.`);
				return;
			}
			addLog("trace", message);
			if (traceContext) {
				const { requestLogs: _, ...rest } = traceContext;
				mergeFields(context, rest);
			}
		},
		emit(overrides) {
			if (emitted) {
				warnPostEmit("log.emit()", "Ignoring duplicate emit.");
				return null;
			}
			const durationMs = overrides?._durationMs ?? elapsedMs(startTime);
			const level = manualLevel ?? (hasFatal ? "fatal" : hasError ? "error" : hasWarn ? "warn" : "info");
			let forceKeep = false;
			const auditForceKeep = consumeAuditForceKeep(context);
			if (overrides?._forceKeep) forceKeep = true;
			else if (auditForceKeep) forceKeep = true;
			else if (state.sampling.keep?.length) forceKeep = shouldKeep({
				status: overrides?.status ?? context.status,
				duration: durationMs,
				path: context.path,
				method: context.method,
				context
			});
			if (!forceKeep && !shouldSample(level)) {
				emitted = true;
				pendingWideEvent = null;
				return null;
			}
			if (overrides) {
				const obj = serializeErrorsIn(overrides);
				for (const key in obj) if (key !== "_forceKeep" && key !== "_durationMs") context[key] = obj[key];
			}
			context.durationMs = durationMs;
			context.duration = formatDuration(durationMs);
			const wide = emitWideEvent(level, context, {
				deferDrain,
				ownsEvent: true,
				waitUntil
			});
			emitted = true;
			pendingWideEvent = wide;
			if (wide) pendingDrainState.set(wide, { drainStarted: !deferDrain });
			return wide;
		},
		getContext() {
			return { ...context };
		}
	};
}
/**
* Create a request-scoped logger for building wide events.
* Convenience wrapper around `createLogger` that pre-populates HTTP request fields.
*
* @example
* ```ts
* const log = createRequestLogger({ method: 'POST', path: '/checkout' })
* log.set({ user: { id: '123' } })
* log.set({ cart: { items: 3 } })
* log.emit()
* ```
*
* @example Cloudflare Workers — pass `waitUntil` so `initLogger({ drain })` completes after the response:
* ```ts
* export default {
*   async fetch(request, env, ctx) {
*     const log = createRequestLogger({
*       method: request.method,
*       path: new URL(request.url).pathname,
*       waitUntil: ctx.waitUntil.bind(ctx),
*     })
*     log.emit()
*     return new Response('ok')
*   },
* }
* ```
*/
function createRequestLogger(options = {}, internalOptions) {
	const { method, path, requestId, waitUntil: optionsWaitUntil } = options;
	const initial = {};
	if (method !== void 0) initial.method = method;
	if (path !== void 0) initial.path = path;
	if (requestId !== void 0) initial.requestId = requestId;
	return createLogger(initial, {
		...internalOptions,
		waitUntil: internalOptions?.waitUntil ?? optionsWaitUntil
	});
}
if (typeof __EVLOG_CONFIG__ !== "undefined") initLogger(__EVLOG_CONFIG__);
/**
* @internal Stable JSON stringification with deterministic key order.
* Used by `idempotencyKey` and `hash-chain` so the same logical event always
* produces the same digest, regardless of how object keys were added.
*/
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (Object.prototype.toString.call(value) !== "[object Object]") return false;
	return Object.getPrototypeOf(value) === Object.prototype || value.constructor === Object;
}
function stableStringify(value, ancestors = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (ancestors.has(value)) return "\"[Circular]\"";
	if (!Array.isArray(value) && !isPlainObject(value)) return JSON.stringify(value);
	ancestors.add(value);
	const out = Array.isArray(value) ? `[${value.map((v) => stableStringify(v, ancestors)).join(",")}]` : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], ancestors)}`).join(",")}}`;
	ancestors.delete(value);
	return out;
}
/**
* @internal Sync, isomorphic 32-bit FNV-1a. Used to derive the idempotency
* key without pulling `node:crypto` into the static import graph (which would
* break browser / Cloudflare Workers bundles that import `evlog` for types
* or shared utilities). Idempotency keys are dedup tokens, not security
* primitives — collision resistance at 128 bits is more than sufficient.
*/
function fnv1a32(input, seed) {
	let h = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i) & 255;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h >>> 0;
}
/**
* @internal Compute the deterministic idempotency key for an audit event.
* Includes `action`, `actor.{type,id}`, `target.{type,id}`, `outcome`, and
* `timestamp` rounded to the second so retries within the same second collapse.
*
* Uses four interleaved FNV-1a 32-bit hashes (128-bit output, 32 hex chars)
* so the implementation stays sync and isomorphic across Node, browsers,
* Bun, Deno, and Cloudflare Workers.
*/
function computeIdempotencyKey(audit, timestamp) {
	const seconds = timestamp.slice(0, 19);
	const payload = stableStringify({
		action: audit.action,
		actor: {
			type: audit.actor.type,
			id: audit.actor.id
		},
		target: audit.target ? {
			type: audit.target.type,
			id: audit.target.id
		} : void 0,
		outcome: audit.outcome,
		timestamp: seconds
	});
	const a = fnv1a32(payload, 2166136261).toString(16).padStart(8, "0");
	const b = fnv1a32(payload, 3735928559).toString(16).padStart(8, "0");
	const c = fnv1a32(payload, 528734635).toString(16).padStart(8, "0");
	const d = fnv1a32(payload, 1541459225).toString(16).padStart(8, "0");
	return a + b + c + d;
}
/**
* Build a normalised {@link AuditFields} from caller input. Defaults:
* - `outcome` → `'success'`
* - `version` → {@link AUDIT_SCHEMA_VERSION}
*
* `idempotencyKey` is filled at emit time with the event timestamp so retries
* stay deterministic.
*/
function buildAuditFields(input) {
	return {
		action: input.action,
		actor: input.actor,
		target: input.target,
		outcome: input.outcome ?? "success",
		reason: input.reason,
		changes: input.changes,
		causationId: input.causationId,
		correlationId: input.correlationId,
		version: input.version ?? 1
	};
}
/**
* @internal Test-collector hook installed by {@link mockAudit}. When set, every
* audit event flowing through `log.audit()` / `audit()` is also pushed to it.
*/
let _testCollector = null;
/** @internal Emit-time decoration: assign timestamp-based idempotency key. */
function decorateAudit(audit, timestamp) {
	if (audit.idempotencyKey) return audit;
	return {
		...audit,
		idempotencyKey: computeIdempotencyKey(audit, timestamp)
	};
}
/**
* @internal Hook used by `RequestLogger.emit()` to detect audit-driven
* force-keep flags on the accumulated context. Returns whether the event was
* marked by `log.audit()` and clears the flag.
*/
function consumeAuditForceKeep(context) {
	if (context._auditForceKeep) {
		delete context._auditForceKeep;
		return true;
	}
	if (context.audit) return true;
	return false;
}
/** @internal True when `audit` has the minimum fields required before emit decoration. */
function isCompleteAuditFields(a) {
	if (!a || typeof a !== "object") return false;
	const audit = a;
	return typeof audit.action === "string" && typeof audit.actor?.type === "string" && typeof audit.actor?.id === "string";
}
/**
* @internal Decorate the audit field on an event right before drain — fills
* in the deterministic idempotency key. Called by the logger pipeline so
* it works for both `log.audit()` and direct `log.set({ audit })` paths.
* Skips partial/legacy shapes that omit required actor fields.
*/
function finalizeAudit(event) {
	const a = event.audit;
	if (!isCompleteAuditFields(a)) return;
	const decorated = decorateAudit(a, String(event.timestamp));
	event.audit = decorated;
	_testCollector?.(decorated, event);
}

// src/github.ts
/**
* The open pull requests, with what the bot reads of each. Approvals GitHub dismissed on a later
* push come from the timeline, since the review itself then only says DISMISSED.
*/
const PULLS_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $endCursor) {
      nodes {
        number title url headRefName headRefOid baseRefName mergeStateStatus isCrossRepository
        labels(first: 50) { nodes { name } }
        reviews(states: APPROVED, last: 100) { nodes { author { login } commit { oid } } }
        timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], last: 100) {
          nodes { ... on ReviewDismissedEvent { previousReviewState review { author { login } commit { oid } } } }
        }
        commits(last: 100) { nodes { commit { oid statusCheckRollup { state } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const PULLS_JQ = `.data.repository.pullRequests.nodes[] | {
  number, title, url, headRefName, headRefOid, baseRefName, mergeStateStatus, isCrossRepository,
  labels: [.labels.nodes[].name],
  approvals: ([.reviews.nodes[] | select(.commit != null) | {login: (.author.login // ""), oid: .commit.oid}]
    + [.timelineItems.nodes[] | select(.previousReviewState == "APPROVED" and .review.commit != null)
       | {login: (.review.author.login // ""), oid: .review.commit.oid}]),
  commits: [.commits.nodes[].commit.oid],
  ci: (.commits.nodes[-1].commit.statusCheckRollup.state // null)
}`;
var GitHubError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
/** GitHub through the gh CLI, which every GitHub-hosted runner has. */
var GitHub = class {
	repo;
	#token;
	constructor(repo, token) {
		this.repo = repo;
		this.#token = token;
	}
	gh(args, input) {
		const result = spawnSync("gh", args, {
			input,
			encoding: "utf8",
			maxBuffer: 1 << 30,
			env: {
				...process.env,
				GH_TOKEN: this.#token,
				GH_PROMPT_DISABLED: "1"
			}
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const status = /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1];
			throw new GitHubError(`gh ${args.slice(0, 3).join(" ")}: ${result.stderr.trim()}`, status ? Number(status) : void 0);
		}
		return result.stdout;
	}
	/** Each line of output as JSON. */
	jsonLines(out) {
		return out.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
	}
	/** A REST call against this repository: `path` is relative to `repos/<owner>/<name>/`. */
	api(method, path, body) {
		const args = [
			"api",
			"--method",
			method,
			`repos/${this.repo}/${path}`
		];
		if (body !== void 0) args.push("--input", "-");
		const out = this.gh(args, body === void 0 ? void 0 : JSON.stringify(body));
		return out.trim() === "" ? void 0 : JSON.parse(out);
	}
	/** Every page of a REST list. */
	list(path) {
		return this.jsonLines(this.gh([
			"api",
			"--paginate",
			"--jq",
			".[]",
			`repos/${this.repo}/${path}`
		]));
	}
	pulls() {
		const [owner = "", name = ""] = this.repo.split("/");
		const args = [
			"api",
			"graphql",
			"--paginate",
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`
		];
		return this.jsonLines(this.gh([
			...args,
			"-f",
			`query=${PULLS_QUERY}`,
			"--jq",
			PULLS_JQ
		]));
	}
	defaultBranch() {
		return this.gh([
			"repo",
			"view",
			this.repo,
			"--json",
			"defaultBranchRef",
			"--jq",
			".defaultBranchRef.name"
		]).trim();
	}
};

// src/config.ts
/** The cause given to a conflicting file no rule names. */
const UNNAMED_CAUSE = "code or prose";
function fail(message) {
	throw new Error(`remain config: ${message}`);
}
function isStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function parseRule(value, index) {
	if (typeof value !== "object" || value === null) fail(`rules[${index}] isn't an object`);
	const { cause, paths, union, regen, ...rest } = value;
	const unknownKeys = Object.keys(rest);
	if (unknownKeys.length > 0) fail(`rules[${index}] has unknown keys: ${unknownKeys.join(", ")}`);
	if (typeof cause !== "string" || cause === "") fail(`rules[${index}].cause must be a non-empty string`);
	if (!isStringArray(paths) || paths.length === 0) fail(`rules[${index}].paths must be a non-empty list of globs`);
	if (union !== void 0 && typeof union !== "boolean") fail(`rules[${index}].union must be true or false`);
	if (regen !== void 0 && (typeof regen !== "string" || regen === "")) fail(`rules[${index}].regen must be a command`);
	if (union && regen !== void 0) fail(`rules[${index}] can't both union and regen`);
	const rule = {
		cause,
		paths
	};
	if (union) rule.union = true;
	if (regen !== void 0) rule.regen = regen;
	return rule;
}
function parseConfig(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		fail(`not JSON: ${error.message}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("must be an object");
	const { rules = [], approvers = [], since = "30 days ago", label = "needs-owner", ...rest } = value;
	const unknownKeys = Object.keys(rest).filter((key) => key !== "$schema");
	if (unknownKeys.length > 0) fail(`unknown keys: ${unknownKeys.join(", ")}`);
	if (!Array.isArray(rules)) fail("rules must be a list");
	if (!isStringArray(approvers)) fail("approvers must be a list of logins");
	if (typeof since !== "string" || since === "") fail("since must be a date git understands");
	if (typeof label !== "string" || label === "") fail("label must be a non-empty string");
	return {
		rules: rules.map(parseRule),
		approvers,
		since,
		label
	};
}
function matches(rule, path) {
	return rule.paths.some((glob) => posix.matchesGlob(path, glob));
}
/** The first rule that names `path`. */
function ruleFor(config, path) {
	return config.rules.find((rule) => matches(rule, path));
}
/**
* .gitattributes lines that turn on git's union merge for every `union` rule's globs. They go after
* the default branch's own lines, so they win over any earlier line for the same files. Each is
* anchored with a leading `/`, since git matches a pattern without a slash at any depth and the
* config's globs match from the root.
*/
function unionAttributes(config) {
	return config.rules.filter((rule) => rule.union).flatMap((rule) => rule.paths.map((glob) => `/${glob} merge=union\n`)).join("");
}

// src/classify.ts
/**
* Sorts a merge's conflicts by what resolves them. `plain` is what conflicts with no attributes and
* no rerere (what GitHub sees), `remaining` what still conflicts after git's merge with the union
* attributes and rerere, and `rerere` what rerere resolved. A file the config doesn't name is never
* resolved: it goes to its owner.
*/
function classify(config, plain, remaining, rerere) {
	const left = new Set(remaining);
	const replayed = new Set(rerere);
	const regen = /* @__PURE__ */ new Map();
	const owner = /* @__PURE__ */ new Map();
	for (const path of [...remaining].toSorted()) {
		const rule = ruleFor(config, path);
		if (rule?.regen) {
			regen.set(rule, [...regen.get(rule) ?? [], path]);
			continue;
		}
		const cause = rule?.cause ?? "code or prose";
		owner.set(cause, [...owner.get(cause) ?? [], path]);
	}
	return {
		union: plain.filter((path) => !left.has(path) && !replayed.has(path)).toSorted(),
		rerere: plain.filter((path) => !left.has(path) && replayed.has(path)).toSorted(),
		regen: [...regen].map(([rule, paths]) => ({
			rule,
			paths
		})),
		owner: [...owner].map(([cause, paths]) => ({
			cause,
			paths
		})).toSorted((a, b) => Number(a.cause === "code or prose") - Number(b.cause === "code or prose") || a.cause.localeCompare(b.cause))
	};
}
function isMechanical(classification) {
	return classification.owner.length === 0;
}
/** The paths rerere says it resolved, from `git merge`'s output. */
function rerereResolved(output) {
	return [...output.matchAll(/^(?:Staged|Resolved) '(.+)' using previous resolution\.$/gm)].map((match) => match[1] ?? "");
}

// src/git.ts
/** The empty tree's hash. As attr.tree it makes git read no .gitattributes at all. */
const EMPTY_TREE = "4b825dc642cb6eb9a060af63bece73b5b6c2b4b9";
function run$1(command, args, cwd, options) {
	const result = spawnSync(command, args, {
		cwd,
		input: options.input,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 1 << 30
	});
	if (result.error) throw result.error;
	const code = result.status ?? 1;
	const ok = options.ok ?? [0];
	if (ok !== "any" && !ok.includes(code)) throw new Error(`${command} ${args.join(" ")} exited ${code}: ${result.stderr.trim()}`);
	return {
		code,
		stdout: result.stdout,
		stderr: result.stderr
	};
}
/**
* Runs git with hooks off: nothing a pull request's branch holds (or a runner's git config) gets
* to run code while the bot merges.
*/
function git(cwd, args, options = {}) {
	return run$1("git", [
		"-c",
		"core.hooksPath=/dev/null",
		...args
	], cwd, options);
}
/** git's stdout, trimmed. */
function gitOut(cwd, args, options = {}) {
	return git(cwd, args, options).stdout.trim();
}
/** A blob's bytes (`<sha>` or `<rev>:<path>`), or undefined when there's no such blob. */
function readObject(cwd, spec) {
	const result = spawnSync("git", [
		"cat-file",
		"blob",
		spec
	], {
		cwd,
		maxBuffer: 1 << 30
	});
	if (result.error) throw result.error;
	return result.status === 0 ? result.stdout : void 0;
}
/** NUL-separated output split into its entries. */
function splitZ(text) {
	return text.split("\0").filter((entry) => entry !== "");
}
function lines(text) {
	return text.split("\n").filter((line) => line !== "");
}
function shell(command, cwd, env) {
	return run$1("bash", [
		"-euo",
		"pipefail",
		"-c",
		command
	], cwd, {
		env,
		ok: "any"
	});
}

// src/log.ts
/**
* One wide event per pull request a run looks at: what the merge found, what it did, and why it
* stopped. The caller sets fields as it goes and emits once.
*/
function pullEvent(mode, pull) {
	const event = createRequestLogger();
	event.set({
		mode,
		pull: pull.number,
		base: pull.baseRefName,
		head: pull.headRefOid
	});
	return event;
}
/** A classification as event fields: the files each way of resolving took, and the owner's by cause. */
function classificationFields(classification) {
	return {
		union: classification.union,
		rerere: classification.rerere,
		regen: Object.fromEntries(classification.regen.map((group) => [group.rule.cause, group.paths])),
		owner: Object.fromEntries(classification.owner.map((group) => [group.cause, group.paths]))
	};
}
/** A GitHub annotation, which the run's summary page shows. */
function annotate(level, message) {
	console.log(`::${level}::${message}`);
}

// src/merge.ts
/**
* A tree holding the default branch's files with the union lines added to its root .gitattributes.
* Merges read attributes from it (`attr.tree`), never from the pull request's own .gitattributes,
* so a pull request can't mark its own files as safe to union.
*/
function attributesTree(repo, defaultRev, config) {
	const own = readObject(repo, `${defaultRev}:.gitattributes`)?.toString("utf8") ?? "";
	const text = `${own}${own === "" || own.endsWith("\n") ? "" : "\n"}${unionAttributes(config)}`;
	const blob = gitOut(repo, [
		"hash-object",
		"-w",
		"--stdin"
	], { input: text });
	const env = {
		...process.env,
		GIT_INDEX_FILE: join(tmpdir(), `remain-index-${process.pid}`)
	};
	try {
		git(repo, ["read-tree", defaultRev], { env });
		git(repo, [
			"update-index",
			"--add",
			"--cacheinfo",
			`100644,${blob},.gitattributes`
		], { env });
		return gitOut(repo, ["write-tree"], { env });
	} finally {
		rmSync(env.GIT_INDEX_FILE, { force: true });
	}
}
/** The settings every merge the bot makes or learns from runs with. */
function mergeFlags(attrTree) {
	return [
		"-c",
		`attr.tree=${attrTree}`,
		"-c",
		"rerere.enabled=true",
		"-c",
		"rerere.autoupdate=true",
		"-c",
		"user.name=remain",
		"-c",
		"user.email=remain@users.noreply.github.com",
		"-c",
		"commit.gpgsign=false"
	];
}
/** The files that conflict when `a` and `b` merge, as GitHub sees it: no attributes, no rerere. */
function plainConflicts(repo, a, b, attrTree = EMPTY_TREE) {
	const result = git(repo, [
		"-c",
		`attr.tree=${attrTree}`,
		"merge-tree",
		"--write-tree",
		"--name-only",
		"--no-messages",
		a,
		b
	], { ok: [0, 1] });
	return result.code === 0 ? [] : lines(result.stdout).slice(1);
}
function unmerged(dir) {
	return [...new Set(splitZ(gitOut(dir, [
		"diff",
		"--name-only",
		"-z",
		"--diff-filter=U"
	])))];
}
/**
* Merges `base` into `head` in a fresh worktree at `dir`, with the union attributes and rerere on,
* and sorts what's left. The worktree stays mid-merge for the caller to finish or drop.
*/
function prepare(repo, dir, head, base, attrTree, config) {
	const plain = plainConflicts(repo, head, base);
	removeWorktree(repo, dir);
	git(repo, [
		"worktree",
		"add",
		"--force",
		"--detach",
		dir,
		head
	]);
	const merge = git(dir, [
		...mergeFlags(attrTree),
		"merge",
		"--no-ff",
		"--no-commit",
		base
	], { ok: "any" });
	const remaining = unmerged(dir);
	const rerere = rerereResolved(`${merge.stdout}\n${merge.stderr}`);
	return {
		dir,
		plain,
		classification: classify(config, plain, remaining, rerere)
	};
}
function removeWorktree(repo, dir) {
	git(repo, [
		"worktree",
		"remove",
		"--force",
		dir
	], { ok: "any" });
	rmSync(dir, {
		recursive: true,
		force: true
	});
	git(repo, ["worktree", "prune"]);
}

// src/publish.ts
/**
* Finishes the push job's own merge with the merge job's rebuilt files, and returns the merged tree.
* The merge job ran the pull request's code, so nothing from it is trusted beyond this: each file
* must belong to a regen rule that has a conflict in this merge, and together they must resolve
* every conflict. Anything else throws.
*/
function applyPlan(dir, classification, files) {
	if (classification.owner.length > 0) throw new Error("the merge has conflicts no rule resolves");
	const rules = classification.regen.map((group) => group.rule);
	for (const file of files) {
		if (!rules.some((rule) => matches(rule, file.path))) throw new Error(`the merge job rebuilt ${file.path}, which no conflicting regen rule names`);
		if (file.mode !== "100644" && file.mode !== "100755") throw new Error(`${file.path} has mode ${String(file.mode)}`);
		if (file.content === null) {
			git(dir, [
				"update-index",
				"--force-remove",
				"--",
				file.path
			]);
			continue;
		}
		const blob = gitOut(dir, [
			"hash-object",
			"-w",
			"--stdin"
		], { input: Buffer.from(file.content, "base64") });
		git(dir, [
			"update-index",
			"--add",
			"--cacheinfo",
			`${file.mode},${blob},${file.path}`
		]);
	}
	const left = unmerged(dir);
	if (left.length > 0) throw new Error(`still conflicting: ${left.join(", ")}`);
	return gitOut(dir, ["write-tree"]);
}
/** How `tree` differs from `head`'s tree, as entries for the git trees API. */
function treeChanges(dir, head, tree) {
	const fields = splitZ(gitOut(dir, [
		"diff-tree",
		"-r",
		"-z",
		"--no-renames",
		head,
		tree
	]));
	const entries = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [oldMode = "", newMode = "", , sha = "", status = ""] = (fields[i] ?? "").slice(1).split(" ");
		const path = fields[i + 1] ?? "";
		if (status === "D") entries.push({
			path,
			mode: oldMode,
			type: "blob",
			sha: null
		});
		else entries.push({
			path,
			mode: newMode,
			type: newMode === "160000" ? "commit" : "blob",
			sha
		});
	}
	return entries;
}
/** Every blob in a commit's tree. */
function blobs(dir, rev) {
	return new Set(splitZ(gitOut(dir, [
		"ls-tree",
		"-r",
		"-z",
		rev
	])).map((line) => line.split("	")[0]?.split(" ")[2] ?? ""));
}
/**
* Writes the merge commit through GitHub's git data API, so GitHub signs it as the App, then moves
* the pull request's branch to it without force. Only blobs neither parent has are uploaded. Returns
* undefined when the branch moved since (someone pushed): the next run starts over from the new head.
*/
function publish(github, dir, branch, parents, tree, message) {
	const entries = treeChanges(dir, parents[0], tree);
	const known = /* @__PURE__ */ new Set([...blobs(dir, parents[0]), ...blobs(dir, parents[1])]);
	for (const entry of entries) {
		if (entry.type !== "blob" || entry.sha === null || known.has(entry.sha)) continue;
		const content = readObject(dir, entry.sha)?.toString("base64");
		if (content === void 0) throw new Error(`no blob ${entry.sha} for ${entry.path}`);
		const blob = github.api("POST", "git/blobs", {
			content,
			encoding: "base64"
		});
		if (blob.sha !== entry.sha) throw new Error(`GitHub stored ${entry.path} as ${blob.sha}, not ${entry.sha}`);
		known.add(entry.sha);
	}
	let built = gitOut(dir, ["rev-parse", `${parents[0]}^{tree}`]);
	for (let i = 0; i < entries.length; i += 500) built = github.api("POST", "git/trees", {
		base_tree: built,
		tree: entries.slice(i, i + 500)
	}).sha;
	if (built !== tree) throw new Error(`GitHub built tree ${built}, not the merged ${tree}`);
	const commit = github.api("POST", "git/commits", {
		message,
		tree,
		parents
	});
	try {
		github.api("PATCH", `git/refs/heads/${branch}`, {
			sha: commit.sha,
			force: false
		});
	} catch (error) {
		if (error instanceof GitHubError && error.status === 422) return void 0;
		throw error;
	}
	return {
		sha: commit.sha,
		verified: commit.verification.verified,
		reason: commit.verification.reason
	};
}

// src/regen.ts
/** Everything a command left different from the index: changed, deleted and new files. */
function changed(dir) {
	const modified = splitZ(gitOut(dir, [
		"diff",
		"--name-only",
		"-z"
	]));
	const added = splitZ(gitOut(dir, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z"
	]));
	return [.../* @__PURE__ */ new Set([...modified, ...added])].toSorted();
}
/**
* The environment a regenerate command gets: the job's, less anything that could act for the job.
* The merge job holds no secrets, but its inputs and the runner's own tokens are still in the
* environment, and the command is the pull request's code.
*/
function commandEnv(env) {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(INPUT_|ACTIONS_)|TOKEN|SECRET|PASSWORD|_KEY$/i.test(key)));
}
/**
* Rebuilds one rule's conflicting files: takes the base's copy of each (so the index has no
* conflict left), runs the rule's command, and stages what it wrote. Fails when the command fails,
* writes a file outside the rule's paths, or writes something different on a second run (its output
* isn't settled, so it can't be trusted to be what a fresh checkout would make).
*/
function regenerate(dir, rule, conflicts, base) {
	for (const path of conflicts) if (readObject(dir, `${base}:${path}`) === void 0) git(dir, [
		"rm",
		"--quiet",
		"--force",
		"--",
		path
	]);
	else git(dir, [
		"checkout",
		base,
		"--",
		path
	]);
	const env = commandEnv(process.env);
	const written = /* @__PURE__ */ new Set();
	for (const pass of [1, 2]) {
		const result = shell(rule.regen, dir, env);
		if (result.code !== 0) return {
			ok: false,
			error: `\`${rule.regen}\` exited ${result.code}: ${result.stderr.trim().slice(-2e3)}`
		};
		const paths = changed(dir);
		const outside = paths.filter((path) => !matches(rule, path));
		if (outside.length > 0) return {
			ok: false,
			error: `\`${rule.regen}\` changed files outside its paths: ${outside.join(", ")}`
		};
		if (pass === 2 && paths.length > 0) return {
			ok: false,
			error: `\`${rule.regen}\` wrote different output on a second run: ${paths.join(", ")}`
		};
		if (paths.length > 0) git(dir, [
			"add",
			"--all",
			"--",
			...paths
		]);
		for (const path of paths) written.add(path);
	}
	for (const path of conflicts) written.add(path);
	return {
		ok: true,
		files: [...written].toSorted().map((path) => planFile(dir, path))
	};
}
function planFile(dir, path) {
	const full = join(dir, path);
	if (!existsSync(full)) return {
		path,
		mode: "100644",
		content: null
	};
	return {
		path,
		mode: (lstatSync(full).mode & 73) !== 0 ? "100755" : "100644",
		content: readFileSync(full).toString("base64")
	};
}

// src/report.ts
/** Starts the one comment the bot keeps on a pull request, so later runs edit it in place. */
const MARKER = "<!-- remain -->";
const finish = (lines) => lines.join("\n").trimEnd();
const code = (path) => `\`${path}\``;
function resolvedLines(classification) {
	return [
		...classification.union.map((path) => `- ${code(path)}: kept both sides' lines`),
		...classification.rerere.map((path) => `- ${code(path)}: replayed an earlier reviewed resolution`),
		...classification.regen.flatMap((group) => group.paths.map((path) => `- ${code(path)}: rebuilt with ${code(group.rule.regen ?? "")}`))
	];
}
function ownerComment(base, classification) {
	const groups = classification.owner.flatMap((group) => [
		`**${group.cause}**`,
		...group.paths.map((path) => `- ${code(path)}`),
		""
	]);
	const resolved = resolvedLines(classification);
	return finish([
		MARKER,
		`\`${base}\` can't be merged in automatically. These files need you:`,
		"",
		...groups,
		...resolved.length > 0 ? [
			"These would have been resolved:",
			"",
			...resolved
		] : []
	]);
}
function failedComment(base, error, runUrl) {
	return finish([MARKER, `\`${base}\` can't be merged in automatically: ${error}. [Run](${runUrl})`]);
}
function pushedComment(base, sha, classification) {
	return finish([
		MARKER,
		`Merged \`${base}\` in with ${sha.slice(0, 9)}:`,
		"",
		...resolvedLines(classification)
	]);
}
function clearedComment() {
	return finish([MARKER, "No conflicts left."]);
}
function ciState(pull) {
	if (pull.ci === "SUCCESS") return "passing";
	if (pull.ci === "FAILURE" || pull.ci === "ERROR") return "failing";
	return "pending";
}
/**
* The commits since the newest commit an approver approved (approvals GitHub dismissed on a push
* count too), or undefined when there's none on the branch. An approved commit that's gone from the
* branch (a force-push) doesn't count: nothing after it can be trusted.
*/
function sinceApproval(pull, approvers) {
	const approved = new Set(pull.approvals.filter((approval) => approvers.includes(approval.login)).map((approval) => approval.oid));
	const index = pull.commits.findLastIndex((oid) => approved.has(oid));
	if (index === -1) return void 0;
	return {
		approved: pull.commits[index] ?? "",
		since: pull.commits.slice(index + 1)
	};
}
/**
* Pull requests where everything since an approver's last approval is the bot's own merges, so
* re-approving them is all they need. `isOwn` decides which commits are the bot's. One with anyone
* else's commits since, or whose approved commit is gone, isn't listed: it needs a full review.
*/
function digest(pulls, approvers, isOwn) {
	const entries = [];
	for (const pull of pulls) {
		const range = sinceApproval(pull, approvers);
		if (!range || range.since.length === 0) continue;
		if (!range.since.every(isOwn)) continue;
		const repoUrl = pull.url.replace(/\/pull\/\d+$/, "");
		entries.push({
			number: pull.number,
			title: pull.title,
			url: pull.url,
			compare: `${repoUrl}/compare/${range.approved}...${pull.headRefOid}`,
			ci: ciState(pull)
		});
	}
	return entries.toSorted((a, b) => a.number - b.number);
}
function renderDigest(entries) {
	if (entries.length === 0) return "Nothing to re-approve.\n";
	return [
		"| Pull request | CI | Since your approval |",
		"| --- | --- | --- |",
		...entries.map((entry) => `| [#${entry.number}](${entry.url}) ${entry.title.replaceAll("|", "\\|")} | ${entry.ci} | [changes](${entry.compare}) |`),
		""
	].join("\n");
}

// src/rerere.ts
/** Merges already learned from, kept in the rr-cache so a restored cache isn't learned again. */
function trainedFile(repo) {
	return join(gitOut(repo, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir"
	]), "rr-cache", "trained");
}
/**
* Teaches rerere the resolutions in `merges`, the way git's contrib/rerere-train.sh does: redo each
* merge, let rerere record the conflict, then show it the merge's committed result. Merges that
* replay without a conflict are skipped before any checkout, since there's nothing to learn and
* most of a repository's merges are clean ones.
*/
function train(repo, dir, merges, attrTree) {
	const file = trainedFile(repo);
	mkdirSync(join(file, ".."), { recursive: true });
	const done = new Set(existsSync(file) ? lines(readFileSync(file, "utf8")) : []);
	const learned = [];
	let worktree = false;
	try {
		for (const merge of merges) {
			if (done.has(merge)) continue;
			done.add(merge);
			appendFileSync(file, `${merge}\n`);
			const parents = gitOut(repo, [
				"rev-list",
				"--parents",
				"-n",
				"1",
				merge
			]).split(" ").slice(1);
			if (parents.length !== 2) continue;
			const [ours = "", theirs = ""] = parents;
			if (plainConflicts(repo, ours, theirs, attrTree).length === 0) continue;
			if (!worktree) {
				removeWorktree(repo, dir);
				git(repo, [
					"worktree",
					"add",
					"--force",
					"--detach",
					dir,
					ours
				]);
				worktree = true;
			}
			git(dir, [
				"checkout",
				"--quiet",
				"--force",
				"--detach",
				ours
			]);
			git(dir, [
				...mergeFlags(attrTree),
				"merge",
				"--no-ff",
				"--no-commit",
				theirs
			], { ok: "any" });
			git(dir, [
				"checkout",
				merge,
				"--",
				"."
			]);
			git(dir, [...mergeFlags(attrTree), "rerere"]);
			git(dir, ["merge", "--abort"], { ok: "any" });
			git(dir, [
				"reset",
				"--quiet",
				"--hard"
			]);
			learned.push(merge);
		}
	} finally {
		if (worktree) removeWorktree(repo, dir);
	}
	return learned;
}
/** The default branch's merges since `since`, oldest first. */
function defaultBranchMerges(repo, rev, since) {
	return lines(gitOut(repo, [
		"rev-list",
		"--merges",
		"--reverse",
		`--since=${since}`,
		rev
	]));
}
/** The merges on a pull request's branch up to `approved`, that aren't on the default branch yet. */
function approvedMerges(repo, approved, defaultRev) {
	return lines(gitOut(repo, [
		"rev-list",
		"--merges",
		"--reverse",
		approved,
		`^${defaultRev}`
	]));
}

// src/select.ts
/**
* Which pull requests to merge into. Only ones GitHub marks DIRTY: a clean pull request never gets
* its base merged in, since the merge queue tests it against main anyway and every push costs a
* re-approval. A stacked pull request (based on another one's branch) waits until its parent isn't
* DIRTY, so a stack is worked from the bottom up, one level per run. Forks are left to their owners:
* the bot can't push to them and their code is less trusted.
*/
function select(pulls, defaultBranch) {
	const byHead = new Map(pulls.filter((pull) => !pull.isCrossRepository).map((pull) => [pull.headRefName, pull]));
	return pulls.filter((pull) => pull.mergeStateStatus === "DIRTY").map((pull) => {
		if (pull.isCrossRepository) return {
			pull,
			action: "skip",
			reason: "its branch is on a fork"
		};
		if (pull.baseRefName === defaultBranch) return {
			pull,
			action: "merge"
		};
		const parent = byHead.get(pull.baseRefName);
		if (!parent) return {
			pull,
			action: "skip",
			reason: `no open pull request has ${pull.baseRefName}`
		};
		if (parent.mergeStateStatus === "DIRTY") return {
			pull,
			action: "skip",
			reason: `waiting on #${parent.number}`
		};
		return {
			pull,
			action: "merge"
		};
	}).toSorted((a, b) => a.pull.number - b.pull.number);
}

// src/run.ts
const DEFAULT_REF = "refs/remain/default";
const headRef = (number) => `refs/remain/pull/${number}`;
const baseRef = (pull, defaultBranch) => pull.baseRefName === defaultBranch ? DEFAULT_REF : `refs/remain/base/${pull.number}`;
function fetch(options, refspecs) {
	const auth = Buffer.from(`x-access-token:${options.token}`).toString("base64");
	const header = `http.${options.server}/.extraheader=AUTHORIZATION: basic ${auth}`;
	git(options.repo, [
		"-c",
		header,
		"fetch",
		"--quiet",
		"--no-tags",
		"--force",
		"origin",
		...refspecs
	]);
}
/**
* What both modes start from: the base branch's config, the pull requests to merge into, and the
* resolutions learned from merges already reviewed.
*/
function setup(options) {
	const { repo, github } = options;
	const event = createRequestLogger();
	const defaultBranch = options.base ?? github.defaultBranch();
	const pulls = github.pulls();
	const sameRepo = pulls.filter((pull) => !pull.isCrossRepository);
	event.set({
		base: defaultBranch,
		pulls: pulls.length
	});
	fetch(options, [
		`+refs/heads/${defaultBranch}:${DEFAULT_REF}`,
		...sameRepo.map((pull) => `+refs/pull/${pull.number}/head:${headRef(pull.number)}`),
		...sameRepo.filter((pull) => pull.baseRefName !== defaultBranch).map((pull) => `+refs/heads/${pull.baseRefName}:${baseRef(pull, defaultBranch)}`)
	]);
	const configText = readObject(repo, `${DEFAULT_REF}:${options.config}`);
	if (!configText) throw new Error(`${defaultBranch} has no ${options.config}`);
	const config = parseConfig(configText.toString("utf8"));
	const attrTree = attributesTree(repo, DEFAULT_REF, config);
	const merges = [...defaultBranchMerges(repo, DEFAULT_REF, config.since), ...sameRepo.flatMap((pull) => {
		const range = sinceApproval(pull, config.approvers);
		return range ? approvedMerges(repo, range.approved, DEFAULT_REF) : [];
	})];
	const learned = train(repo, join(options.scratch, "train"), [...new Set(merges)], attrTree);
	const picks = select(pulls, defaultBranch);
	event.set({
		rerere: {
			merges: merges.length,
			learned: learned.length
		},
		dirty: picks.length
	});
	event.emit();
	return {
		options,
		config,
		defaultBranch,
		attrTree,
		pulls,
		picks
	};
}
/** Merges a picked pull request's base in, in its own worktree, or says why it can't. */
function prepared(context, pull) {
	const { repo, scratch } = context.options;
	const head = gitOut(repo, ["rev-parse", headRef(pull.number)]);
	if (head !== pull.headRefOid) return `its head moved to ${head.slice(0, 9)} while this ran`;
	const base = gitOut(repo, ["rev-parse", baseRef(pull, context.defaultBranch)]);
	if (git(repo, [
		"merge-base",
		"--is-ancestor",
		base,
		head
	], { ok: [0, 1] }).code === 0) return `it already has ${pull.baseRefName}`;
	return prepare(repo, join(scratch, String(pull.number)), head, base, context.attrTree, context.config);
}
/**
* Merges one pull request's base in and, when every conflict is mechanical and some file needs
* rebuilding, returns its number. With `rebuild` it also runs the regen commands and writes the plan
* the push job reads.
*/
function mergeOne(context, pick, event, rebuild) {
	const { options } = context;
	const { pull } = pick;
	const result = pick.action === "skip" ? pick.reason : prepared(context, pull);
	if (typeof result === "string") {
		event.set({ skipped: result });
		return;
	}
	try {
		const { classification } = result;
		event.set(classificationFields(classification));
		if (!isMechanical(classification) || classification.regen.length === 0) return void 0;
		if (!rebuild) return pull.number;
		const base = gitOut(result.dir, ["rev-parse", "MERGE_HEAD"]);
		const plan = {
			number: pull.number,
			head: pull.headRefOid,
			base,
			ok: true,
			files: []
		};
		for (const group of classification.regen) {
			const outcome = regenerate(result.dir, {
				...group.rule,
				regen: group.rule.regen ?? ""
			}, group.paths, base);
			if (!outcome.ok) {
				event.warn(outcome.error, { rule: group.rule.cause });
				annotate("warning", `#${pull.number}: ${outcome.error}`);
				plan.ok = false;
				plan.files = [];
				break;
			}
			plan.files.push(...outcome.files);
		}
		event.set({
			rebuilt: plan.files.map((file) => file.path),
			regenerated: plan.ok
		});
		writeFileSync(join(options.plans, `${pull.number}.json`), JSON.stringify(plan));
		return pull.number;
	} finally {
		removeWorktree(options.repo, result.dir);
	}
}
/** Runs `each` on the picks, with one wide event per pull request. */
function eachPick(picks, mode, each) {
	return picks.map((pick) => {
		const event = pullEvent(mode, pick.pull);
		try {
			return each(pick, event);
		} catch (error) {
			event.error(error);
			throw error;
		} finally {
			event.emit();
		}
	});
}
/**
* The pull requests with files to rebuild, for the caller's matrix of merge jobs. Listing runs no
* repository code: git merges with hooks off and no drivers but union.
*/
function listMode(context) {
	const pulls = eachPick(context.picks, "list", (pick, event) => mergeOne(context, pick, event, false)).filter((number) => number !== void 0);
	if (context.options.output) appendFileSync(context.options.output, `pulls=${JSON.stringify(pulls)}\n`);
}
/**
* Rebuilds one pull request's files. Each runs in its own job, so one pull request's regen command,
* which is its own code, can't touch the files rebuilt for another.
*/
function mergeMode(context) {
	const { options } = context;
	if (options.pull === void 0) throw new Error("merge mode needs pull");
	mkdirSync(options.plans, { recursive: true });
	eachPick(context.picks.filter((pick) => pick.pull.number === options.pull), "merge", (pick, event) => mergeOne(context, pick, event, true));
}
/** The bot's own comment on a pull request, found by its marker and author. */
function ownComment(context, number) {
	const { github, commentAuthor } = context.options;
	return github.list(`issues/${number}/comments`).find((comment) => comment.user?.login === commentAuthor && comment.body.startsWith("<!-- remain -->"));
}
function upsertComment(github, number, existing, body) {
	if (existing?.body === body) return;
	if (existing) github.api("PATCH", `issues/comments/${existing.id}`, { body });
	else github.api("POST", `issues/${number}/comments`, { body });
}
function setLabel(github, pull, label, on) {
	const has = pull.labels.includes(label);
	if (on && !has) github.api("POST", `issues/${pull.number}/labels`, { labels: [label] });
	if (on || !has) return;
	try {
		github.api("DELETE", `issues/${pull.number}/labels/${encodeURIComponent(label)}`);
	} catch (error) {
		if (!(error instanceof GitHubError && error.status === 404)) throw error;
	}
}
function readPlan(options, number) {
	const file = join(options.plans, `${number}.json`);
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : void 0;
}
function pushOne(context, appGitHub, pull, event) {
	const { options, config } = context;
	const { github } = options;
	const comment = ownComment(context, pull.number);
	const needsOwner = (body) => {
		event.set({ outcome: "needs owner" });
		setLabel(github, pull, config.label, true);
		upsertComment(github, pull.number, comment, body);
	};
	const result = prepared(context, pull);
	if (typeof result === "string") {
		event.set({ skipped: result });
		return;
	}
	try {
		const { classification } = result;
		event.set(classificationFields(classification));
		if (!isMechanical(classification)) {
			needsOwner(ownerComment(pull.baseRefName, classification));
			return;
		}
		const base = gitOut(result.dir, ["rev-parse", "MERGE_HEAD"]);
		let files = [];
		if (classification.regen.length > 0) {
			const plan = readPlan(options, pull.number);
			if (!plan || plan.head !== pull.headRefOid || plan.base !== base) {
				event.set({ skipped: "the merge job left no rebuilt files for this head" });
				return;
			}
			if (!plan.ok) {
				needsOwner(failedComment(pull.baseRefName, "rebuilding a generated file failed", options.runUrl));
				return;
			}
			files = plan.files;
		}
		const tree = applyPlan(result.dir, classification, files);
		const message = `Merge branch '${pull.baseRefName}' into ${pull.headRefName}`;
		const published = publish(appGitHub, result.dir, pull.headRefName, [pull.headRefOid, base], tree, message);
		if (!published) {
			event.set({ skipped: "the branch moved before the push" });
			return;
		}
		event.set({
			outcome: "pushed",
			commit: published.sha,
			verified: published.verified
		});
		const signature = published.verified ? "verified" : `not verified (${published.reason})`;
		annotate("notice", `#${pull.number}: merged ${pull.baseRefName} in with ${published.sha}, signature ${signature}`);
		setLabel(github, pull, config.label, false);
		const body = pushedComment(pull.baseRefName, published.sha, classification);
		upsertComment(github, pull.number, comment, body);
	} finally {
		removeWorktree(options.repo, result.dir);
	}
}
/**
* Whether the App made `sha`: GitHub verified its signature and its committer is the App's bot.
* GitHub only signs an API commit for the identity that made it, and nobody else can make one as the
* App, while a commit's author and committer emails can say anything. A comment by the workflow's
* token can't be the record either, since any workflow in the repository can post as that bot.
*/
function isOwnCommit(github, login, sha) {
	const info = github.api("GET", `commits/${sha}`);
	return info.commit.verification.verified && info.committer?.login === login;
}
function pushMode(context) {
	const { options, config } = context;
	const { github, app } = options;
	if (!app) throw new Error("push mode needs app-token and app-slug");
	eachPick(context.picks, "push", (pick, event) => {
		const { pull } = pick;
		if (pick.action === "merge") return pushOne(context, app.github, pull, event);
		event.set({ skipped: pick.reason });
		if (!pull.isCrossRepository) return;
		const comment = ownComment(context, pull.number);
		setLabel(github, pull, config.label, true);
		upsertComment(github, pull.number, comment, failedComment(pull.baseRefName, pick.reason, options.runUrl));
	});
	for (const pull of context.pulls) {
		if (!pull.labels.includes(config.label) || pull.mergeStateStatus === "DIRTY") continue;
		const comment = ownComment(context, pull.number);
		setLabel(github, pull, config.label, false);
		if (comment) upsertComment(github, pull.number, comment, clearedComment());
	}
	const entries = digest(github.pulls(), config.approvers, (sha) => isOwnCommit(github, app.login, sha));
	const markdown = renderDigest(entries);
	mkdirSync(options.digest, { recursive: true });
	writeFileSync(join(options.digest, "digest.md"), markdown);
	writeFileSync(join(options.digest, "digest.json"), `${JSON.stringify(entries, null, "	")}\n`);
	if (options.summary) appendFileSync(options.summary, `## Re-approve\n\n${markdown}`);
}
const modes = {
	list: listMode,
	merge: mergeMode,
	push: pushMode
};
function run(mode, options) {
	mkdirSync(options.scratch, { recursive: true });
	modes[mode](setup(options));
}

// src/main.ts
initLogger({
	env: { service: "remain" },
	pretty: false
});
const isMode = (value) => [
	"list",
	"merge",
	"push"
].includes(value);
function input(name, fallback = "") {
	return process.env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;
}
try {
	const mode = input("mode");
	if (!isMode(mode)) throw new Error(`mode must be list, merge or push, not "${mode}"`);
	const repo = process.env.GITHUB_REPOSITORY ?? "";
	const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
	const token = input("token");
	const appToken = input("app-token");
	const appSlug = input("app-slug");
	const summary = process.env.GITHUB_STEP_SUMMARY;
	const output = process.env.GITHUB_OUTPUT;
	const pull = input("pull");
	run(mode, {
		repo: resolve(process.env.GITHUB_WORKSPACE ?? "."),
		github: new GitHub(repo, token),
		...appToken && appSlug ? { app: {
			github: new GitHub(repo, appToken),
			login: `${appSlug}[bot]`
		} } : {},
		...input("base") ? { base: input("base") } : {},
		token,
		server,
		scratch: join(process.env.RUNNER_TEMP ?? resolve(".."), "remain"),
		config: input("config", ".github/remain.json"),
		plans: resolve(input("plans", "remain-plans")),
		digest: resolve(input("digest", "remain-digest")),
		commentAuthor: input("comment-author", "github-actions[bot]"),
		runUrl: `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
		...summary ? { summary } : {},
		...output ? { output } : {},
		...pull ? { pull: Number(pull) } : {}
	});
} catch (error) {
	console.log(`::error::${error.message}`);
	process.exitCode = 1;
}

export {  };