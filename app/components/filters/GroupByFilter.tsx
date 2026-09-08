import { useEventsContext } from "../../context";
import type { GroupBy } from "../../utils/grouping";

const OPTIONS: { value: GroupBy; label: string }[] = [
	{ value: "date", label: "Date" },
	{ value: "category", label: "Category" },
	{ value: "none", label: "None" },
];

// View state, not a filter — which is why it sits with the result count rather
// than in the filter stack, where it read as one more thing narrowing the list.
export default function GroupByFilter() {
	const { groupBy, setGroupBy } = useEventsContext();

	return (
		<fieldset className="seg" aria-label="Group events by">
			{OPTIONS.map(({ value, label }) => (
				<button
					type="button"
					key={value}
					className={`seg-btn${groupBy === value ? " seg-btn--on" : ""}`}
					onClick={() => setGroupBy(value)}
					aria-pressed={groupBy === value}
				>
					{label}
				</button>
			))}
		</fieldset>
	);
}
