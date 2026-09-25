// Pins the process clock for the LLM parity harness (scripts/llm-parity.mjs).
//
//   NODE_OPTIONS="--import=file:///…/scripts/fake-now.mjs" EVENTYR_FAKE_NOW=2026-09-23T10:00:00+10:00 pnpm curate
//
// Every pipeline CLI derives "this week" and the publishing window from
// `new Date()`, so a golden recorded one week would stop matching the next.
// The clock still ticks from the pinned instant (durations and timeouts keep
// working); only the origin moves. Timers, performance.now() and the
// replay-latency sleeps are untouched, so the concurrency measurements stay
// real. Test-harness only — nothing in the pipeline imports this.
const pinned = process.env.EVENTYR_FAKE_NOW;
if (pinned) {
	const RealDate = Date;
	const origin = RealDate.parse(pinned);
	if (Number.isNaN(origin)) throw new Error(`EVENTYR_FAKE_NOW is not a date: ${pinned}`);
	const bootedAt = RealDate.now();
	const now = () => origin + (RealDate.now() - bootedAt);
	globalThis.Date = class extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(now());
			else super(...args);
		}
		static now() {
			return now();
		}
	};
}
