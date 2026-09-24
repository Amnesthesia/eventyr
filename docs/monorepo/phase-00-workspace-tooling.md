# Phase 00 — Workspace tooling (no file moves)

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 00 (workspace tooling) of the eventyr monorepo refactor. Read
> `docs/monorepo/PLAN.md` and `docs/monorepo/phase-00-workspace-tooling.md`, and no other phase
> files. Create branch `monorepo/phase-00-workspace-tooling` from the latest `main`. Follow the
> ordered steps. Run every verification command and paste the results into the PR description.
> If a check fails and the fix is not obvious and within this phase's scope, stop and report
> rather than improvising. Open a PR. Do not merge it, and do not start phase 01.

## Goal

Put the tooling that every later phase depends on in place, while changing no source code or
layout:

- pnpm 11 pinned via `packageManager`
- a `pnpm-workspace.yaml` with catalogs and build-script approvals
- `workers/mcp` as a workspace member sharing the root lockfile
- a PR CI workflow
- a deploy workflow built from explicit steps instead of `withastro/action`
- a site-fingerprint script that later phases use to prove the built site is unchanged

## Preconditions

- The open questions in PLAN.md §8 are answered, or at least Q9 (PR-per-phase) is.
- `main` is green, and no `digest` run is in progress (Actions → "Events Digest (reusable)").
- You are outside the merge blackout: not Saturday 18:00–23:00 UTC.

## Files affected

- `package.json`: add `packageManager` and `engines`; change `typescript`/`tsx`/`react*`/`@types/react*` to `catalog:`.
- New `pnpm-workspace.yaml`.
- `pnpm-lock.yaml`: regenerated. Its importers become `.` and `workers/mcp`.
- `workers/mcp/package.json`: `typescript`/`tsx`/`zod` change to `catalog:`.
- `workers/mcp/pnpm-lock.yaml`: deleted.
- `.github/workflows/deploy.yml`: rewritten build job.
- `.github/workflows/{digest,add-city,reprobe}.yml`: drop the `version: 9` input from `pnpm/action-setup`.
- New `.github/workflows/ci.yml`.
- New `scripts/site-fingerprint.sh`.
- `CLAUDE.md`: one line under "Running locally" about pnpm 11.

## Steps

1. **Baseline on the current tooling.** Record the results in the PR.
   ```bash
   pnpm --version                      # expect 9.x
   pnpm install --frozen-lockfile && pnpm check
   TZ=Australia/Brisbane pnpm build
   ```
2. **Add `scripts/site-fingerprint.sh`** (executable) and commit it before anything else, so the baseline is produced by the committed script:
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
3. **Pick versions.** Run `npm view pnpm@11 version` and use the newest 11.x (11.27.1 when this plan was written). Don't use 12.x; see PLAN §3.
4. **Root `package.json`:** add `"packageManager": "pnpm@<11.x.y>"` and `"engines": { "node": ">=22.12" }`.
5. **Create `pnpm-workspace.yaml`:**
   ```yaml
   packages:
     - "apps/*"
     - "packages/*"
     - "workers/*"   # removed in phase 06, when workers/mcp moves to apps/mcp
   catalog:
     typescript: 5.9.3        # the version currently locked. TS 7 is out of scope (PLAN §3)
     tsx: ^4.22.0
     zod: ^4.6.5
     react: ^18.3.1           # moves to the Expo SDK's React in phase 09
     react-dom: ^18.3.1
     "@types/react": ^18.3.12
     "@types/react-dom": ^18.3.1
   allowBuilds: {}            # filled in step 7, one entry per approved package, each with a reason comment
   ```
   Replace those entries in the root and `workers/mcp` `package.json` files with `"catalog:"`.
6. **Switch pnpm:** `corepack enable && corepack prepare pnpm@<11.x.y> --activate`, then `pnpm --version`. If corepack isn't available, use `npm i -g pnpm@<11.x.y>`.
7. **Install.** Run `git rm workers/mcp/pnpm-lock.yaml` and then `pnpm install`.
   - pnpm 11 fails the install on any dependency build script it hasn't been told to allow (`strictDepBuilds`). For each package it names, look at what the script does and add an `allowBuilds` entry with a one-line reason.
     - Expect `esbuild` (tsx, Vite, wrangler), `@biomejs/biome` (platform binary), `sharp` if Astro pulls it in, and `workerd` (wrangler).
     - Deny anything whose script you can't justify. Don't blanket-allow.
   - If `minimumReleaseAge` blocks a resolution, don't lower it globally. Leave the existing lock resolution in place, which is the default when you run without `--frozen-lockfile`.
8. **Check the lock diff is structural only:**
   ```bash
   git diff main -- pnpm-lock.yaml | grep -E '^[+-]  (astro|react|react-dom|typescript|tsx|@astrojs/react|zod|wrangler)@' || echo "no version changes"
   ```
   Any version change there is a defect. Pin it back with the catalog, or with an exact range.
9. **Workflows: pnpm version.**
   - In `digest.yml`, `add-city.yml` and `reprobe.yml`, delete the `with: version: 9` block under `pnpm/action-setup@v4`. The action then reads `packageManager`.
   - If `pnpm/action-setup@v4` can't install pnpm 11, use its newest major. Check the action's README and releases.
10. **Rewrite the `deploy.yml` build job** with explicit steps. Keep the trigger block, permissions, concurrency, the `workflow_run` gate, the TZ comment and the `deploy` job unchanged.
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
    **Watch for hidden files.** The site serves `/.well-known/api-catalog`. Use the `upload-pages-artifact` major that includes dotfiles (v3, which `withastro/action@v3` used). **Don't** move to a major that drops hidden files by default unless you set its include-hidden option. Read the action's README before choosing. Verification step V6 catches a mistake.
11. **Add `.github/workflows/ci.yml`:**
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
12. **Docs.** In `CLAUDE.md` "Running locally", add that the repo pins pnpm 11 via `packageManager` (use corepack). Leave everything else in the docs alone.

## Verification

| # | Check | Command / how | Pass condition |
|---|---|---|---|
| V1 | pnpm pinned | `pnpm --version` | 11.x |
| V2 | Clean frozen install | `rm -rf node_modules workers/mcp/node_modules && pnpm install --frozen-lockfile` | exit 0, no build-script prompts |
| V3 | Repo checks | `pnpm check` | exit 0, same test counts as the baseline |
| V4 | Site unchanged | `TZ=Australia/Brisbane pnpm build && scripts/site-fingerprint.sh dist /tmp/fp-after.txt && diff /tmp/fp-before.txt /tmp/fp-after.txt` | no diff (same day as the baseline) |
| V5 | Worker still builds | the three `workers/mcp` commands from `ci.yml` | exit 0 |
| V6 | Workflow syntax | `actionlint .github/workflows/*.yml` (download the binary from rhysd/actionlint releases) | no errors |
| V7 | add-city regex still matches `digest.yml` | `git worktree add /tmp/ac HEAD && (cd /tmp/ac && pnpm install --frozen-lockfile && CITY_NAME=Scratch CITY_KEY=scratch pnpm add-city; git -C /tmp/ac diff --stat .github/workflows/digest.yml); git worktree remove --force /tmp/ac` | `digest.yml` shows `+ - scratch` in the dispatch options |
| V8 | PR CI | the `CI` workflow on the PR | green |

**After merge.** Whoever merges does this, and records it in the PR:

- **Deploy.** The `Deploy to GitHub Pages` run for the merge commit is green. Then:
  ```bash
  curl -sfI https://www.dothings.lol/brisbane/ | head -1              # 200
  curl -sfI https://www.dothings.lol/.well-known/api-catalog | head -1 # 200, proves dotfiles survived
  curl -sf  https://www.dothings.lol/ai/index.json | head -c 300
  curl -sfI https://www.dothings.lol/brisbane/ | grep -i last-modified  # after the merge time
  ```
- **Cron path.**
  - Dispatch `digest.yml` with city `brisbane`, force `false`, and default providers. It should finish green with an install on pnpm 11. The commit step either no-ops or pushes `chore: update brisbane events …`.
  - `force=false` hits the "already collected this week" checks. Look at the step logs for provider calls and note any spend (PLAN §1.8).
  - `reprobe.yml` and `add-city.yml` aren't dispatched, because both spend and commit. V6 and V7 cover their syntax.

## Rollback

Revert the squash-merge commit. That restores `withastro/action`, pnpm 9 and the separate mcp
lockfile together. No generated data depends on this phase, so a revert is safe at any time.
