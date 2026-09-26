// Content-addressed response cache behind `ask({ cache })`. The key
// derivation is adapters/extractionCache.ts's (sha1 of prompt version + input
// text), so entries that file wrote stay readable: they hold the parsed
// `fields` rather than the raw answer, and are served back as their JSON.

import { createHash } from "node:crypto";
import type { CacheStore } from "./types.ts";

export interface CacheEntry {
	promptVersion: string;
	text: string;
	textLength: number;
	cachedAt: string;
}

export function cacheKey(version: string, input: string): string {
	return createHash("sha1").update(`${version}\n${input}`).digest("hex");
}

/** The cached answer text, or null on a miss, a version mismatch or an
 * unreadable entry (all of which mean "ask"). */
export async function readCached(
	store: CacheStore,
	key: string,
	version: string,
): Promise<string | null> {
	let raw: unknown;
	try {
		raw = await store.get(key);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Partial<CacheEntry> & { fields?: unknown };
	if (entry.promptVersion !== version) return null;
	if (typeof entry.text === "string") return entry.text;
	// Legacy extractionCache entry: parsed fields, no raw text.
	if (Array.isArray(entry.fields)) return JSON.stringify(entry.fields);
	return null;
}

export async function writeCached(
	store: CacheStore,
	key: string,
	version: string,
	input: string,
	text: string,
): Promise<void> {
	const entry: CacheEntry = {
		promptVersion: version,
		text,
		textLength: input.length,
		cachedAt: new Date().toISOString(),
	};
	try {
		await store.set(key, entry);
	} catch (err) {
		console.error(`  ⚠ [llm cache] could not write: ${(err as Error).message}`);
	}
}
