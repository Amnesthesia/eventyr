/**
 * Parses a JSON array out of an LLM response, tolerating the two things these
 * responses actually do wrong: wrapping the array in prose/code fences, and
 * getting cut off mid-array by the output token cap. On truncation it retries
 * at the last complete object rather than losing the whole batch — a clipped
 * final event should cost one event, not all of them.
 */
export function parseJsonArray<T>(raw: string, label?: string): T[] {
	const cleaned = raw.replace(/```json|```/g, "").trim();
	const start = cleaned.indexOf("[");
	if (start === -1) return [];
	let jsonStr = cleaned.slice(start);
	const end = jsonStr.lastIndexOf("]");
	if (end !== -1) jsonStr = jsonStr.slice(0, end + 1);
	try {
		return JSON.parse(jsonStr) as T[];
	} catch {
		const lastComplete = jsonStr.lastIndexOf("},");
		if (lastComplete !== -1) {
			try {
				return JSON.parse(`${jsonStr.slice(0, lastComplete + 1)}]`) as T[];
			} catch {
				// fall through to the shared failure log
			}
		}
		if (label) console.log(`  ✗ [${label}] Could not parse JSON response`);
		return [];
	}
}
