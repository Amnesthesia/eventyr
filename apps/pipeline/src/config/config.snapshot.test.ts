import assert from "node:assert";
import { test } from "node:test";
import { loadPipelineConfig } from "./load.js";

test("config snapshot", () => {
	const cfg = loadPipelineConfig();
	assert.ok(cfg);
});
