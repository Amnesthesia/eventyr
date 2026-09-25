/** Splits `items` into consecutive arrays of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		chunks.push(items.slice(i, i + size));
	return chunks;
}

/** Old name; the call sites are renamed in 1.11. */
export const chunkArray = chunk;

/**
 * Runs `worker` over every item with at most `limit` in flight, preserving
 * input order in the result.
 *
 * Every LLM-backed pass in this pipeline wants the same shape: batch the work,
 * run the batches together rather than one at a time, but don't fan out
 * without a ceiling. A bare `Promise.all` over batches did the first two and
 * not the third — dedupe's pair classifier could open ~67 simultaneous Gemini
 * calls, which is how you collect 429s and pay for the retries. Serial loops
 * are the opposite failure: the probe's URL discovery took 28 minutes for work
 * that is entirely independent.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await worker(items[i], i);
			}
		},
	);
	await Promise.all(runners);
	return results;
}
