#!/usr/bin/env bash
# Types, lints, formatting, the bundle's freshness, and the linters below where they're installed.
# CI's lint check, and the pre-push hook. CI installs them all and sets REQUIRE_LINTERS=true, so
# there a missing one fails instead of being skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
# Git exports these to the hooks that run this script. Unset, every git call below works on the
# repository its directory is in, including the scratch one the caller check makes.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
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
	# The README's caller workflow, checked by actionlint against .github/workflows/remain.yml, so
	# its inputs and permissions stay right. actionlint only reads a local reusable workflow.
	caller=$(mktemp -d)
	trap 'rm -rf "$caller"' EXIT
	mkdir -p "$caller/.github/workflows"
	cp .github/workflows/remain.yml "$caller/.github/workflows/"
	cp .github/actionlint.yaml "$caller/.github/"
	awk '/^```yaml$/ { inside = 1; next } /^```$/ { inside = 0 } inside' README.md |
		sed 's|cutenode/remain/.github/workflows/remain.yml@<commit sha>|./.github/workflows/remain.yml|' \
			>"$caller/.github/workflows/caller.yml"
	if ! grep -q 'uses: ./.github/workflows/remain.yml' "$caller/.github/workflows/caller.yml"; then
		echo "README.md has no caller workflow for remain.yml" >&2
		exit 1
	fi
	git -C "$caller" init --quiet
	(cd "$caller" && actionlint)
fi
