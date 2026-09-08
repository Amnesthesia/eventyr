import { useEventsContext } from "../context";
import { fmtRange } from "../utils/dates";
import GroupByFilter from "./filters/GroupByFilter";

/** The count moved out of the masthead because it never visibly reacted to a
 * filter there. Here it is the largest thing on the row, and it is the only
 * number on the page that changes on every filter interaction. */
export default function ResultsHeader() {
	const { filtered, cityData, weekStart, weekEnd } = useEventsContext();

	return (
		<div className="results-head">
			<p className="results-count">
				<strong>{filtered.length}</strong>
				{/* "events match" is the first thing dropped on a phone — the big
				    number beside "of 698" already says what it is. */}
				<span>
					of {cityData.events.length}{" "}
					<span className="results-word">events match</span>
				</span>
				<span className="results-range">{fmtRange(weekStart, weekEnd)}</span>
			</p>
			<div className="results-group">
				<span className="frow-label">Group</span>
				<GroupByFilter />
			</div>
		</div>
	);
}
