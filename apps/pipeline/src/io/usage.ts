// Usage persistence and the exit report: the pipeline's side of
// @dothingslol/llm's accounting. llm counts every call per stage
// (usageTotals); this writes those totals to data/{city}/usage/{week}.json
// and prints them when the process ends. The printed table and the file
// format are frozen (D19): the cost report must stay byte-identical across
// refactors, and the parity harness (scripts/llm-parity.mjs) checks that.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toISODate } from "@dothingslol/core/shared";
import { type StageUsage, usageTotals } from "@dothingslol/llm";
import { loadCityConfig } from "../config/city.js";
import { DATA_ROOT } from "../config/paths.js";
import { getWeekRange } from "../config/week.js";

function emptyUsage(): StageUsage {
	return {
		calls: 0,
		promptTokens: 0,
		outputTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		thoughtTokens: 0,
		grounded: 0,
		searchQueries: 0,
		failures: 0,
		retries: 0,
		estimatedUsd: 0,
	};
}

/** Where a run's usage is persisted: one file per city-week, merged across the
 * five scripts that make up a run, committed alongside the data. */
export function usagePath(city: string, weekStart: string): string {
	return join(DATA_ROOT, city, "usage", `${weekStart}.json`);
}

/**
 * Merges this process's per-stage usage into the week's file. Additive per
 * stage, because collect/curate/rank each run as their own process and each
 * would otherwise overwrite the others.
 */
export function persistUsage(
	path: string,
	snapshot: Record<string, StageUsage>,
): void {
	let existing: Record<string, StageUsage> = {};
	if (existsSync(path)) {
		try {
			existing =
				(
					JSON.parse(readFileSync(path, "utf-8")) as {
						stages?: typeof existing;
					}
				).stages ?? {};
		} catch {
			// unreadable — start over rather than fail the run over accounting
		}
	}
	for (const [stage, u] of Object.entries(snapshot)) {
		const merged = existing[stage] ?? emptyUsage();
		for (const k of Object.keys(u) as (keyof StageUsage)[]) merged[k] += u[k];
		existing[stage] = merged;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{ updated_at: new Date().toISOString(), stages: existing },
			null,
			2,
		),
		"utf-8",
	);
}

let reported = false;

/** Prints what the run actually spent, per stage, and merges it into the
 * week's usage file. The only way to know whether an optimisation worked.
 *
 * Idempotent: scripts call it explicitly before exiting AND it is wired to the
 * process exit hook, so without the guard the summary printed twice. */
export function reportGeminiUsage(city?: string): void {
	const usage = usageTotals();
	const rows = Object.entries(usage);
	if (reported || rows.length === 0) return;
	reported = true;
	rows.sort((a, b) => b[1].estimatedUsd - a[1].estimatedUsd);
	const totals = emptyUsage();
	console.log("\nModel usage");
	console.log(
		`  ${"stage".padEnd(24)} ${"calls".padStart(6)} ${"in".padStart(10)} ${"out".padStart(8)} ${"think".padStart(7)} ${"cached".padStart(8)} ${"cachew".padStart(8)} ${"search".padStart(7)} ${"~usd".padStart(7)}`,
	);
	const line = (stage: string, u: StageUsage): string =>
		`  ${stage.slice(0, 24).padEnd(24)} ${String(u.calls).padStart(6)} ${u.promptTokens.toLocaleString().padStart(10)} ${u.outputTokens.toLocaleString().padStart(8)} ${u.thoughtTokens.toLocaleString().padStart(7)} ${u.cachedTokens.toLocaleString().padStart(8)} ${u.cacheWriteTokens.toLocaleString().padStart(8)} ${String(u.searchQueries).padStart(7)} ${u.estimatedUsd.toFixed(3).padStart(7)}`;
	for (const [stage, u] of rows) {
		for (const k of Object.keys(totals) as (keyof StageUsage)[]) {
			totals[k] += u[k];
		}
		console.log(line(stage, u));
	}
	console.log(line("TOTAL", totals));
	if (totals.retries > 0 || totals.failures > 0) {
		console.log(
			`  (${totals.retries} rate-limit retries, ${totals.failures} calls failed outright)`,
		);
	}
	if (city) {
		try {
			const { timezone } = loadCityConfig(city);
			const monday = getWeekRange(new Date(), timezone).monday;
			const path = usagePath(city, toISODate(monday, timezone));
			persistUsage(path, usage);
			console.log(`  → ${path}`);
		} catch (err) {
			console.error(
				`  ⚠ could not write usage file: ${(err as Error).message}`,
			);
		}
	}
}

/** Prints the usage summary when the process ends, however it ends — including
 * an unhandled throw or a Ctrl-C, which is exactly when you most want to know
 * what it had already spent. */
export function installUsageReporting(city?: string): void {
	process.on("exit", () => reportGeminiUsage(city));
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			reportGeminiUsage(city);
			process.exit(130);
		});
	}
}
