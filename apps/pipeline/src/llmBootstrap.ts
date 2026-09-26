// The one configureLLM call. Imported first by every CLI that makes model
// calls, so the shared client knows its stores and whether this run is a
// replay (scripts/llm-parity.mjs) before any stage asks anything.
//
//   EVENTYR_LLM_REPLAY=record|replay, EVENTYR_LLM_REPLAY_DIR=<dir>,
//   EVENTYR_LLM_REPLAY_LATENCY_MS (default 200)

import { configureLLM } from "@dothingslol/llm";
import { createBatchStore } from "./io/batchStore.ts";
import { createFileCache } from "./io/fileCache.ts";

const mode = process.env.EVENTYR_LLM_REPLAY as "record" | "replay" | undefined;
if (mode && mode !== "record" && mode !== "replay") {
	throw new Error(`EVENTYR_LLM_REPLAY must be record or replay, not ${mode}`);
}
if (mode && !process.env.EVENTYR_LLM_REPLAY_DIR) {
	throw new Error("EVENTYR_LLM_REPLAY needs EVENTYR_LLM_REPLAY_DIR");
}

configureLLM({
	cacheStore: createFileCache(),
	batchStore: createBatchStore(),
	replay: mode
		? {
				dir: process.env.EVENTYR_LLM_REPLAY_DIR as string,
				mode,
				latencyMs: Number(process.env.EVENTYR_LLM_REPLAY_LATENCY_MS ?? 200),
			}
		: undefined,
});
