// How specific a tag is, so disliking one event does not punish every event
// that happens to share its broadest tag. "shoegaze" on 3 of 700 events is a
// near-unique fingerprint; "music" on 200 of them says almost nothing about
// which of those 200 you meant. Computed client-side from the city's own
// events — no model call, no pipeline field, recomputed fresh every load.
import type { EventData } from "@dothingslol/core/schema";

/** Floor for the commonest tag, not zero: a tag that appears on nearly every
 * event should still accumulate weight after enough dislikes, just slowly. A
 * zero weight would make it permanently unlearnable. */
const MIN_WEIGHT = 0.1;

/** log(N/df) normalised by log(N), clamped to [MIN_WEIGHT, 1]. A tag on one
 * event scores 1; a tag on every event scores 0 before the floor. */
export function tagWeights(events: EventData[]): Record<string, number> {
	const n = events.length;
	const weights: Record<string, number> = {};
	if (n <= 1) return weights;
	const df = new Map<string, number>();
	for (const event of events) {
		for (const tag of event.tags ?? []) {
			df.set(tag, (df.get(tag) ?? 0) + 1);
		}
	}
	const logN = Math.log(n);
	for (const [tag, count] of df) {
		const raw = Math.log(n / count) / logN;
		weights[tag] = Math.min(1, Math.max(MIN_WEIGHT, raw));
	}
	return weights;
}

/** A tag this profile has never seen (aged out of the data, or a typo in
 * localStorage) is treated as fully specific rather than ignored. */
export function tagWeight(
	tag: string,
	weights: Record<string, number>,
): number {
	return weights[tag] ?? 1;
}
