# remain

A GitHub Action that merges the base branch into a conflicting pull request when every conflict is mechanical, and labels the rest for their owners.

It only touches pull requests GitHub marks as conflicting (`DIRTY`). A pull request that's merely behind is left alone: a merge queue tests it against main anyway, and every push asks for a new approval.

A conflict is mechanical when one of these resolves it:

- **union**: an append-only list, one entry per line, where git's `merge=union` keeps both sides' lines.
- **regen**: a generated file or lockfile, rebuilt with its own command. The command runs a second time and has to write the same thing, and it may only change the files its rule names.
- **rerere**: the same conflict, hunk for hunk, was already resolved in a merge that's on the default branch or in an approved pull request. `git rerere` replays that resolution.

Anything else, including any file no rule names, gets the `needs-owner` label and one comment listing the conflicting files by cause. remain never guesses at code.

It never approves anything. Every push it makes still needs a reviewer's approval, and each run writes the pull requests waiting on one to a `remain-digest` artifact.

## Setup

1. Create a GitHub App for the repository (steps below), and put its client ID in an Actions variable `REMAIN_CLIENT_ID` and its private key in an environment secret `REMAIN_PRIVATE_KEY`, both on an environment `remain` that only the default branch can deploy to.
2. Add `.github/remain.json` to the default branch.
3. Add the workflow below.

### The App

The push has to come from an App: a push with the workflow's own `GITHUB_TOKEN` doesn't start CI on the pull request.

1. Go to the organization's Settings, Developer settings, GitHub Apps, New GitHub App.
2. Give it a name and a homepage, and untick Webhook, Active.
3. Under Repository permissions, set **Contents** and **Workflows** to Read and write. Workflows is needed because merging main in usually brings workflow changes with it, and GitHub refuses those from an App without it. Nothing else: labels and comments use `GITHUB_TOKEN`.
4. Where can this GitHub App be installed: Only on this account. Create it.
5. Note the Client ID, and generate a private key.
6. Install the App on the repositories that run remain, and only those.

### Config

`.github/remain.json` is always read from the default branch, never from a pull request:

```json
{
	"rules": [
		{ "cause": "lockfile", "paths": ["Cargo.lock"], "regen": "cargo metadata --format-version 1 > /dev/null" },
		{ "cause": "lockfile", "paths": ["pnpm-lock.yaml"], "regen": "pnpm install --lockfile-only --ignore-scripts" },
		{ "cause": "changelog", "paths": ["changes/*.txt"], "union": true },
		{ "cause": "committed numbers", "paths": ["benchmarks/budgets/**"] }
	],
	"approvers": ["bnb"],
	"since": "30 days ago",
	"label": "needs-owner"
}
```

- `rules`: the first rule whose `paths` (globs from the repository root) match a file decides it. A rule with neither `union` nor `regen` only names the cause in the comment; files no rule matches show as "code or prose".
- `approvers`: whose approvals count. rerere learns from merges in a pull request up to the newest commit one of them approved, and the digest lists pull requests where everything since that approval is remain's.
- `since`: how far back rerere learns from the default branch's merges.
- `label`: the label for pull requests that need their owner.

### Workflow

```yaml
name: remain

on:
  push:
    branches: [main]
  schedule:
    - cron: '23 * * * *'
  workflow_dispatch:

permissions: {}

concurrency:
  group: remain

jobs:
  # The pull requests whose merge needs files rebuilt. Runs none of the repository's code.
  list:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      pulls: ${{ steps.remain.outputs.pulls }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .git/rr-cache
          key: remain-rerere-${{ github.run_id }}
          restore-keys: remain-rerere-
      - id: remain
        uses: cutenode/remain@<commit sha>
        with:
          mode: list

  # Rebuilds one pull request's files with its regen commands, which run its code. One job each, so
  # one pull request's code can't touch another's files. No secrets here.
  merge:
    needs: list
    if: needs.list.outputs.pulls != '[]'
    strategy:
      fail-fast: false
      matrix:
        pull: ${{ fromJSON(needs.list.outputs.pulls) }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      # Install whatever the regen commands need here.
      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .git/rr-cache
          key: remain-rerere-${{ github.run_id }}
          restore-keys: remain-rerere-
      - uses: cutenode/remain@<commit sha>
        with:
          mode: merge
          pull: ${{ matrix.pull }}
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: remain-plans-${{ matrix.pull }}
          path: remain-plans
          retention-days: 1

  # Checks the merge jobs' work without running any of the repository's code, then pushes. It
  # restores no cache: the merge jobs could have written one, so it learns its resolutions itself.
  push:
    needs: [list, merge]
    if: ${{ !cancelled() && needs.list.result == 'success' }}
    runs-on: ubuntu-latest
    environment: remain
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - if: needs.list.outputs.pulls != '[]'
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          pattern: remain-plans-*
          path: remain-plans
          merge-multiple: true
      - id: app
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: ${{ vars.REMAIN_CLIENT_ID }}
          private-key: ${{ secrets.REMAIN_PRIVATE_KEY }}
          permission-contents: write
          permission-workflows: write
      - uses: cutenode/remain@<commit sha>
        with:
          mode: push
          app-token: ${{ steps.app.outputs.token }}
          app-slug: ${{ steps.app.outputs.app-slug }}
      # What it learned, for the next run's list and merge jobs.
      - uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .git/rr-cache
          key: remain-rerere-push-${{ github.run_id }}
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: remain-digest
          path: remain-digest
```

The schedule moves stacks along: a pull request based on another one's branch waits while its parent conflicts, so a stack is worked from the bottom up, one level per run. A push to a pull request's branch doesn't start this workflow.

### The digest

Each run's `remain-digest` artifact holds `digest.md` and `digest.json`: the pull requests where every commit since an approver's last approval is one of remain's merges, with their CI state and a link to the changes since. To read the newest:

```bash
gh run download --repo <owner>/<repo> --name remain-digest \
  "$(gh run list --repo <owner>/<repo> --workflow remain --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The same table is on each run's summary page.

## Threat model

- **Nothing a pull request holds can start it or change it.** It runs on pushes to the default branch, a schedule and `workflow_dispatch`, never `pull_request_target` or `workflow_run`. The workflow, `.github/remain.json` and the `.gitattributes` used for merging all come from the default branch. A pull request's own `.gitattributes` is ignored, so it can't mark its own files as safe to union.
- **The pull request's code runs only in the merge jobs**, through the regen commands (a lockfile resolver or code generator builds the merged tree), one job per pull request so no pull request's code can reach another's files. A merge job has no secrets, a read-only token, no saved credentials (`persist-credentials: false`; fetches send the token in a header), and only restores caches. The commands get an environment without the action's inputs or anything named like a token, secret, password or key, but that's not a sandbox: code running as the runner's user can read the job's other processes, including the token the runner uses for caches and artifacts. Listing and pushing run none of the repository's code, and git runs with hooks off.
- **The push job trusts nothing from the merge jobs.** It redoes each merge itself (git only, no repository code), and takes from a merge job's artifact only the bytes of files that belong to a regen rule with a conflict in that merge. They have to resolve every conflict, and the result has to be the tree GitHub builds, or nothing is pushed. It restores no cache, since a merge job could have written one; it learns its rerere resolutions from reviewed merges every run. The worst a hostile pull request can do through the artifacts is change its own generated files, which then needs a reviewer like any push, and which CI's freshness checks still test.
- **What's left: the merge jobs run in the default branch's context.** Only branches in the repository itself are merged (forks are labelled and skipped), so only someone who can push branches here gets code into a merge job. Through the runner's cache token, that code could save cache entries other workflows on the default branch restore. Keep cache restores in other workflows keyed so they can't pick up an entry this workflow wrote, or don't run remain where the regen commands can't be trusted that far.
- **Pushes can't overwrite anyone.** The merge commit is written through the git data API with the pull request's head and the base as parents, and the branch moves without force, so a push that raced in wins and the next run starts over.
- **The App key lives in an environment only the default branch can use,** and the App can write contents and workflows on the repositories it's installed on, nothing else.
- **No approvals.** remain has no code that reviews, and its App has no pull request permission. The digest counts a commit as remain's only when GitHub verified its signature and its committer is the App's bot: GitHub signs an API commit only for the identity that made it, while a commit's author and committer emails can say anything, and any workflow in the repository can comment as `github-actions[bot]`. If GitHub doesn't sign the App's commits, the digest stays empty rather than guessing.

## Development

```bash
pnpm install       # also installs the git hooks
pnpm lint          # tools/lint.sh: tsc, oxlint, oxfmt, knip, the bundle, shellcheck, typos, lychee, zizmor, actionlint
pnpm coverage      # the tests, with coverage thresholds
pnpm build         # dist/main.mjs, the bundle action.yml runs
```

The action calls git and the `gh` CLI that GitHub's runners have, and logs one [evlog](https://evlog.dev) event per pull request it looks at. `dist/` is committed, since an action runs from the repository as it is; the pre-commit hook rebuilds it and the lint fails when it's stale.

The tests make real repositories in a temporary folder and stand in for GitHub with a local bare repository (`test/fake-github.ts`). `test/props.test.ts` checks the classifier, the pull request selection, the config and the digest with [fast-check](https://fast-check.dev), on a fixed seed in pull requests and random ones weekly (`scheduled.yml`). `src/main.ts` (reading the inputs) and `src/github.ts` (the `gh` calls) are left out of coverage; the end-to-end run in [cutenode/remain-e2e](https://github.com/cutenode/remain-e2e) covers them against GitHub.

## License

MIT
