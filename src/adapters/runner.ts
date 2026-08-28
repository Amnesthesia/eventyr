import type {
	CandidateEvent,
	EventSourceAdapter,
	SourceRunResult,
} from "./types.ts";

/**
 * Runs one adapter's discover() + extract() and isolates its failures: a
 * source throwing (at either step, or on any one listing) never aborts the
 * run — it's captured as an error on that source's result instead.
 */
export async function runAdapter(
	adapter: EventSourceAdapter,
): Promise<{ result: SourceRunResult; candidates: CandidateEvent[] }> {
	const errors: string[] = [];
	const candidates: CandidateEvent[] = [];
	let listingsFetched = 0;

	try {
		const listings = await adapter.discover();
		listingsFetched = listings.length;
		for (const listing of listings) {
			if (listing.notModified) continue;
			try {
				candidates.push(...(await adapter.extract(listing)));
			} catch (err) {
				errors.push(`extract ${listing.url}: ${(err as Error).message}`);
			}
		}
	} catch (err) {
		errors.push(`discover: ${(err as Error).message}`);
	}

	return {
		result: {
			sourceId: adapter.id,
			ok: errors.length === 0,
			listingsFetched,
			candidatesExtracted: candidates.length,
			errors,
		},
		candidates,
	};
}

export async function runAdapters(
	adapters: EventSourceAdapter[],
): Promise<{ results: SourceRunResult[]; candidates: CandidateEvent[] }> {
	const outcomes = await Promise.all(adapters.map(runAdapter));
	return {
		results: outcomes.map((o) => o.result),
		candidates: outcomes.flatMap((o) => o.candidates),
	};
}
