import { useEventsContext } from "../../context";
import { TIME_BAND_LABELS, TIME_BANDS } from "../../utils/timeOfDay";

export default function TimeOfDayFilter() {
	const { timeBands, toggleTimeBand } = useEventsContext();

	// No "any time" pill: no selection already means any time, and a filled
	// chip for "nothing is filtered" was the loudest thing in the old bar.
	return (
		<div className="chips">
			{TIME_BANDS.map((band) => {
				const on = timeBands.includes(band);
				return (
					<button
						type="button"
						key={band}
						className={`chip${on ? " chip--on" : ""}`}
						onClick={() => toggleTimeBand(band)}
						aria-pressed={on}
					>
						{TIME_BAND_LABELS[band]}
					</button>
				);
			})}
		</div>
	);
}
