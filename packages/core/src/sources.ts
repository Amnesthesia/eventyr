import { z } from "zod";

export const SourceTierSchema = z.enum([
	"aggregators",
	"institutions",
	"independents",
]);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export const SourceMethodSchema = z.enum(["llm", "scraper", "disabled"]);

export const VenueRecordSchema = z.object({
	name: z.string().nullable(),
	address: z.string().nullable(),
	suburb: z.string().nullable(),
	aliases: z.array(z.string()).optional(),
});
export type VenueRecord = z.infer<typeof VenueRecordSchema>;

export const SourceSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	method: SourceMethodSchema.optional(), // The spec says the method union is three-valued, maybe it defaults to something?
	domains: z.array(z.string()).optional(),
	pin: z.boolean().optional(),
	homepage: z.string().nullable().optional(),
	listingUrls: z.array(z.string()).optional(),
	strategy: z.enum(["jsonld", "html", "render"]).optional(),
	venue: VenueRecordSchema.optional(),
	note: z.string().optional(),
});
export type SourceEntry = z.infer<typeof SourceSchema>;

export const CityConfigSchema = z.object({
	name: z.string(),
	timezone: z.string(),
	centre: z
		.object({
			lat: z.number(),
			lng: z.number(),
			radiusKm: z.number(),
		})
		.optional(),
	locale: z.string().optional(),
	currency: z.string().optional(),
	sources: z.record(SourceTierSchema, z.array(SourceSchema)),
});
export type CityConfig = z.infer<typeof CityConfigSchema>;

export interface SourceDefinition extends SourceEntry {
	id: string;
	listingUrls: string[];
	domains: string[];
	strategy: "jsonld" | "html" | "render";
	sourceTier: SourceTier;
	timeZone: string;
}
