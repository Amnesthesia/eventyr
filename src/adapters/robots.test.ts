import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRobotsPolicy } from "./robots.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

function serving(body: string, status = 200): typeof fetch {
	return (async () =>
		new Response(body, { status })) as unknown as typeof fetch;
}

test("a plain Disallow prefix is honoured, siblings are not", async () => {
	const policy = await fetchRobotsPolicy(
		"https://example.com",
		UA,
		serving("User-agent: *\nDisallow: /private\n"),
	);
	assert.equal(policy.isAllowed("/private/thing"), false);
	assert.equal(policy.isAllowed("/events"), true);
});

test("wildcard and end-anchor patterns work", async () => {
	// The hand-rolled parser this replaced did prefix matching only, so
	// "Disallow: /*/events" read as allowing everything — the exact rule a
	// venue would publish to keep crawlers off its listings.
	const policy = await fetchRobotsPolicy(
		"https://example.com",
		UA,
		serving("User-agent: *\nDisallow: /*/events\nDisallow: /tmp$\n"),
	);
	assert.equal(policy.isAllowed("/venue/events"), false);
	assert.equal(policy.isAllowed("/a/b/events"), false);
	assert.equal(policy.isAllowed("/tmp"), false);
	// $ anchors the match, so a longer path is unaffected.
	assert.equal(policy.isAllowed("/tmpfile"), true);
});

test("a more specific Allow beats a broader Disallow", async () => {
	const policy = await fetchRobotsPolicy(
		"https://example.com",
		UA,
		serving("User-agent: *\nDisallow: /\nAllow: /whats-on\n"),
	);
	assert.equal(policy.isAllowed("/whats-on"), true);
	assert.equal(policy.isAllowed("/admin"), false);
});

test("unreachable or missing robots.txt allows everything", async () => {
	for (const impl of [
		serving("", 404),
		(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch,
	]) {
		const policy = await fetchRobotsPolicy("https://example.com", UA, impl);
		assert.equal(policy.isAllowed("/anything"), true);
	}
});

test("our browser user-agent is judged by the * group, not a bot group", async () => {
	// fetch.ts sends a real browser UA, so no site-specific bot group can
	// match it — landing on "*" is both correct and the conservative choice.
	const policy = await fetchRobotsPolicy(
		"https://example.com",
		UA,
		serving(
			"User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n",
		),
	);
	assert.equal(policy.isAllowed("/events"), true);
	assert.equal(policy.isAllowed("/admin"), false);
});
