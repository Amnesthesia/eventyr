// @dothingslol/scraper/parsers — the pure parsers (PLAN §2.5): bytes in,
// RawCandidateFields out, no network and no clock beyond what is passed in.

export {
	countDateHits,
	DST_GAP,
	type ParsedDateRange,
	parseDateRange,
	parseSingleDateTime as parseDateTime,
	parseSingleDateTime,
} from "./dates.ts";
export {
	extractEmbeddedJson,
	extractFromEmbeddedJson,
	findEventObjects,
	isEventLike,
	parseEmbeddedJson,
} from "./embeddedJson.ts";
export {
	type FeedFormat,
	type FeedResult,
	feedUrlsFromHtml,
	parseFeed,
	parseIcal,
	parseTrumbaAtom,
	parseTrumbaJson,
	wpJsonRoutesToFeedUrls,
} from "./feeds.ts";
export {
	extractJsonLdBlocks,
	findEventNodes,
	jsonLdNodeToRawFields,
	parseJsonLd,
} from "./jsonLd.ts";
export {
	BOILERPLATE_TAGS,
	densestWindow,
	htmlToText,
	stripToReadableText,
} from "./text.ts";
