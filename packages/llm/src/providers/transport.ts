// What the client needs from a provider: the replay line, the live call and
// the canned-response path. One object per provider; the client owns the
// limiter, retries, budget, cache and accounting around it.

import type { AskOptions, ProviderName, StageUsage } from "../types.ts";

export interface ProviderResult {
	text: string;
	usage: Partial<StageUsage>;
	finishReason: string | null;
}

export interface CallContext {
	stage: string;
	model: string;
	prompt: string;
	opts: AskOptions;
}

export interface Transport {
	readonly provider: ProviderName;
	/** The request as the goldens record it. */
	line(ctx: CallContext): string;
	/** The real SDK call. */
	send(ctx: CallContext): Promise<ProviderResult>;
	/** The same call answered from a canned response file. */
	replay(ctx: CallContext, canned: string): ProviderResult;
}

/** A string system prompt, or the blocks joined, for providers with one
 * system field. */
export function systemText(system: AskOptions["system"]): string | undefined {
	if (system === undefined) return undefined;
	return Array.isArray(system) ? system.join("\n\n") : system;
}

/** Options a provider has no mapping for are refused, never dropped: the
 * caller asked for them, so the request would be a lie without them. */
export function refuse(
	provider: ProviderName,
	opts: AskOptions,
	keys: (keyof AskOptions)[],
): void {
	for (const key of keys) {
		if (opts[key] !== undefined && opts[key] !== false) {
			throw new Error(`${provider}: ${key} is not supported`);
		}
	}
}
