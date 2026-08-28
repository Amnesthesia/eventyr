// Minimal robots.txt parser — enough to honour Disallow/Allow rules for our
// user-agent (falling back to "*") before the shared fetch layer requests a
// URL. Not a full spec implementation (no crawl-delay, no wildcard/`$`
// pattern matching beyond prefix match), which is standard for the small
// set of rules real-world sites actually publish.

interface RobotsRuleSet {
	allow: string[];
	disallow: string[];
}

export interface RobotsPolicy {
	isAllowed(path: string): boolean;
}

function parseRobotsTxt(body: string, userAgent: string): RobotsRuleSet {
	const groups = new Map<string, RobotsRuleSet>();
	let currentAgents: string[] = [];

	for (const rawLine of body.split("\n")) {
		const line = rawLine.split("#")[0]?.trim() ?? "";
		if (!line) continue;
		const sepIdx = line.indexOf(":");
		if (sepIdx === -1) continue;
		const field = line.slice(0, sepIdx).trim().toLowerCase();
		const value = line.slice(sepIdx + 1).trim();

		if (field === "user-agent") {
			// A new User-agent line after any rule line starts a fresh group.
			const prevHadRules = currentAgents.some(
				(a) =>
					(groups.get(a)?.allow.length ?? 0) +
						(groups.get(a)?.disallow.length ?? 0) >
					0,
			);
			if (prevHadRules || currentAgents.length === 0) currentAgents = [];
			currentAgents.push(value.toLowerCase());
			for (const agent of currentAgents) {
				if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [] });
			}
		} else if (field === "allow" && value) {
			for (const agent of currentAgents) groups.get(agent)?.allow.push(value);
		} else if (field === "disallow" && value) {
			for (const agent of currentAgents)
				groups.get(agent)?.disallow.push(value);
		}
	}

	const ua = userAgent.toLowerCase();
	for (const [agent, rules] of groups) {
		if (ua.includes(agent) && agent !== "*") return rules;
	}
	return groups.get("*") ?? { allow: [], disallow: [] };
}

export function evaluateRobots(body: string, userAgent: string): RobotsPolicy {
	const rules = parseRobotsTxt(body, userAgent);
	return {
		isAllowed(path: string): boolean {
			// Longest matching rule wins, per the de-facto robots.txt convention.
			let bestLen = -1;
			let allowed = true;
			for (const rule of rules.disallow) {
				if (path.startsWith(rule) && rule.length > bestLen) {
					bestLen = rule.length;
					allowed = false;
				}
			}
			for (const rule of rules.allow) {
				if (path.startsWith(rule) && rule.length > bestLen) {
					bestLen = rule.length;
					allowed = true;
				}
			}
			return allowed;
		},
	};
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };

export async function fetchRobotsPolicy(
	origin: string,
	userAgent: string,
	fetchImpl: typeof fetch = fetch,
): Promise<RobotsPolicy> {
	try {
		const res = await fetchImpl(`${origin}/robots.txt`, {
			headers: { "User-Agent": userAgent },
		});
		if (!res.ok) return ALLOW_ALL;
		const body = await res.text();
		return evaluateRobots(body, userAgent);
	} catch {
		// robots.txt unreachable — don't let that block fetching the site.
		return ALLOW_ALL;
	}
}
