import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, cleanUrl } from "./text.ts";

test("numeric character references are decoded", () => {
	// The exact titles that reached the site. WordPress emits &#038; and
	// &#8211; rather than &amp; and &ndash;, which the old seven-entity table
	// passed through untouched.
	assert.equal(
		cleanText("Dice Rolls &#038; Flagons &#8211; Casual Board Game Meetup"),
		"Dice Rolls & Flagons – Casual Board Game Meetup",
	);
	assert.equal(
		cleanText("Eat Street&#8217;s Brazilian Dancers"),
		"Eat Street’s Brazilian Dancers",
	);
	assert.equal(
		cleanText("GEED UP &#8220;The Worst Show Ever&#8221;"),
		"GEED UP “The Worst Show Ever”",
	);
});

test("hex and semicolon-less references are decoded too", () => {
	assert.equal(cleanText("Tea &#x26; Tour"), "Tea & Tour");
	assert.equal(cleanText("Tea &amp Tour"), "Tea & Tour");
});

test("HTML a source escaped into a text field is removed, not displayed", () => {
	// Netherworld's JSON-LD description arrives as escaped markup, so one
	// decode pass produces real tags that must not reach the card.
	assert.equal(
		cleanText("&lt;p&gt;Join us for Dice Rolls &amp; Flagons.&lt;/p&gt;"),
		"Join us for Dice Rolls & Flagons.",
	);
	assert.equal(cleanText("a&lt;br /&gt;b"), "a b");
});

test("double-encoded text is decoded all the way", () => {
	assert.equal(cleanText("Tea &amp;#038; Tour"), "Tea & Tour");
});

test("whitespace, including decoded nbsp, is collapsed", () => {
	assert.equal(cleanText("  Tea&nbsp;&nbsp;&amp;   Tour \n"), "Tea & Tour");
});

test("non-strings and empties come back as empty strings", () => {
	for (const v of [null, undefined, 42, {}]) assert.equal(cleanText(v), "");
	assert.equal(cleanText(""), "");
});

test("cleanUrl decodes but does not strip or collapse", () => {
	assert.equal(
		cleanUrl("https://example.com/e?a=1&amp;b=2"),
		"https://example.com/e?a=1&b=2",
	);
});

test("cleanUrl refuses anything that is not http(s)", () => {
	// Decoding must not become a way to smuggle a scheme past the guard the
	// rest of the pipeline applies — these end up in an href.
	for (const bad of [
		"javascript:alert(1)",
		"&#106;avascript:alert(1)",
		"data:text/html,<script>",
		"/relative/path",
		"",
	]) {
		assert.equal(cleanUrl(bad), "", bad);
	}
});

test("JSON escapes that leaked out of an embedded string are undone", () => {
	// A description arriving as "Netherworld\'s", or with a literal
	// two-character "\n", is wrong data rather than a presentation choice, so
	// curate fixes it.
	assert.equal(cleanText("Netherworld\\'s bar"), "Netherworld's bar");
	assert.equal(cleanText("Line one\\nLine two"), "Line one Line two");
});

test("a URL in a description survives curation", () => {
	// It is often the only ticket link there is, so the data keeps it and only
	// the rendered text drops it (stripForDisplay).
	const withUrl = "Book your place (https://events.humanitix.com/abc) .";
	assert.equal(cleanText(withUrl), withUrl);
});
