// The pipeline's BatchStore for @dothingslol/llm: batch job ids persisted
// under data/_cache/llm-batches so a run killed while waiting on a job
// collects it instead of resubmitting. Created so the transport is testable
// end to end; no stage passes `batch` in PR 1 (D14 — 1.13 flips rank and
// annotate).

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BatchStore, StoredBatchJob } from "@dothingslol/llm";
import { DATA_ROOT } from "../config/paths.js";

export const BATCH_STORE_DIR = join(DATA_ROOT, "_cache", "llm-batches");

export function createBatchStore(dir = BATCH_STORE_DIR): BatchStore {
	const pathFor = (key: string): string => {
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error(`bad batch key ${key}`);
		return join(dir, `${key}.json`);
	};
	return {
		async get(key) {
			const path = pathFor(key);
			if (!existsSync(path)) return null;
			try {
				return JSON.parse(readFileSync(path, "utf-8")) as StoredBatchJob;
			} catch {
				return null;
			}
		},
		async set(key, job) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(pathFor(key), JSON.stringify(job, null, 2), "utf-8");
		},
		async delete(key) {
			const path = pathFor(key);
			if (existsSync(path)) unlinkSync(path);
		},
	};
}
