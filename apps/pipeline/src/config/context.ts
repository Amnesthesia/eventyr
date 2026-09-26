import type { CityConfig } from "@dothingslol/core/sources";
import { loadCityConfig } from "./city.js";
import { requireEnv } from "./env.js";
import { loadPipelineConfig, type PipelineConfig } from "./load.js";
import { getWeekRange } from "./week.js";

/** Where a stage's progress lines go. The CLIs pass `console`. */
export type Logger = Pick<Console, "log" | "error">;

/**
 * Everything a stage needs from the run, built once by its CLI (PLAN §2.6).
 * Stages never read `process.env` or `process.argv` themselves.
 */
export interface RunContext {
	/** City key: the `sources/{city}.yml` basename and the `data/{city}` dir. */
	city: string;
	cityConfig: CityConfig;
	week: { monday: Date; sunday: Date };
	config: PipelineConfig;
	/** Bypass the "already collected/curated this week" check. */
	force: boolean;
	log: Logger;
}

/** The run as `CITY` / `FORCE` describe it, with the week evaluated in the city's own zone. */
export function runContextFromEnv(log: Logger = console): RunContext {
	const city = requireEnv("CITY");
	const cityConfig = loadCityConfig(city);
	return {
		city,
		cityConfig,
		week: getWeekRange(new Date(), cityConfig.timezone),
		config: loadPipelineConfig(),
		force: ["1", "true", "yes"].includes(
			(process.env.FORCE ?? "").toLowerCase(),
		),
		log,
	};
}
