import { publishRss } from "../publish/rss.js";

publishRss(console).catch((err) => {
	console.error(err);
	process.exit(1);
});
