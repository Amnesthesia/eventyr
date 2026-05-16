import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	CATEGORY_EMOJI,
	DATA_ROOT,
	fmtDate,
	requireEnv,
	TOP_PICK_THRESHOLD,
} from "./common.ts";

const CITY = requireEnv("CITY");
const WA_TOKEN = requireEnv("WHATSAPP_TOKEN");
const WA_PHONE_ID = requireEnv("WHATSAPP_PHONE_ID");
const WA_TO = requireEnv("WHATSAPP_RECIPIENT")
	.split(",")
	.map((n) => n.trim())
	.filter(Boolean);

const MAX_CHARS = 4000;

type Event = Record<string, unknown>;

function tagsLine(tags: string[]): string {
	return `  🏷 ${tags.slice(0, 6).join(" · ")}\n`;
}

function entryTopPick(e: Event): string {
	const cat = (e.category as string) ?? "Community / Other";
	const emoji = CATEGORY_EMOJI[cat] ?? "📌";
	const cost = (e.cost as string) ?? "See link";
	const costS = cost.toLowerCase() === "free" ? "Free ✓" : cost;
	const tags = (e.tags as string[]) ?? [];
	const desc = (e.description as string) ?? "";

	let s = `• *${(e.title as string) ?? "Untitled"}*\n`;
	s += `  ${emoji} ${(e.datetime as string) ?? "—"}  ·  💰 ${costS}\n`;
	s += `  📍 ${(e.location as string) ?? "—"}\n`;
	if (tags.length > 0) s += tagsLine(tags);
	if (desc) s += `  ${desc}\n`;
	s += `  🔗 ${(e.link as string) ?? ""}\n\n`;
	return s;
}

function entryFull(e: Event): string {
	const cost = (e.cost as string) ?? "See link";
	const costS = cost.toLowerCase() === "free" ? "Free ✓" : cost;
	const tags = (e.tags as string[]) ?? [];
	const desc = (e.description as string) ?? "";

	let s = `• *${(e.title as string) ?? "Untitled"}*\n`;
	s += `  📆 ${(e.datetime as string) ?? "—"}  ·  💰 ${costS}\n`;
	s += `  📍 ${(e.location as string) ?? "—"}\n`;
	if (tags.length > 0) s += tagsLine(tags);
	if (desc) s += `  ${desc}\n`;
	s += `  🔗 ${(e.link as string) ?? ""}\n\n`;
	return s;
}

function append(
	messages: string[],
	current: string,
	entry: string,
	continuationHeader: string,
): string {
	if (current.length + entry.length > MAX_CHARS) {
		messages.push(current.trim());
		return continuationHeader + entry;
	}
	return current + entry;
}

function formatWhatsapp(
	events: Event[],
	monday: Date,
	sunday: Date,
	cityName: string,
): string[] {
	if (events.length === 0) {
		return [
			`📅 *${cityName} This Week* (${fmtDate(monday)} – ${fmtDate(sunday)})\n\n` +
				"No events found this week. Check back next Monday!",
		];
	}

	const topPicks = events.filter(
		(e) => ((e.score as number) ?? 0) >= TOP_PICK_THRESHOLD,
	);
	const remaining = events.filter(
		(e) => ((e.score as number) ?? 0) < TOP_PICK_THRESHOLD,
	);

	const messages: string[] = [];

	const header =
		`📅 *${cityName} This Week*\n` +
		`${fmtDate(monday)} – ${fmtDate(sunday)}\n` +
		`⭐ ${topPicks.length} top picks  ·  ${events.length} events found\n` +
		`${"─".repeat(28)}\n\n` +
		"⭐ *TOP PICKS*\n\n";

	let current = header;
	for (const e of topPicks) {
		current = append(
			messages,
			current,
			entryTopPick(e),
			"⭐ *TOP PICKS (cont.)*\n\n",
		);
	}
	if (current.trim()) messages.push(current.trim());

	if (remaining.length === 0) return messages;

	const byCat: Record<string, Event[]> = {};
	for (const e of remaining) {
		const cat = (e.category as string) ?? "Community / Other";
		if (!byCat[cat]) byCat[cat] = [];
		byCat[cat].push(e);
	}

	current = "📋 *All Events This Week*\n\n";
	for (const [cat, catEvents] of Object.entries(byCat)) {
		const emoji = CATEGORY_EMOJI[cat] ?? "📌";
		const catHeader = `*${emoji} ${cat}*\n`;

		if (current.length + catHeader.length > MAX_CHARS) {
			messages.push(current.trim());
			current = catHeader;
		} else {
			current += catHeader;
		}

		for (const e of catEvents) {
			current = append(messages, current, entryFull(e), "");
		}
	}
	if (current.trim()) messages.push(current.trim());

	return messages;
}

async function sendWhatsapp(text: string, recipient: string): Promise<void> {
	console.log(`\n── Message preview ──\n${text}\n─────────────────────\n`);

	const url = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${WA_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to: recipient,
			type: "text",
			text: { body: text, preview_url: false },
		}),
	});

	const body = await res.text();
	console.log(`→ WhatsApp API response: ${res.status} — ${body.slice(0, 300)}`);
	if (!res.ok) {
		throw new Error(`WhatsApp API error ${res.status}: ${body}`);
	}
	console.log(`→ WhatsApp message sent (${text.length} chars)`);
}

async function main(): Promise<void> {
	const jsonPath = join(DATA_ROOT, `${CITY}.json`);
	if (!existsSync(jsonPath)) {
		throw new Error(`✗ ${jsonPath} not found — run collection.ts first.`);
	}

	const payload = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<
		string,
		unknown
	>;
	const events = (payload.events as Event[]) ?? [];
	const monday = new Date(payload.week_start as string);
	const sunday = new Date(payload.week_end as string);
	const cityName = payload.city as string;

	console.log(
		`Messaging — ${cityName} — ${fmtDate(monday)} to ${fmtDate(sunday)}`,
	);
	console.log("=".repeat(50));

	const messages = formatWhatsapp(events, monday, sunday, cityName);
	console.log(`→ Digest split into ${messages.length} WhatsApp message(s)`);
	console.log(`→ Sending to ${WA_TO.length} recipient(s): ${WA_TO.join(", ")}`);

	for (const recipient of WA_TO) {
		for (let i = 0; i < messages.length; i++) {
			console.log(
				`→ [${recipient}] Sending message ${i + 1}/${messages.length}…`,
			);
			await sendWhatsapp(messages[i], recipient);
		}
	}

	console.log("✓ Messaging complete.");
}

await main();
