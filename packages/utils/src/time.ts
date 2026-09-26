export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Jittered exponential backoff: `baseMs * 2 ** attempt`, plus up to 30% so
 * that callers rate-limited together do not retry together.
 */
export function backoffDelay(attempt: number, baseMs: number): number {
	const base = baseMs * 2 ** attempt;
	return base + Math.floor(Math.random() * base * 0.3);
}
