import { useEventsContext } from "../../context";
import type { PastFilter as PastFilterType } from "../../types";

const PAST_CYCLE: Record<PastFilterType, PastFilterType> = {
	"no-past": "all",
	all: "only-past",
	"only-past": "no-past",
};
const PAST_LABEL: Record<PastFilterType, string> = {
	"no-past": "No Past",
	all: "All Events",
	"only-past": "Past Events",
};

export default function PastFilter() {
	const { pastFilter, setPastFilter } = useEventsContext();

	return (
		<button
			type="button"
			className={
				pastFilter === "only-past"
					? "filter-btn active"
					: pastFilter === "no-past"
						? "filter-btn vibe-no"
						: "filter-btn"
			}
			onClick={() => setPastFilter(PAST_CYCLE[pastFilter])}
		>
			{PAST_LABEL[pastFilter]}
		</button>
	);
}
