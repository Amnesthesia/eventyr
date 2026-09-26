import { publishMarkdown } from "../stages/markdown.js";

publishMarkdown(console).catch((err) => {
	console.error(err);
	process.exit(1);
});
