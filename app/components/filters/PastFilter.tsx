import { useEventsContext } from "../../context";
import type { PastFilter as PastFilterType } from "../../types";

const PAST_CYCLE: Record<PastFilterType, PastFilterType> = {
	"no-past": "all",
	all: "only-past",
	"only-past": "no-past",
};
const PAST_LABEL: Record<PastFilterType, string> = {
	"no-past": "Hide past",
	all: "Include past",
	"only-past": "Only past",
};

export default function PastFilter() {
	const { pastFilter, setPastFilter } = useEventsContext();

	return (
		<button
			type="button"
			className={`chip${pastFilter !== "no-past" ? " chip--on" : ""}`}
			onClick={() => setPastFilter(PAST_CYCLE[pastFilter])}
		>
			{PAST_LABEL[pastFilter]}
		</button>
	);
}
