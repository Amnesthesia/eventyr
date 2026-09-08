import { useMemo, useState } from "react";
import { useEventsContext } from "../../context";

/**
 * Tags offered before "more" is pressed.
 *
 * Sized from the data rather than picked: Brisbane's week carries 522 distinct
 * tags, 267 of which appear exactly once. Rendering all of them is a wall of
 * chips nobody reads, and the useful ones are a short head — art, performance,
 * music, social each land on 60-100 events. The long tail stays reachable
 * through the search box, which already matches on tags.
 */
const VISIBLE_TAGS = 24;
/** How many the "more" button reveals. Still bounded — see above. */
const EXPANDED_TAGS = 96;

export default function TagFilter() {
	const { filtered, activeTags, toggleTag, clearTags } = useEventsContext();
	const [expanded, setExpanded] = useState(false);

	// Counted over the events currently on screen, not the whole city, so the
	// list narrows as other filters do and never offers a tag that would
	// return nothing.
	const counts = useMemo(() => {
		const map = new Map<string, number>();
		for (const event of filtered) {
			for (const tag of event.tags ?? []) {
				map.set(tag, (map.get(tag) ?? 0) + 1);
			}
		}
		return map;
	}, [filtered]);

	const ranked = useMemo(() => {
		const sorted = [...counts.entries()].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
		);
		const limit = expanded ? EXPANDED_TAGS : VISIBLE_TAGS;
		const head = sorted.slice(0, limit).map(([tag]) => tag);
		// A selected tag always stays visible. Filtering is AND-based, so
		// selecting one can drop the others out of `filtered` entirely — and a
		// chip that vanishes the moment you press it leaves no way to unpress it.
		for (const tag of activeTags) {
			if (!head.includes(tag)) head.push(tag);
		}
		return { tags: head, total: sorted.length };
	}, [counts, expanded, activeTags]);

	if (ranked.tags.length === 0) return null;

	return (
		<span className="filters filters--tag">
			{/* Mirrors "All Vibes": the resting state of the row, and the one
			    press that gets back to it. Active when nothing is selected, so
			    the row always shows a current state rather than none. */}
			<button
				type="button"
				className={`filter-btn${activeTags.length === 0 ? " active" : ""}`}
				onClick={clearTags}
				aria-pressed={activeTags.length === 0}
				title="Show events with any tag"
			>
				All Tags
			</button>
			{ranked.tags.map((tag) => {
				const on = activeTags.includes(tag);
				const count = counts.get(tag) ?? 0;
				return (
					<button
						type="button"
						key={tag}
						className={`filter-btn tag-filter-btn${on ? " active" : ""}`}
						onClick={() => toggleTag(tag)}
						aria-pressed={on}
						title={
							on
								? `Stop filtering by ${tag}`
								: `Show only events tagged ${tag} (${count})`
						}
					>
						{tag}
						{count > 0 && <span className="tag-filter-count">{count}</span>}
					</button>
				);
			})}
			{ranked.total > ranked.tags.length && !expanded && (
				<button
					type="button"
					className="filter-btn"
					onClick={() => setExpanded(true)}
					title="Show more tags — the rest are searchable"
				>
					+{ranked.total - ranked.tags.length} more
				</button>
			)}
		</span>
	);
}
