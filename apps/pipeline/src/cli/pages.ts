import { publishPages } from "../publish/pages.js";

publishPages(console).catch((err) => {
	console.error(err);
	process.exit(1);
});
