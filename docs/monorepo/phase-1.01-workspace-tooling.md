# Sub-phase 1.1: Workspace tooling (no file moves), which opens PR 1

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.1 (workspace tooling) of PR 1, the eventyr monorepo refactor.
>
> **PR 0 must be merged first.** It lands `docs/monorepo/` on `main`. Create the PR branch: `git fetch origin main && git checkout -b monorepo/refactor origin/main`.
> Use `monorepo/refactor` even if your environment suggests another branch. If you can't push to it, stop and ask.
>
> Then read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.01-workspace-tooling.md`, and no other phase files.
>
> Follow the ordered steps. Push the branch and open a **draft** PR titled "Monorepo refactor (PR 1)". Its description must contain a checklist of sub-phases 1.1 to 1.13. Post the verification results as a PR comment, then tick 1.1.
>
> If a check fails and the fix isn't obvious and in scope, stop and report. Don't merge, and don't start 1.2.

## Goal

Set up the tooling every later sub-phase depends on, without changing any source code or the
layout:

- pnpm 11, pinned via `packageManager`
- `pnpm-workspace.yaml` with catalogs and build approvals
- `workers/mcp` as a workspace member on the root lockfile
- a PR CI workflow
- a deploy workflow built from explicit steps
- `scripts/site-fingerprint.sh`, which later sub-phases use to prove the site is unchanged

## Preconditions

- `main` is green.
- PLAN.md §0 is in place. It already records your decisions.

## Files affected

- `package.json`: add `packageManager` and `engines`; set `typescript`/`tsx`/`react*`/`@types/react*` to `catalog:`.
- New: `pnpm-workspace.yaml`.
- `pnpm-lock.yaml`: regenerated with importers `.` and `workers/mcp`.
- `workers/mcp/package.json`: `catalog:` entries. Delete `workers/mcp/pnpm-lock.yaml`.
- `.github/workflows/deploy.yml`: rewrite the build job.
- `.github/workflows/{digest,add-city,reprobe}.yml`: drop `version: 9` from `pnpm/action-setup`.
- New: `.github/workflows/ci.yml`.
- New: `scripts/site-fingerprint.sh`.
- `CLAUDE.md`: one line about pnpm 11.

## Steps

1. **Baseline on current tooling.** Record the output in the PR comment.
   ```bash
   pnpm --version                      # 9.x
   pnpm install --frozen-lockfile && pnpm check
   TZ=Australia/Brisbane pnpm build
   ```
2. **Commit `scripts/site-fingerprint.sh` (executable) on its own**, so the baseline comes from the committed script:
   ```bash
   #!/usr/bin/env bash
   # Fingerprints a built Astro site so structural refactors can prove the output is unchanged.
   # Hashed bundles under _astro/ are excluded and references to them normalised, because
   # moving a module changes its chunk hash without changing what the page renders.
   # Build both sides on the same day: /today/ and /tomorrow/ pages depend on the build clock.
   set -euo pipefail
   dist="${1:?usage: site-fingerprint.sh <dist-dir> <out-file>}"
   out="${2:?usage: site-fingerprint.sh <dist-dir> <out-file>}"
   out="$(realpath -m "$out")"
   cd "$dist"
   find . -type f ! -path './_astro/*' -print0 | LC_ALL=C sort -z |
     while IFS= read -r -d '' f; do
       printf '%s  %s\n' "$(sed -E 's#/_astro/[A-Za-z0-9_.@-]+#/_astro/X#g' "$f" | sha256sum | cut -d' ' -f1)" "$f"
     done > "$out"
   echo "$(wc -l < "$out") files fingerprinted → $out"
   ```
   Then run `scripts/site-fingerprint.sh dist /tmp/fp-before.txt`.
3. **Choose the pnpm version.** Run `npm view pnpm@11 version` and take the newest 11.x (11.27.1 when this was written). Don't use 12.x; see PLAN §3.
4. **Root `package.json`.** Add `"packageManager": "pnpm@<11.x.y>"` and `"engines": { "node": ">=22.12" }`.
5. **`pnpm-workspace.yaml`:**
   ```yaml
   packages:
     - "apps/*"
     - "packages/*"
     - "workers/*"   # dropped in 1.12 when workers/mcp moves to apps/mcp
   catalog:
     typescript: 5.9.3        # currently locked; TS 7 is out of scope (PLAN §3)
     tsx: ^4.22.0
     zod: ^4.6.5
     react: ^18.3.1           # pinned to the Expo SDK's React in 2.1
     react-dom: ^18.3.1
     "@types/react": ^18.3.12
     "@types/react-dom": ^18.3.1
   allowBuilds: {}            # filled in step 7: one entry per approved package, each with a reason comment
   ```
   In the root and `workers/mcp` `package.json` files, replace those entries with `"catalog:"`.
6. **Switch pnpm.** Run `corepack enable && corepack prepare pnpm@<11.x.y> --activate`, then `pnpm --version`. If corepack isn't available, use `npm i -g pnpm@<11.x.y>`.
7. **Install.** Run `git rm workers/mcp/pnpm-lock.yaml && pnpm install`.
   - pnpm 11 fails on any dependency build script that hasn't been approved.
   - For each package it names, check what the script does, then add an `allowBuilds` entry with a one-line reason. Likely candidates:
     - `esbuild` (tsx, Vite, wrangler)
     - `@biomejs/biome` (platform binary)
     - `workerd` (wrangler)
     - `sharp`, if Astro pulls it in
   - Deny anything you can't justify. Don't blanket-allow.
   - If `minimumReleaseAge` blocks a resolution, keep the existing lock resolution rather than lowering the setting.
8. **Check that the lock diff is structural only:**
   ```bash
   git diff origin/main -- pnpm-lock.yaml | grep -E '^[+-]  (astro|react|react-dom|typescript|tsx|@astrojs/react|zod|wrangler)@' || echo "no version changes"
   ```
   Any version change here is a defect. Pin it back.
9. **pnpm version in workflows.** In `digest.yml`, `add-city.yml` and `reprobe.yml`, delete `with: version: 9` under `pnpm/action-setup@v4`, so the action reads `packageManager`. If `@v4` can't install pnpm 11, use the action's newest major (check its README).
10. **Rewrite the `deploy.yml` build job.** Keep the triggers, permissions, concurrency, the `workflow_run` gate, the TZ comment and the `deploy` job as they are.
    ```yaml
    build:
      if: ${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}
      runs-on: ubuntu-latest
      env:
        TZ: Australia/Brisbane   # keep the existing comment explaining why
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4
        - uses: actions/setup-node@v4
          with: { node-version: "22", cache: "pnpm" }
        - run: pnpm install --frozen-lockfile
        - run: pnpm build
        - uses: actions/upload-pages-artifact@v3
          with: { path: dist }
    ```
    **Hidden files:** the site serves `/.well-known/api-catalog`. Use an `upload-pages-artifact` major that includes dotfiles (v3, which `withastro/action@v3` used), or set the include-hidden option explicitly. Read the action's README before choosing. The 1.13 runbook checks the live URL.
11. **`.github/workflows/ci.yml`:**
    ```yaml
    name: CI
    on:
      pull_request:
      workflow_dispatch:
    concurrency: { group: "ci-${{ github.ref }}", cancel-in-progress: true }
    jobs:
      check:
        runs-on: ubuntu-latest
        env: { TZ: Australia/Brisbane }
        steps:
          - uses: actions/checkout@v4
          - uses: pnpm/action-setup@v4
          - uses: actions/setup-node@v4
            with: { node-version: "22", cache: "pnpm" }
          - run: pnpm install --frozen-lockfile
          - run: pnpm check
          - run: pnpm build
          - name: MCP worker
            run: |
              pnpm --dir workers/mcp typecheck
              pnpm --dir workers/mcp test
              pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir "$RUNNER_TEMP/mcp"
    ```
12. **`CLAUDE.md`.** Under "Running locally", note that the repo pins pnpm 11 via `packageManager` (use corepack).

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | pnpm pinned | `pnpm --version` | 11.x |
| V2 | Clean frozen install | `rm -rf node_modules workers/mcp/node_modules && pnpm install --frozen-lockfile` | exit 0 |
| V3 | Checks | `pnpm check` | exit 0, same test counts as baseline |
| V4 | Site unchanged | `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-after.txt && diff /tmp/fp-before.txt /tmp/fp-after.txt` | no diff (same day) |
| V5 | Worker builds | the three `workers/mcp` commands from `ci.yml` | exit 0 |
| V6 | Workflow syntax | `actionlint .github/workflows/*.yml` (binary from rhysd/actionlint releases) | clean |
| V7 | add-city regex still matches `digest.yml` | `git worktree add /tmp/ac HEAD && (cd /tmp/ac && pnpm install --frozen-lockfile && CITY_NAME=Scratch CITY_KEY=scratch pnpm add-city; git -C /tmp/ac diff .github/workflows/digest.yml); git worktree remove --force /tmp/ac` | the diff adds `- scratch` to the dispatch options |
| V8 | Deploy build job | Actions → "Deploy to GitHub Pages" → Run workflow on `monorepo/refactor` | the **build** job is green. The deploy job is expected to be refused, because the `github-pages` environment only accepts `main`. |
| V9 | PR CI | `CI` on the draft PR | green |

Post-merge checks for this sub-phase are in the 1.13 runbook: live deploy, dotfiles served, and the digest running on pnpm 11.

## Rollback

Revert this sub-phase's commits on `monorepo/refactor`. Nothing outside the branch depends on them.
