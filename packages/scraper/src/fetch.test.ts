import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedReason, isPermanentFailure } from "./fetch.ts";

test("a refusal is distinguished from an empty listing", () => {
	// The measured shell: beachhotel.com.au (and ~14 other byron hosts) answer
	// every URL, /robots.txt included, with a spinner and a 5s reload. It is a
	// 200, so nothing flagged it and probe filed those hosts as "spa-empty" —
	// unscrapable — when in fact the same hosts serve their events over a plain
	// JSON API. Reporting a refusal as "no events" loses coverage silently.
	const shell = `<!DOCTYPE html><html><head><script>
	(function(){ setTimeout(function(){ window.location.reload(); }, 5000); }())
	</script></head><body><div id="outer-container"><div class="spinner"></div></div></body></html>`;
	assert.match(blockedReason(200, shell, 76) ?? "", /JS-reload shell/);

	// A 403 challenge page still has a body and still extracts to zero. It must
	// not read as a successful fetch of an empty listing.
	assert.equal(
		blockedReason(403, "<html>Attention Required!</html>", 900),
		"HTTP 403",
	);
	assert.match(
		blockedReason(
			200,
			"<html>Checking your browser before accessing</html>",
			40,
		) ?? "",
		/bot challenge/,
	);

	// Both halves are required, or real pages get flagged: a long page that
	// happens to contain a reload call is fine, and a thin page without one is
	// merely thin (the ladder's own emptiness handling covers that).
	assert.equal(
		blockedReason(200, "<script>location.reload()</script>", 5000),
		null,
	);
	assert.equal(
		blockedReason(200, "<html><body>Closed today</body></html>", 20),
		null,
	);

	// A 304 carries the cached body and is a normal, extractable response —
	// treating it as a failure previously wiped a source's output.
	assert.equal(blockedReason(304, "", 0), null);
});

test("a permanent failure is not retried", () => {
	// One brisbane probe hit 152 domains that do not resolve. Each was asked
	// three times, with the full backoff ladder between attempts, to be told
	// NXDOMAIN three times — about 18 minutes of a two-hour run spent waiting
	// to re-learn the same answer.
	assert.ok(
		isPermanentFailure(
			Object.assign(new Error("getaddrinfo ENOTFOUND x.com"), {
				code: "ENOTFOUND",
			}),
		),
	);
	assert.ok(isPermanentFailure(new Error("connect ECONNREFUSED 10.0.0.1:443")));
	assert.ok(isPermanentFailure(new Error("CERT_HAS_EXPIRED")));

	// Transient failures still get the retry ladder — that is what it is for.
	assert.ok(
		!isPermanentFailure(new Error("Timeout awaiting 'request' for 30000ms")),
	);
	assert.ok(!isPermanentFailure(new Error("socket hang up")));
	assert.ok(
		!isPermanentFailure(new Error("503 from https://x.com after 1 attempts")),
	);
});
