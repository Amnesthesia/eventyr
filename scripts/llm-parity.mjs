#!/usr/bin/env node
// LLM request parity harness (docs/monorepo/PLAN.md §9, phase 1.6).
//
// Runs every LLM-using CLI against the fixture city in apps/pipeline/test/fixtures/llm-city
// with the model replaced by canned responses (EVENTYR_LLM_REPLAY=replay, no
// key, no network beyond a local HTTP server that serves the fixture's pages),
// the clock pinned (scripts/fake-now.mjs) and the request stream recorded.
// The goldens in apps/pipeline/test/golden/llm are the contract a prompt-adjacent refactor
// must keep:
//
//   <cli>.jsonl      every request line the CLI made, sorted by sha256 of the
//                    line (arrival order is not deterministic under
//                    concurrency, so goldens are a set, never a sequence)
//   <cli>.stdout     the CLI's stdout, paths normalised, including the
//                    usage/cost report printed at exit (D19: byte-identical)
//   <cli>.meta.json  calls, peak in-flight Gemini calls and first→last-call
//                    wall-clock — the concurrency profile (D19)
//
// Usage:
//   node scripts/llm-parity.mjs [--record-meta] [cli ...]
//     cli ∈ curate venues rank collect-adapters probe-sources discover-sources
//           collect-google collect-anthropic collect-openai collect-openai-chat
//           collect-perplexity
//     (default: all)
//
// .jsonl and .stdout are rewritten on every run: `git diff --exit-code
// apps/pipeline/test/golden/llm` is the parity check. .meta.json is only written with
// --record-meta; otherwise the fresh profile is checked against it (calls
// equal, peak in-flight ≥ golden, wall-clock ≤ golden + 10%) and a drop fails
// the run — a drop means something went serial.
//
// Authoring a canned response: the replay seam throws on a request it has no
// response for and leaves the request as <hash>.missing.json next to where
// the response belongs (apps/pipeline/test/fixtures/llm-city/responses/<hash>.txt). Write
// the .txt by hand in the shape the stage's prompt asks for (Gemini: the
// answer text; Anthropic/OpenAI/Perplexity: the SDK's response object as
// JSON), delete the .missing.json, rerun. Never author one with a model.
//
// Requests are keyed by the full request line, so any edit to the fixture data
// or a prompt changes the hashes and the affected responses have to be
// re-authored under their new names — that is the harness catching a request
// change, which is its whole job.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "apps", "pipeline", "test", "fixtures", "llm-city");
const GOLDEN = join(REPO, "apps", "pipeline", "test", "golden", "llm");
const WWW = join(FIXTURE, "www");
/** The fixture's sources/brisbane.yml points at this port. */
const PORT = 48123;
/** Wednesday of the fixture week: curate's window is today → end of next week. */
const FAKE_NOW = "2026-09-23T10:00:00+10:00";
const WALL_CLOCK_TOLERANCE = 1.1;

const TSX = ["--filter", "@dothingslol/pipeline", "exec", "tsx", "--env-file-if-exists=../../.env", "--tsconfig", "tsconfig.json"];
/** Script + args, and any env the CLI needs on top of the harness's. The
 * collect runs mirror digest.yml (PROVIDERS, ANTHROPIC_TIERS), one provider
 * per run; collect-openai-chat is the non-gpt-5 (chat.completions) branch. */
const CLIS = {
	curate: { args: ["src/curate.ts"] },
	venues: { args: ["src/venues.ts"] },
	rank: { args: ["src/rank.ts"] },
	"collect-adapters": { args: ["src/cli/collectScraped.ts", "--only=fixture-programme"] },
	"probe-sources": { args: ["src/adapters/probe.ts", "--city=brisbane"] },
	"discover-sources": { args: ["src/adapters/discover.ts", "--city=brisbane"] },
	"collect-google": { args: ["src/cli/collectSearch.ts", "google"], env: { PROVIDERS: "google" } },
	"collect-anthropic": {
		args: ["src/cli/collectSearch.ts", "anthropic"],
		env: { PROVIDERS: "anthropic", ANTHROPIC_TIERS: "aggregators,institutions", ANTHROPIC_API_KEY: "dummy" },
	},
	"collect-openai": { args: ["src/cli/collectSearch.ts", "openai"], env: { PROVIDERS: "openai", OPENAI_API_KEY: "dummy" } },
	"collect-openai-chat": {
		args: ["src/cli/collectSearch.ts", "openai"],
		env: { PROVIDERS: "openai", OPENAI_API_KEY: "dummy", OPENAI_SEARCH_MODEL: "gpt-4.1-mini" },
	},
	"collect-perplexity": {
		args: ["src/cli/collectSearch.ts", "perplexity"],
		env: { PROVIDERS: "perplexity", PERPLEXITY_API_KEY: "dummy" },
	},
};

const args = process.argv.slice(2);
const recordMeta = args.includes("--record-meta");
const selected = args.filter((a) => !a.startsWith("--"));
for (const cli of selected) {
	if (!CLIS[cli]) {
		console.error(`unknown cli ${cli}; known: ${Object.keys(CLIS).join(" ")}`);
		process.exit(2);
	}
}
const run = selected.length ? selected : Object.keys(CLIS);

// --- fixture web server ---------------------------------------------------
// Serves apps/pipeline/test/fixtures/llm-city/www. Two hosts share it: 127.0.0.1 is the
// scraper source, localhost the unverified one (their homepages differ).
const server = createServer((req, res) => {
	const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const isLocalhost = (req.headers.host ?? "").startsWith("localhost");
	const rel =
		pathname === "/"
			? isLocalhost
				? "localhost-index.html"
				: "index.html"
			: `${pathname.replace(/\/$/, "")}.html`;
	const file = resolve(WWW, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
	if (!file.startsWith(WWW) || !existsSync(file)) {
		res.writeHead(404, { "content-type": "text/plain" }).end("not found");
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(readFileSync(file));
});
await new Promise((ok, fail) => {
	server.once("error", fail);
	server.listen(PORT, "127.0.0.1", ok);
});

// --- one CLI --------------------------------------------------------------
mkdirSync(join(tmpdir(), "eventyr-llm-parity"), { recursive: true });
const WORK = realpathSync(join(tmpdir(), "eventyr-llm-parity"));
mkdirSync(GOLDEN, { recursive: true });
mkdirSync(join(FIXTURE, "responses"), { recursive: true });

function normaliseStdout(text, root) {
	// Relative form first: it contains the absolute one.
	return text
		.replaceAll(relative(REPO, root), "$ROOT")
		.replaceAll(root, "$ROOT")
		.replaceAll(REPO, "$REPO");
}

async function runCli(cli) {
	const [script, ...cliArgs] = CLIS[cli].args;
	const root = join(WORK, cli);
	rmSync(root, { recursive: true, force: true });
	cpSync(join(FIXTURE, "data"), join(root, "data"), { recursive: true });
	cpSync(join(FIXTURE, "sources"), join(root, "sources"), { recursive: true });
	const replayDir = join(root, "replay");
	mkdirSync(replayDir, { recursive: true });
	symlinkSync(join(FIXTURE, "responses"), join(replayDir, "responses"));

	const env = {
		...process.env,
		CITY: "brisbane",
		FORCE: "true",
		// Explicit dummies override .env: no key ever reaches a provider.
		GOOGLE_API_KEY: "dummy",
		GOOGLE_MAPS_API_KEY: "",
		ANTHROPIC_API_KEY: "",
		OPENAI_API_KEY: "",
		PERPLEXITY_API_KEY: "",
		EVENTYR_DATA_ROOT: join(root, "data"),
		EVENTYR_SOURCES_ROOT: join(root, "sources"),
		EVENTYR_LLM_REPLAY: "replay",
		EVENTYR_LLM_REPLAY_DIR: replayDir,
		EVENTYR_FAKE_NOW: FAKE_NOW,
		NODE_OPTIONS: `--import=${pathToFileURL(join(REPO, "scripts", "fake-now.mjs")).href}`,
		// Probe's host-level fan-out is I/O parallelism, not model concurrency;
		// serialising it keeps the interleaved per-source log deterministic.
		PROBE_CONCURRENT_HOSTS: "1",
		...(CLIS[cli].env ?? {}),
	};
	const started = Date.now();
	const child = spawn("pnpm", [...TSX, script, ...cliArgs], {
		cwd: REPO,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => {
		stdout += d;
	});
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	const code = await new Promise((ok) => child.on("close", ok));
	const seconds = ((Date.now() - started) / 1000).toFixed(1);

	const requestsPath = join(replayDir, "requests.jsonl");
	const lines = existsSync(requestsPath)
		? readFileSync(requestsPath, "utf-8").split("\n").filter(Boolean)
		: [];
	const sha = (line) => createHash("sha256").update(line).digest("hex");
	const sorted = [...lines].sort((a, b) => sha(a).localeCompare(sha(b)));
	writeFileSync(join(GOLDEN, `${cli}.jsonl`), sorted.map((l) => `${l}\n`).join(""), "utf-8");
	writeFileSync(join(GOLDEN, `${cli}.stdout`), normaliseStdout(stdout, root), "utf-8");

	const problems = [];
	if (code !== 0) problems.push(`exit ${code}`);
	const metaPath = join(replayDir, "requests.meta.json");
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : null;
	const goldenMetaPath = join(GOLDEN, `${cli}.meta.json`);
	if (recordMeta && meta) {
		writeFileSync(goldenMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
	} else if (meta && existsSync(goldenMetaPath)) {
		const golden = JSON.parse(readFileSync(goldenMetaPath, "utf-8"));
		if (meta.calls !== golden.calls) problems.push(`calls ${meta.calls} ≠ golden ${golden.calls}`);
		for (const [provider, peak] of Object.entries(golden.peakInFlight)) {
			const now = meta.peakInFlight[provider] ?? 0;
			if (now < peak) problems.push(`peak in-flight ${provider} ${now} < golden ${peak} — something went serial`);
		}
		if (meta.wallClockMs > golden.wallClockMs * WALL_CLOCK_TOLERANCE) {
			problems.push(`wall-clock ${meta.wallClockMs}ms > golden ${golden.wallClockMs}ms +10%`);
		}
	} else if (!meta) {
		problems.push("no requests.meta.json — the CLI made no model call");
	}
	const missing = new Set(stderr.match(/replay fixture missing: \S+/g) ?? []);
	if (missing.size) problems.push(`${missing.size} missing canned response(s) — see ${join(FIXTURE, "responses")}/*.missing.json`);

	const status = problems.length ? "FAIL" : "ok";
	console.log(
		`${status.padEnd(4)} ${cli.padEnd(18)} ${String(lines.length).padStart(3)} request(s)` +
			(meta
				? `  peak ${Object.entries(meta.peakInFlight).map(([p, n]) => `${p} ${n}`).join(", ")}  wall ${meta.wallClockMs}ms`
				: "") +
			`  ${seconds}s${problems.length ? `\n     ${problems.join("\n     ")}` : ""}`,
	);
	if (problems.length && stderr.trim()) {
		console.log(stderr.trim().split("\n").slice(-25).map((l) => `     | ${l}`).join("\n"));
	}
	return problems.length === 0;
}

let ok = true;
for (const cli of run) ok = (await runCli(cli)) && ok;
server.close();
if (!ok) {
	console.log("\nllm-parity: FAILED");
	process.exit(1);
}
console.log(`\nllm-parity: goldens written to ${relative(REPO, GOLDEN)}; run \`git diff --exit-code ${relative(REPO, GOLDEN)}\``);
