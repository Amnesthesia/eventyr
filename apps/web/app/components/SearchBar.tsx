import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useEventsContext } from "../context";

export default function SearchBar() {
	const { query, setQuery, filtered } = useEventsContext();
	const inputRef = useRef<HTMLInputElement>(null);

	// The "/" in the field is a promise, so it has to work. Ignored while the
	// caret is already in a field, or typing a date into the range picker would
	// jump focus up here.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
			const el = e.target as HTMLElement | null;
			if (el?.isContentEditable) return;
			if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
			e.preventDefault();
			inputRef.current?.focus();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div className="search-bar">
			{/* The shortcut, not a magnifier: the field already says "search
			    events", and the glyph that earns its space is the one telling you
			    how to get here without the mouse. */}
			<span className="search-key" aria-hidden="true">
				/
			</span>
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
				ref={inputRef}
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
