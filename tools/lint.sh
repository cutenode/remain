#!/usr/bin/env bash
# Types, lints, formatting, the bundle's freshness, and the linters below where they're installed.
# CI's lint check, and the pre-push hook. CI installs them all and sets REQUIRE_LINTERS=true, so
# there a missing one fails instead of being skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
PATH=$PWD/node_modules/.bin:$PATH

# Whether linter $1 is installed, failing when it isn't and REQUIRE_LINTERS is true.
have() {
	command -v "$1" >/dev/null && return
	if [[ ${REQUIRE_LINTERS:-} == true ]]; then
		echo "$1 isn't installed, and REQUIRE_LINTERS is true" >&2
		exit 1
	fi
	return 1
}

tsc
oxlint
oxfmt --check
# Unused files, exports and dependencies, configured in knip.jsonc.
knip
# dist/ is what action.yml runs, so it has to match src/.
node --run build >/dev/null
if ! git diff --quiet -- dist || [[ -n $(git ls-files --others --exclude-standard -- dist) ]]; then
	echo "dist/ isn't what src/ builds: run \`pnpm build\` and commit it" >&2
	exit 1
fi
if have shellcheck; then
	shellcheck tools/*.sh
fi
# Spelling, configured in _typos.toml.
if have typos; then
	typos
fi
# Links to files and anchors in the Markdown, configured in lychee.toml. scheduled.yml checks the
# rest weekly, so a site that's down doesn't fail a pull request.
if have lychee; then
	lychee --offline --no-progress .
fi
# The workflows and action.yml. zizmor runs its online audits (impostor commits, known-vulnerable
# actions) when GH_TOKEN is set, as scheduled.yml's weekly run does.
if have zizmor; then
	zizmor --quiet .
fi
if have actionlint; then
	actionlint
fi
