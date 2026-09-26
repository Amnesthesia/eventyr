import { publishRss } from "../stages/rss.js";

publishRss(console).catch((err) => {
	console.error(err);
	process.exit(1);
});
