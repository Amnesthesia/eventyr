# Phase 06: move the MCP Worker to `apps/mcp` and share its types

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute phase 06 (mcp move) of the eventyr monorepo refactor. Read `docs/monorepo/PLAN.md`
> and `docs/monorepo/phase-06-mcp-move.md`, and no other phase files. Create branch
> `monorepo/phase-06-mcp-move` from the latest `main`. Follow the steps in order, use `git mv`
> for every move, run every verification command and paste the results into the PR
> description. If a check fails and the fix is not obvious and within this phase's scope, stop
> and report. Open a PR, but do not merge it and do not start the next phase.

## Goal

1. Move `workers/mcp` to `apps/mcp` and rename it `@dothingslol/mcp`.
2. Replace the verbatim copy of the AI-feed types in `workers/mcp/src/dothingsClient.ts:10-65` with one declaration in core. Both the producer (`apps/pipeline/src/ai.ts`) and the consumer (the Worker) will use it.
3. Keep the Worker's checks in CI.

Deployment stays manual (`wrangler deploy`), as it is today.

## Preconditions

- Phase 05 is merged.
- You have Cloudflare credentials for the optional real deploy at the end. Without them, stop after the dry run.

## Files affected

- `git mv workers/mcp apps/mcp`, then remove `workers/` once it is empty.
- `pnpm-workspace.yaml`: drop the `workers/*` entry.
- `apps/mcp/package.json`: change `name` to `@dothingslol/mcp`.
- New `packages/core/src/aiFeed.ts`, holding `CompactEvent`, `DayFile`, `WeekFile`, `CityIndexEntry` and `AiIndex`. These come from `apps/pipeline/src/ai.ts:77-100` and `apps/mcp/src/dothingsClient.ts:10-65`.
- `apps/pipeline/src/ai.ts` and `apps/mcp/src/dothingsClient.ts` import from it.
- `.github/workflows/ci.yml`: the worker commands move to `--filter @dothingslol/mcp`.
- `biome.json` includes: `workers/**` becomes `apps/mcp/src/**`.
- `CLAUDE.md` "AI feed & MCP server": change `workers/mcp/` to `apps/mcp/`.

## Steps

1. **Baseline.** Run `pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp-before`.
2. **Move.** Run `git mv workers/mcp apps/mcp` as its own commit. `wrangler.toml` uses paths relative to its own directory (`main = "src/index.ts"`), so it needs no change. Confirm that before moving on.
3. **Rename and register the workspace.** Set the name in `package.json` and drop `workers/*` from the workspace. Then run `pnpm install` and check that the lockfile importer key becomes `apps/mcp`.
4. **Share the types.**
   - Create `core/src/aiFeed.ts` from the Worker's copy, since that is the consumer's contract.
   - Diff it against `ai.ts`'s local types. Where they disagree, `ai.ts` is what actually gets emitted: make the shared type match `ai.ts` and fix whatever the Worker then fails to typecheck on.
   - In `ai.ts`, annotate the objects it writes with these types, using `satisfies` where that reads better. The JSON output must not change (V3 checks this).
5. **CI.** In `ci.yml`, replace the `--dir workers/mcp` commands with `pnpm --filter @dothingslol/mcp typecheck`, `... test`, and `... exec wrangler deploy --dry-run --outdir "$RUNNER_TEMP/mcp"`. The root `check` script's `pnpm -r typecheck` and `pnpm -r test` already cover this package.
6. **Docs.** Update the `CLAUDE.md` paths, and add a one-line deploy instruction: `pnpm --filter @dothingslol/mcp deploy`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | The bundle is equivalent | `pnpm --filter @dothingslol/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp-after`, then `diff <(ls -la /tmp/mcp-before) <(ls -la /tmp/mcp-after)`, and diff the bundles themselves after normalising embedded paths | Only paths differ, and sizes are within a few bytes |
| V3 | AI feed output unchanged | `TZ=Australia/Brisbane pnpm build-ai && git status --porcelain apps/web/public/ai apps/web/public/llms.txt` | empty, or identical to running the same command on `main` |
| V4 | No copied types | `grep -n "interface CompactEvent\|type CompactEvent" -r apps packages` | only `packages/core/src/aiFeed.ts` |
| V5 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V6 | PR CI | `CI` | green |

**After merge (optional, needs Cloudflare credentials):** run `pnpm --filter @dothingslol/mcp deploy`, then smoke-test:
```bash
curl -s https://mcp.dothings.lol/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```
The response must list `list_cities` and `get_events`. If you skip the deploy, the live Worker keeps running the previous build, which is fine because behaviour is unchanged.

## Rollback

Revert the squash merge. If the Worker was redeployed from this commit and misbehaves, check out
the previous commit and run `wrangler deploy` from `workers/mcp`. `wrangler rollback` also
works, since Cloudflare keeps prior versions.
