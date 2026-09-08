import { useEventsContext } from "../../context";
import type { PastFilter as PastFilterType } from "../../types";

/**
 * A segmented control, not a cycling chip.
 *
 * "Hide past" is the default and therefore renders unselected everywhere else
 * in this UI — but hiding past events is a thing the filter is actively doing,
 * so an unlit chip labelled with it read as switched off. Three segments with
 * exactly one lit says which of the three you are looking at, at rest and
 * after every press.
 */
const OPTIONS: { value: PastFilterType; label: string }[] = [
	{ value: "no-past", label: "Upcoming" },
	{ value: "all", label: "Include past" },
	{ value: "only-past", label: "Past only" },
];

export default function PastFilter() {
	const { pastFilter, setPastFilter } = useEventsContext();

	return (
		<fieldset className="seg" aria-label="Past events">
			{OPTIONS.map(({ value, label }) => (
				<button
					type="button"
					key={value}
					className={`seg-btn${pastFilter === value ? " seg-btn--on" : ""}`}
					aria-pressed={pastFilter === value}
					onClick={() => setPastFilter(value)}
				>
					{label}
				</button>
			))}
		</fieldset>
	);
}
