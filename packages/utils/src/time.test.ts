import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffDelay } from "./time.ts";

test("backoffDelay doubles per attempt and jitters by at most 30%", () => {
	for (const attempt of [0, 1, 3]) {
		const base = 1000 * 2 ** attempt;
		const d = backoffDelay(attempt, 1000);
		assert.ok(d >= base && d < base * 1.3, `attempt ${attempt}: ${d}`);
	}
});
