# Sub-phase 1.12: Move the MCP Worker to `apps/mcp` and share its types

> **Handoff: paste this into a fresh Claude Code session**
>
> Execute sub-phase 1.12 (mcp move) of PR 1, the eventyr monorepo refactor.
> - Read `docs/monorepo/PLAN.md` and `docs/monorepo/phase-1.12-mcp-move.md`, and no other phase files.
> - Work on branch `monorepo/refactor`, even if your environment suggests another. If you can't push to it, stop and ask.
> - Sync first, as PLAN §4.3 says.
> - Follow the ordered steps, using `git mv` for every move.
> - Run every verification, post the results as a comment on the PR 1 draft, and tick 1.12.
> - If a check fails and the fix isn't obvious and in scope, stop and report.
> - Push. Don't merge, and don't start 1.13.

## Goal

- Move `workers/mcp` to `apps/mcp` and rename it to `@dothingslol/mcp`.
- Replace the verbatim copy of the AI-feed types (`workers/mcp/src/dothingsClient.ts:10-65`) with one declaration in core. Both the producer (`apps/pipeline/src/publish/ai.ts`) and the consumer (the Worker) use it.
- Deploy stays manual, via `wrangler deploy`, as it is today.

## Preconditions

- 1.11 is committed on the branch.

## Files affected

| Change | Where |
|---|---|
| Move | `git mv workers/mcp apps/mcp`, then remove the empty `workers/` directory |
| Workspace | `pnpm-workspace.yaml`: drop `workers/*` |
| Rename | `apps/mcp/package.json`: `name` becomes `@dothingslol/mcp` |
| New shared types | `packages/core/src/aiFeed.ts`: `CompactEvent`, `DayFile`, `WeekFile`, `CityIndexEntry`, `AiIndex` |
| Use the shared types | `apps/pipeline/src/publish/ai.ts` and `apps/mcp/src/dothingsClient.ts` import them |
| CI | `.github/workflows/ci.yml`: switch to `--filter @dothingslol/mcp` |
| Lint | `biome.json`: `workers/**` becomes `apps/mcp/src/**` |
| Docs | `CLAUDE.md` "AI feed & MCP server": `workers/mcp/` becomes `apps/mcp/` |

## Steps

1. **Baseline.** Run `pnpm --dir workers/mcp exec wrangler deploy --dry-run --outdir /tmp/mcp-before`.
2. **Move.** Commit `git mv workers/mcp apps/mcp` on its own. `wrangler.toml`'s `main = "src/index.ts"` is relative to the file, so confirm nothing else in it needs changing.
3. **Rename and update the workspace.** Then run `pnpm install` and confirm the lockfile importer is now `apps/mcp`.
4. **Share the types.**
   - Create `core/src/aiFeed.ts`, starting from the Worker's copy.
   - Diff it against `ai.ts`'s local types. Where they disagree, `ai.ts` is what's actually emitted, so the shared type follows `ai.ts`. Fix the Worker to typecheck against it.
   - In `ai.ts`, annotate what it writes with these types, using `satisfies` where that reads better.
   - The JSON output must not change.
5. **CI.** In `ci.yml`, change the three commands to `pnpm --filter @dothingslol/mcp typecheck`, `pnpm --filter @dothingslol/mcp test`, and `pnpm --filter @dothingslol/mcp exec wrangler deploy --dry-run --outdir "$RUNNER_TEMP/mcp"`.
6. **Docs.** Update the paths, and add the deploy command: `pnpm --filter @dothingslol/mcp deploy`.

## Verification

| # | Check | Command | Pass condition |
|---|---|---|---|
| V1 | Checks | `pnpm install --frozen-lockfile && pnpm check` | exit 0 |
| V2 | Equivalent bundle | Dry-run into `/tmp/mcp-after`, then compare file sizes and diff the bundles after normalising embedded paths | only paths differ |
| V3 | AI feed output unchanged | `pnpm build-ai && git status --porcelain apps/web/public/ai apps/web/public/llms.txt` | empty, or identical to the same command in `/tmp/main-wt` |
| V4 | No copied types | `grep -rn "interface CompactEvent\|type CompactEvent" apps packages` | only in `packages/core/src/aiFeed.ts` |
| V5 | Boundaries | `node scripts/check-boundaries.mjs` | exit 0 |
| V6 | PR CI | `CI` | green |

The optional live redeploy and smoke test are in the 1.13 runbook.

## Rollback

Revert this sub-phase's commits on the branch.
