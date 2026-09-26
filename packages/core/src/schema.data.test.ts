// Every committed data/*.json must parse against the schemas, so the types
// describe what the pipeline actually writes. When this fails, fix the schema,
// never the data: the data is the ground truth the schema is describing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { CityIndexSchema, CityPayloadSchema } from "./schema.ts";

const DATA_DIR = fileURLToPath(new URL("../../../data/", import.meta.url));
const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));

test("data/ has an index and at least one city payload to check", () => {
	assert.ok(files.includes("index.json"));
	assert.ok(files.some((f) => f !== "index.json"));
});

for (const file of files) {
	test(`data/${file} matches its schema`, () => {
		const schema: z.ZodType =
			file === "index.json" ? CityIndexSchema : CityPayloadSchema;
		const json = JSON.parse(readFileSync(DATA_DIR + file, "utf-8"));
		const result = schema.safeParse(json);
		if (result.success) return;
		// One line per mismatch, with the JSON path and the event's title, so a
		// failure names exactly what to look at.
		const lines = result.error.issues.slice(0, 20).map((issue) => {
			const path = issue.path.join(".");
			const [top, index] = issue.path;
			const title =
				top === "events" && typeof index === "number"
					? ` (${JSON.stringify(json.events[index]?.title)})`
					: "";
			return `  data/${file}: ${path}${title}: ${issue.message}`;
		});
		const more = result.error.issues.length - lines.length;
		if (more > 0) lines.push(`  …and ${more} more`);
		assert.fail(`schema mismatch:\n${lines.join("\n")}`);
	});
}
