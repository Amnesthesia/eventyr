import { useEventsContext } from "../../context";
import type { GroupBy } from "../../utils/grouping";

const OPTIONS: { value: GroupBy; label: string }[] = [
	{ value: "none", label: "Ungrouped" },
	{ value: "date", label: "By Date" },
	{ value: "category", label: "By Category" },
];

export default function GroupByFilter() {
	const { groupBy, setGroupBy } = useEventsContext();

	return (
		<span className="filters">
			{OPTIONS.map(({ value, label }) => (
				<button
					type="button"
					key={value}
					className={`filter-btn${groupBy === value ? " active" : ""}`}
					onClick={() => setGroupBy(value)}
					aria-pressed={groupBy === value}
				>
					{label}
				</button>
			))}
		</span>
	);
}
