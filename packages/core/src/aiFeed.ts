// The compact JSON shape apps/pipeline/src/publish/ai.ts writes to
// apps/web/public/ai/**/*.json, and apps/mcp reads back over MCP. One
// definition so the producer and the consumer can't drift (1.12): ai.ts is
// what's actually emitted, so this follows ai.ts wherever the two disagreed.

export interface CompactEvent {
	id: string;
	title: string;
	start: string;
	end: string | null;
	location: string;
	category: string;
	price: number | null;
	free: boolean;
	description: string;
	url: string;
}

export interface DayFile {
	data_as_of: string;
	city: string;
	city_key: string;
	timezone: string;
	date: string;
	events: CompactEvent[];
}

export interface WeekFile {
	data_as_of: string;
	city: string;
	city_key: string;
	timezone: string;
	week_start: string;
	week_end: string;
	events: CompactEvent[];
}

export interface WeekCategoryEntry {
	category: string;
	slug: string;
	file: string;
}

export interface CityIndexEntry {
	city: string;
	city_key: string;
	slug: string;
	timezone: string;
	data_as_of: string;
	days: string[];
	week: string | null;
	week_categories: WeekCategoryEntry[];
}

export interface AiIndex {
	data_as_of: string;
	cities: CityIndexEntry[];
}
