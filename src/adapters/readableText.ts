// Reduces a fetched HTML page to plain, LLM-friendly text before it's ever
// sent to the extraction model: strips script/style/nav/header/footer
// boilerplate, and — importantly — keeps every <a href> as inline "label
// (resolved URL)" text rather than throwing links away, since the
// extraction prompt is asked to copy ticket/event URLs verbatim and can
// only do that if they're still visible in the text it's given.

const BOILERPLATE_TAGS =
	/<(script|style|noscript|svg|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LINK_TAG = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const HTML_ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&lt;": "<",
	"&gt;": ">",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(nbsp|amp|quot|#39|apos|lt|gt);/g,
		(m) => HTML_ENTITIES[m] ?? m,
	);
}

export function stripToReadableText(html: string, baseUrl: string): string {
	let text = html.replace(BOILERPLATE_TAGS, " ");

	text = text.replace(LINK_TAG, (_match, href: string, inner: string) => {
		let resolved = href;
		try {
			resolved = new URL(href, baseUrl).toString();
		} catch {
			// leave href as-is if it's not a resolvable URL (e.g. "javascript:void(0)")
		}
		const label = decodeEntities(inner.replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		return label ? ` ${label} (${resolved}) ` : ` ${resolved} `;
	});

	text = text.replace(/<[^>]+>/g, " ");
	text = decodeEntities(text);
	text = text
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
	return text;
}
