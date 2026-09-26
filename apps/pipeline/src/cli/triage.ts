import { triageSources } from "../sources/triage.js";

const cityArg = process.argv.slice(2).find((a) => a.startsWith("--city="));

triageSources(console, {
	city: cityArg?.split("=")[1],
	renderCandidates: process.argv.includes("--render-candidates"),
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
