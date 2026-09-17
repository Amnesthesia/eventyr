// The "Connect via MCP" link, shared between the main app header
// (Header.tsx, browser bundle) and the /ai page (ai.astro, built server-side)
// so the two never drift apart or repeat the same config-building bug twice.
//
// install.apicommons.org/mcp-install is an open (Apache-2.0, no backend)
// install chooser covering Claude/ChatGPT/Cursor/VS Code/etc from one link —
// see its README for the `?config=<base64url>` contract this builds.

export const MCP_URL = "https://mcp.dothings.lol/mcp";

const MCP_DESCRIPTION =
	"Curated, ranked local events for South East Queensland and Byron Bay. list_cities finds a city's key; get_events returns its events. No personalization built in — bring your own knowledge of the user's interests to rank results.";

/** UTF-8-safe base64url, built only from APIs available in both the browser
 * bundle and a plain Node build step — btoa() alone chokes on the em dash in
 * MCP_DESCRIPTION, and node:buffer isn't safe to import from anything Vite
 * bundles for the client (see shared.ts's own node: import ban). */
function toBase64Url(json: string): string {
	const bytes = new TextEncoder().encode(json);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export const MCP_INSTALL_URL = `https://install.apicommons.org/?config=${toBase64Url(
	JSON.stringify({
		name: "dothings.lol",
		description: MCP_DESCRIPTION,
		remote: { type: "http", url: MCP_URL },
	}),
)}`;
