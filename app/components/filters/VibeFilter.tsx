import { useEventsContext } from "../../context";
import type { TriState } from "../../types";
import { VIBE_KEYS, VIBE_LABELS } from "../../utils/vibes";

const CYCLE: Record<TriState, TriState> = { any: "yes", yes: "no", no: "any" };

export default function VibeFilter() {
	const { vibeFilters, setVibe, resetVibes } = useEventsContext();
	const allAny = Object.values(vibeFilters).every((v) => v === "any");

	return (
		<span className="filters">
			<button
				type="button"
				className={`filter-btn${allAny ? " active" : ""}`}
				onClick={resetVibes}
			>
				All Vibes
			</button>
			{VIBE_KEYS.map((key) => {
				const state = vibeFilters[key];
				const cls =
					state === "yes"
						? "filter-btn active"
						: state === "no"
							? "filter-btn vibe-no"
							: "filter-btn";
				const prefix = state === "yes" ? "+ " : state === "no" ? "− " : "";
				return (
					<button
						type="button"
						key={key}
						className={cls}
						data-vibe={key}
						onClick={() => setVibe(key, CYCLE[state])}
					>
						{prefix}
						{VIBE_LABELS[key]}
					</button>
				);
			})}
		</span>
	);
}
