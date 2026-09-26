// Public entry point for the pipeline as a set of stage functions (PLAN
// §2.6). `cli/*.ts` are thin wrappers around these: env/argv → RunContext →
// stage. Nothing outside this file, `config/`, `io/` and the CLIs should need
// to reach into `stages/`, `search/`, `publish/` or `sources/` directly.

export type { Logger, RunContext } from "./config/context.js";
export { runContextFromEnv } from "./config/context.js";
export type { PipelineConfig } from "./config/load.js";
export { loadPipelineConfig } from "./config/load.js";

// Publishing.
export { publishAiFeed } from "./publish/ai.js";
export { publishIcal } from "./publish/ical.js";
export { publishMarkdown } from "./publish/markdown.js";
export { publishPages } from "./publish/pages.js";
export { publishRss } from "./publish/rss.js";

// Source maintenance tools (sources/{city}.yml).
export { addCity } from "./sources/addCity.js";
export { discoverSources } from "./sources/discover.js";
export { probeSources } from "./sources/probe.js";
export { renderSources } from "./sources/render.js";
export { testUrl } from "./sources/testUrl.js";
export { triageSources } from "./sources/triage.js";

// Collection and curation.
export { collectScraped } from "./stages/collectScraped.js";
export { collectSearch } from "./stages/collectSearch.js";
export { curate } from "./stages/curate.js";
export { geocode } from "./stages/geocode.js";
export { rank } from "./stages/rank.js";
export { canonicaliseVenues } from "./stages/venues.js";
