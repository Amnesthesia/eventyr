import { SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useEventsContext } from "../context";
import { useModalDialog } from "../hooks/useModalDialog";

/**
 * Tags offered to rate. The same short head the tag filter uses, and for the
 * same reason: Brisbane's week carries 522 distinct tags, 267 of them on a
 * single event. Rating a tag that appears once is effort spent on nothing.
 */
const RATEABLE_TAGS = 40;

export default function PreferencesPane() {
	const { filtered, tagPrefs } = useEventsContext();
	const [open, setOpen] = useState(false);

	// Ranked by how many events actually carry the tag, so the first choices
	// offered are the ones that will change the most.
	const tags = useMemo(() => {
		const counts = new Map<string, number>();
		for (const event of filtered) {
			for (const tag of event.tags ?? []) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		const ranked = [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, RATEABLE_TAGS)
			.map(([tag]) => tag);
		// A rated tag stays listed even when nothing this week carries it —
		// otherwise the only way to change your mind is to wait for an event
		// with that tag to come back.
		for (const tag of Object.keys(tagPrefs)) {
			if (!ranked.includes(tag)) ranked.push(tag);
		}
		return ranked;
	}, [filtered, tagPrefs]);

	const rated = Object.keys(tagPrefs).length;

	return (
		<>
			<button
				type="button"
				className={`filter-btn${rated > 0 ? " active" : ""}`}
				onClick={() => setOpen(true)}
				title="Choose the kinds of event you want more or less of"
			>
				<SlidersHorizontal size={12} strokeWidth={2.2} />
				Preferences{rated > 0 && ` (${rated})`}
			</button>

			{open && <PreferencesDialog tags={tags} onClose={() => setOpen(false)} />}
		</>
	);
}

/**
 * Split out so the dialog mounts only while open, which is what lets
 * useModalDialog call showModal() on mount and get the native focus trap,
 * Escape handling and focus restoration rather than three hand-rolled
 * approximations of them.
 */
function PreferencesDialog({
	tags,
	onClose,
}: {
	tags: string[];
	onClose: () => void;
}) {
	const { tagPrefs, cycleTagPreference, clearTagPrefs } = useEventsContext();
	const { ref, close } = useModalDialog(onClose);
	const rated = Object.keys(tagPrefs).length;

	return (
		<dialog ref={ref} className="prefs-backdrop" aria-label="Event preferences">
			{/* A real button rather than a click handler on the backdrop: it is
			    focusable and it announces itself. Same pattern as the card sheet. */}
			<button
				type="button"
				className="prefs-scrim"
				aria-label="Close preferences"
				onClick={close}
			/>
			<div className="prefs-pane">
				<div className="prefs-head">
					<h2>Preferences</h2>
					<button
						type="button"
						className="icon-btn"
						onClick={close}
						aria-label="Close preferences"
					>
						<X size={16} />
					</button>
				</div>
				<p className="prefs-note">
					Tap once for <strong>more</strong> of a kind of event, twice for{" "}
					<strong>less</strong>. More sorts first, less sorts last — whatever it
					scored.
				</p>
				<div className="prefs-tags">
					{tags.map((tag) => {
						const pref = tagPrefs[tag];
						const state =
							pref === 1 ? "more" : pref === -1 ? "less" : "neutral";
						return (
							<button
								type="button"
								key={tag}
								className={`filter-btn pref-chip pref-chip--${state}`}
								onClick={() => cycleTagPreference(tag)}
								aria-pressed={pref !== undefined}
								title={
									pref === 1
										? `More ${tag} — tap for less`
										: pref === -1
											? `Less ${tag} — tap to clear`
											: `Tap for more ${tag}`
								}
							>
								{pref === 1 ? "+ " : pref === -1 ? "\u2212 " : ""}
								{tag}
							</button>
						);
					})}
				</div>
				{rated > 0 && (
					<button
						type="button"
						className="filter-btn prefs-clear"
						onClick={clearTagPrefs}
					>
						Clear {rated} preference{rated === 1 ? "" : "s"}
					</button>
				)}
			</div>
		</dialog>
	);
}
