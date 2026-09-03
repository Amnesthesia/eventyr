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
			// A 304 is NOT a reason to skip: fetch.ts returns the cached body's
			// path with it, and pageAdapter reads that. Skipping here meant a
			// listing page that legitimately had not changed produced zero
			// events and the source was reported barren — Big Fork Theatre's
			// ticket page extracts 36 events from the very body being skipped.
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
