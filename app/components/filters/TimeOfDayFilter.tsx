import { useEventsContext } from "../../context";
import { TIME_BAND_LABELS, TIME_BANDS } from "../../utils/timeOfDay";

export default function TimeOfDayFilter() {
	const { timeBands, toggleTimeBand, clearTimeBands } = useEventsContext();

	return (
		<span className="filters">
			{/* The resting state and the one press back to it, like All Vibes and
			    All Tags. Active when nothing is picked, so the row always shows a
			    current state rather than none. */}
			<button
				type="button"
				className={`filter-btn${timeBands.length === 0 ? " active" : ""}`}
				onClick={clearTimeBands}
				aria-pressed={timeBands.length === 0}
				title="Events at any time of day"
			>
				Any Time of Day
			</button>
			{TIME_BANDS.map((band) => {
				const on = timeBands.includes(band);
				return (
					<button
						type="button"
						key={band}
						className={`filter-btn${on ? " active" : ""}`}
						onClick={() => toggleTimeBand(band)}
						aria-pressed={on}
					>
						{TIME_BAND_LABELS[band]}
					</button>
				);
			})}
		</span>
	);
}
