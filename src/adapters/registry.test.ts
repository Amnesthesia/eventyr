import assert from "node:assert/strict";
import { test } from "node:test";
import {
	enabledSources,
	findSourceById,
	loadSourceRegistry,
} from "./registry.ts";
import { EXTRACTION_STRATEGIES } from "./types.ts";

test("loads the Brisbane adapter registry with well-formed entries", () => {
	const sources = loadSourceRegistry("brisbane");
	assert.ok(sources.length > 0);
	for (const s of sources) {
		assert.equal(typeof s.id, "string");
		assert.ok(s.id.length > 0);
		assert.ok(Array.isArray(s.domains));
		assert.ok(Array.isArray(s.listingUrls));
		assert.ok(
			EXTRACTION_STRATEGIES.includes(s.strategy),
			`unknown strategy on ${s.id}`,
		);
		assert.equal(typeof s.enabled, "boolean");
	}
});

test("source ids are unique", () => {
	const sources = loadSourceRegistry("brisbane");
	const ids = sources.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("every entry is enabled:false pending live verification, and carries a note explaining why", () => {
	// This is a property of *this session's* registry (no adapters written
	// yet, no network access to verify anything) — not a permanent
	// invariant. Once Phase 3 verifies a source and writes its adapter, that
	// source flips to enabled: true and this test should be narrowed to
	// exclude it rather than deleted outright.
	const sources = loadSourceRegistry("brisbane");
	for (const s of sources) {
		assert.equal(
			s.enabled,
			false,
			`${s.id} should not be enabled without a written+tested adapter`,
		);
		assert.ok(
			s.note && s.note.length > 0,
			`${s.id} is missing a note explaining its unverified state`,
		);
	}
});

test("findSourceById / enabledSources helpers", () => {
	const sources = loadSourceRegistry("brisbane");
	assert.equal(
		findSourceById(sources, "qagoma")?.name.includes("QAGOMA"),
		true,
	);
	assert.equal(findSourceById(sources, "does-not-exist"), undefined);
	assert.deepEqual(enabledSources(sources), []);
});
