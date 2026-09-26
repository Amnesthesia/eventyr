import { loadPipelineConfig } from "../config/load.js";
import { renderSources } from "../sources/render.js";

const arg = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

renderSources(console, loadPipelineConfig(), {
	limit: Number(arg("limit") ?? "10"),
	includeUnknown: process.argv.includes("--include-unknown"),
	apply: process.argv.includes("--apply"),
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
