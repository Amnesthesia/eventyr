import { Search, X } from "lucide-react";
import { useEventsContext } from "../context";

export default function SearchBar() {
	const { query, setQuery, filtered } = useEventsContext();

	return (
		<div className="search-bar">
			<Search size={12} strokeWidth={2} aria-hidden="true" />
			{/*
			 * Deliberately type="text", not type="search". Pico styles
			 * `input:not(…)[type=search]` at specificity (0,2,1) and gives it a
			 * background-image magnifier plus a 1.75rem inline-start pad — which
			 * is where the second magnifier and the indented text came from.
			 * Outranking that selector takes three classes; not matching it takes
			 * one word. inputMode/enterKeyHint keep the mobile search keyboard,
			 * and we draw our own clear button anyway.
			 */}
			<input
				type="text"
				inputMode="search"
				enterKeyHint="search"
				className="search-input"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="search events…"
				aria-label="Search events"
				autoComplete="off"
			/>
			{query && (
				<>
					<span className="search-count" aria-live="polite">
						{filtered.length}
					</span>
					<button
						type="button"
						className="search-clear"
						onClick={() => setQuery("")}
						aria-label="Clear search"
					>
						<X size={11} strokeWidth={2} />
					</button>
				</>
			)}
		</div>
	);
}
