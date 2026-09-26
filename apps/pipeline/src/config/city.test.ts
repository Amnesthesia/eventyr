import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidTimeZone } from "./city.js";

test("isValidTimeZone: IANA zones pass; offsets, abbreviations and junk do not", () => {
	assert.equal(isValidTimeZone("Australia/Sydney"), true);
	assert.equal(isValidTimeZone("Australia/Brisbane"), true);
	// A fixed offset is the no-DST assumption this check exists to keep out.
	assert.equal(isValidTimeZone("+10:00"), false);
	assert.equal(isValidTimeZone("AEST"), false);
	assert.equal(isValidTimeZone(""), false);
	assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
});
