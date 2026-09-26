#!/usr/bin/env node
// Characterises the city page's client-side filtering from the browser, so a refactor of the filter
// code can be proven behaviour-neutral with evidence that doesn't depend on that code.
//
//   node scripts/filter-parity.mjs <base-url> <out.json> [now-iso] [city-slug]
//
// Runs a fixed list of filter interactions against a built site (`pnpm build && pnpm preview`) and
// records, after each one, the "X of Y events match" line and every section's ordered card titles.
// Diff two runs with `diff <(jq -S . a.json) <(jq -S . b.json)`. Exits 1 on any console error.
//
// Elements are found by ARIA role and visible text, never CSS classes, so the script survives a
// restyle or a React upgrade (it is reused in 1.9, 1.13 and 2.1).
//
// "Upcoming", "Today" and the "Weekend" preset depend on the viewer's clock and zone. The zone is
// pinned to Australia/Brisbane; pass `now-iso` to pin the clock too, which makes two runs comparable
// however far apart they happen. Without it both runs must happen within the same hour.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const [base, out, now, city = "brisbane"] = process.argv.slice(2);
if (!base || !out) {
	console.error("usage: filter-parity.mjs <base-url> <out.json> [now-iso] [city-slug]");
	process.exit(2);
}

const errors = [];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
// A fresh context per run: no saved or hidden events, so nothing but the filters shapes the list.
const context = await browser.newContext({ timezoneId: "Australia/Brisbane", locale: "en-AU" });
const page = await context.newPage();
if (now) await page.clock.setFixedTime(new Date(now));
// Third-party requests (fonts, analytics, remote images) are blocked: they aren't what this checks,
// and their failures are not counted as console errors.
await page.route((url) => !url.href.startsWith(base), (route) => route.abort());
page.on("console", (m) => {
	if (m.type() !== "error") return;
	const at = m.location()?.url ?? "";
	if (/Failed to load resource/.test(m.text()) && at && !at.startsWith(base)) return;
	errors.push(`console: ${m.text()} @ ${at}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const settle = () => page.waitForTimeout(250);
const button = (name) => page.getByRole("button", { name, exact: true });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Vibe and tag chips are named "<label><count>".
const chip = (label) => page.getByRole("button", { name: new RegExp(`^${escapeRe(label)}\\s*\\d+$`) });
const typeahead = () => page.getByRole("textbox", { name: "Filter the vibe and tag chips" });

async function load() {
	await page.goto(`${base}/${city}/`, { waitUntil: "domcontentloaded" });
	// Astro drops `ssr` from an island once it has hydrated; a click before that does nothing.
	await page.waitForFunction(() => !document.querySelector("astro-island[ssr]"), null, { timeout: 30000 });
	await page.waitForTimeout(300); // the post-mount "today" correction
	await button("More filters").click();
	await settle();
}

/** The chip labels in the vibe + tag pool, in on-screen order, with pressed/enabled state. */
async function poolChips() {
	return typeahead()
		.locator("xpath=following-sibling::*//button")
		.evaluateAll((els) =>
			els.map((b) => ({
				label: b.firstChild?.textContent ?? "",
				pressed: b.getAttribute("aria-pressed") === "true",
				enabled: !b.disabled,
			})),
		);
}

const VIBES = ["Stimulating", "Creative", "Hands On", "Social"];
const firstFree = (chips, want) => chips.find((c) => want(c.label) && c.enabled && !c.pressed)?.label;

async function pickTag() {
	await typeahead().fill("");
	await settle();
	const tag = firstFree(await poolChips(), (l) => !VIBES.includes(l));
	if (!tag) throw new Error("no selectable tag chip");
	await typeahead().fill(tag);
	await settle();
	await chip(tag).click();
	await typeahead().fill("");
	return tag;
}

async function pickVibe() {
	const vibe = firstFree(await poolChips(), (l) => VIBES.includes(l));
	if (!vibe) throw new Error("no selectable vibe chip");
	await chip(vibe).click();
	return vibe;
}

async function pickVenue() {
	const select = page.getByRole("combobox", { name: "Venue" });
	const labels = await select.locator("option").allTextContents();
	// The venue with the most events (first on ties), so the pick doesn't depend on the week's data.
	let best = null;
	for (const label of labels) {
		const n = Number(label.match(/\((\d+)\)$/)?.[1] ?? 0);
		if (n > (best?.n ?? 0)) best = { label, n };
	}
	if (!best) throw new Error("no venue options");
	await select.selectOption({ label: best.label });
	return best.label;
}

async function customRange() {
	await button("Pick date range").click();
	const from = page.getByLabel("From", { exact: true });
	const min = await from.getAttribute("min");
	const day = (n) => {
		const d = new Date(`${min}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() + n);
		return d.toISOString().slice(0, 10);
	};
	await from.fill(day(3));
	await page.getByLabel("To", { exact: true }).fill(day(5));
	return `${day(3)}..${day(5)}`;
}

const search = (q) => async () => {
	await page.getByRole("textbox", { name: "Search events" }).fill(q);
};

// Each scenario starts from a fresh page load; its steps are cumulative and each one is recorded.
const click = (name) => async () => {
	await button(name).click();
};
const category = (name) => async () => {
	// The header chip, not the same-named browse link further down the page.
	await page.getByRole("banner").getByRole("link", { name, exact: true }).click();
};
const SCENARIOS = [
	["initial", []],
	...["Arts", "Community", "Music", "Talks", "Social", "Workshops"].map((c) => [`category ${c}`, [category(c)]]),
	["when Today", [click("Today")]],
	["when Tomorrow", [click("Tomorrow")]],
	["when Weekend", [click("Weekend")]],
	["when custom range", [customRange]],
	["time Morning", [click("Morning")]],
	["time Afternoon", [click("Afternoon")]],
	["time Evening", [click("Evening")]],
	["time Morning+Evening", [click("Morning"), click("Evening")]],
	["past Include then Only", [click("Include past"), click("Past only")]],
	["score tiers", [click("6+ Good"), click("7+ Great"), click("8+ Best"), click("Any")]],
	["vibes one then two", [pickVibe, pickVibe]],
	["tags one then two", [pickTag, pickTag]],
	["venue", [pickVenue]],
	...["jazz", "jaz", "café", "cafe", "live music"].map((q) => [`search ${q}`, [search(q)]]),
	["clear all", [category("Music"), search("jazz"), click("7+ Great"), click("Clear all")]],
];

function snapshot() {
	return page.evaluate(() => {
		const main = document.querySelector("main");
		const count = [...main.querySelectorAll("p")]
			.find((p) => /events match/.test(p.textContent))
			?.textContent.replace(/\s+/g, " ")
			.trim();
		const sections = [];
		let cur = null;
		for (const el of main.querySelectorAll("h2, h3, article")) {
			if (el.tagName === "ARTICLE") {
				cur?.titles.push(el.querySelector("h3")?.textContent.trim() ?? null);
			} else if (el.tagName === "H2" || !el.closest("article")) {
				const heading = el.textContent.replace(/\s+/g, " ").trim();
				cur = el.tagName === "H2"
					? { section: heading, group: null, titles: [] }
					: { section: cur?.section ?? null, group: heading, titles: [] };
				sections.push(cur);
			}
		}
		return { count, sections };
	});
}

const results = [];
for (const [scenario, steps] of SCENARIOS) {
	await load();
	if (steps.length === 0) results.push({ scenario, step: 0, ...(await snapshot()) });
	for (const [i, step] of steps.entries()) {
		const picked = await step();
		await settle();
		results.push({ scenario, step: i + 1, picked: picked ?? null, ...(await snapshot()) });
	}
	console.log(`${scenario}: ${results.at(-1).count}`);
}
await browser.close();

writeFileSync(out, `${JSON.stringify({ city, now: now ?? null, results }, null, 1)}\n`);
console.log(`${results.length} snapshots → ${out}`);
if (errors.length) {
	console.error(`${errors.length} console error(s):\n${errors.join("\n")}`);
	process.exit(1);
}
