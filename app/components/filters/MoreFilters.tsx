import { useMemo, useState } from "react";
import {
	LOW_SCORE_THRESHOLD,
	TOP_PICK_THRESHOLD,
} from "../../../src/shared.ts";
import { useEventsContext } from "../../context";
import { VIBE_KEYS, VIBE_LABEL_SET, VIBE_LABELS } from "../../utils/vibes";
import PastFilter from "./PastFilter";
import TimeOfDayFilter from "./TimeOfDayFilter";

/**
 * Score thresholds offered in the filter.
 *
 * Four named tiers, not the old row of bare digits: "6" next to "any score"
 * said nothing about what the number was or which direction it cut. Anchored
 * on the two values that already mean something elsewhere — LOW_SCORE_THRESHOLD
 * is where venue promotion stops (the ical/rss feeds cut there too) and
 * TOP_PICK_THRESHOLD is what the site surfaces as a top pick.
 *
 * ponytail: "Any" is LOW_SCORE_THRESHOLD rather than 0. Below 4 is happy hours
 * and schnitzel nights, which nobody opened this site to read, so no tier
 * reaches them; add a fifth if that ever needs to be visible.
 */
const SCORE_TIERS: { value: number; label: string; title: string }[] = [
	{
		value: LOW_SCORE_THRESHOLD,
		label: "Any",
		title: "Every event worth listing — hides venue promotion",
	},
	{ value: 6, label: "6+ Good", title: "Scored 6 or higher" },
	{
		value: TOP_PICK_THRESHOLD,
		label: `${TOP_PICK_THRESHOLD}+ Great`,
		title: `Scored ${TOP_PICK_THRESHOLD} or higher — top picks`,
	},
	{ value: 8, label: "8+ Best", title: "Scored 8 or higher" },
];

/**
 * Tags offered before the typeahead narrows them.
 *
 * Sized from the data rather than picked: Brisbane's week carries 522 distinct
 * tags, 267 of which appear exactly once. Rendering all of them is a wall of
 * chips nobody reads, and the useful ones are a short head. The long tail is
 * reachable by typing.
 */
const VISIBLE_TAGS = 18;
/** Ceiling while typing — a two-letter query still matches a lot. */
const SEARCH_TAGS = 60;

export default function MoreFilters() {
	const {
		cityData,
		filtered,
		activeTags,
		toggleTag,
		vibes,
		toggleVibe,
		minScore,
		setMinScore,
		hiddenCount,
		clearHidden,
	} = useEventsContext();
	const [tagQuery, setTagQuery] = useState("");

	// The pool is global and its order is stable, so a chip does not jump or
	// vanish as other filters narrow the list — that is what makes a zero-count
	// chip visible as "nothing here" instead of silently absent.
	const pool = useMemo(() => {
		const counts = new Map<string, number>();
		for (const event of cityData.events) {
			for (const tag of event.tags ?? []) {
				// A free tag spelled like a vibe is dropped: the vibe chip above
				// already owns that word, and two chips reading "social" with two
				// different meanings is the defect this removes.
				if (VIBE_LABEL_SET.has(tag.toLowerCase())) continue;
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([tag]) => tag);
	}, [cityData]);

	// Counted over what is on screen right now, never the corpus. A stale
	// global count on a chip that currently matches nothing is worse than no
	// count: it advertises results that do not exist.
	const live = useMemo(() => {
		const tags = new Map<string, number>();
		const vibeCounts = { intellectual: 0, creative: 0, hands_on: 0, social: 0 };
		for (const event of filtered) {
			for (const tag of event.tags ?? []) {
				tags.set(tag, (tags.get(tag) ?? 0) + 1);
			}
			for (const key of VIBE_KEYS) {
				if (event[key] === true) vibeCounts[key] += 1;
			}
		}
		return { tags, vibes: vibeCounts };
	}, [filtered]);

	const shown = useMemo(() => {
		const q = tagQuery.trim().toLowerCase();
		const head = q
			? pool.filter((t) => t.includes(q)).slice(0, SEARCH_TAGS)
			: pool.slice(0, VISIBLE_TAGS);
		// A selected tag always stays reachable. Filtering is AND-based, so
		// selecting one can push the others out of view — and a chip that
		// vanishes the moment you press it leaves no way to unpress it.
		for (const tag of activeTags) {
			if (!head.includes(tag)) head.push(tag);
		}
		return head;
	}, [pool, tagQuery, activeTags]);

	const vibeMatch = tagQuery.trim().toLowerCase();

	return (
		<div className="more-panel">
			<div className="frow">
				<span className="frow-label">Min score</span>
				<fieldset className="seg" aria-label="Minimum score">
					{SCORE_TIERS.map((tier) => (
						<button
							type="button"
							key={tier.value}
							className={`seg-btn${minScore === tier.value ? " seg-btn--on" : ""}`}
							title={tier.title}
							aria-pressed={minScore === tier.value}
							onClick={() => setMinScore(tier.value)}
						>
							{tier.label}
						</button>
					))}
				</fieldset>
			</div>

			<div className="frow">
				<span className="frow-label">Vibe + tag</span>
				<div className="frow-body">
					<input
						type="text"
						className="tag-typeahead"
						value={tagQuery}
						onChange={(e) => setTagQuery(e.target.value)}
						placeholder="filter vibes + tags…"
						aria-label="Filter the vibe and tag chips"
						autoComplete="off"
					/>
					<div className="chips chips--pool">
						{VIBE_KEYS.filter(
							(key) =>
								!vibeMatch ||
								VIBE_LABELS[key].toLowerCase().includes(vibeMatch),
						).map((key) => {
							const on = vibes.includes(key);
							const count = live.vibes[key];
							const dead = count === 0 && !on;
							return (
								<button
									type="button"
									key={key}
									data-vibe={key}
									className={`chip chip--vibe${on ? " chip--on" : ""}${dead ? " chip--zero" : ""}`}
									disabled={dead}
									aria-pressed={on}
									onClick={() => toggleVibe(key)}
								>
									{VIBE_LABELS[key]}
									<span className="chip-count">{count}</span>
								</button>
							);
						})}
						{shown.map((tag) => {
							const on = activeTags.includes(tag);
							const count = live.tags.get(tag) ?? 0;
							const dead = count === 0 && !on;
							return (
								<button
									type="button"
									key={tag}
									className={`chip${on ? " chip--on" : ""}${dead ? " chip--zero" : ""}`}
									disabled={dead}
									aria-pressed={on}
									onClick={() => toggleTag(tag)}
								>
									{tag}
									<span className="chip-count">{count}</span>
								</button>
							);
						})}
						{shown.length === 0 && (
							<span className="frow-empty">no tags match “{tagQuery}”</span>
						)}
					</div>
				</div>
			</div>

			<div className="frow">
				<span className="frow-label">Time</span>
				<div className="frow-body frow-body--inline">
					<TimeOfDayFilter />
					<PastFilter />
					{hiddenCount > 0 && (
						<button
							type="button"
							className="chip"
							onClick={clearHidden}
							title="Bring back every event you swiped away"
						>
							Unhide {hiddenCount} skipped
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
