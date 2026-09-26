import { loadPipelineConfig } from "../config/load.js";
import { publishAiFeed } from "../stages/ai.js";

publishAiFeed(console, loadPipelineConfig()).catch((err) => {
	console.error(err);
	process.exit(1);
});
