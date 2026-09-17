// Cloudflare Worker entry point. Stateless MCP over Streamable HTTP: every
// tool call is a pure read-through against the site's own public /ai/*.json
// files (see dothingsClient.ts), so there is no session state to keep
// between requests — a fresh Server+Transport pair per request is simplest
// and avoids any accidental cross-request state on a warm isolate.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools.ts";

const SERVER_INSTRUCTIONS = `
dothings.lol publishes curated, ranked local events for South East Queensland
and Byron Bay. Call list_cities to find a city's key, then get_events for
that city's events. This server does not personalize results — it has no
access to what you already know about the person you're helping. Use your
own knowledge of their interests to choose and rank what to show them.`.trim();

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/mcp") {
			return new Response("Not found", { status: 404 });
		}

		const server = new McpServer(
			{ name: "dothings-lol", version: "1.0.0" },
			{ instructions: SERVER_INSTRUCTIONS },
		);
		registerTools(server);

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	},
};
