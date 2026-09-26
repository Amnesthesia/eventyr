import { publishMarkdown } from "../publish/markdown.js";

publishMarkdown(console).catch((err) => {
	console.error(err);
	process.exit(1);
});
