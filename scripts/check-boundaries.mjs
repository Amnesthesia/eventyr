#!/usr/bin/env node
// Enforces the workspace package graph in docs/monorepo/PLAN.md §2.3. Fails,
// naming the file and the offending specifier or dependency, when:
//   - a package.json lists a `workspace:` dependency the table does not allow;
//   - a relative import resolves into a different package root (packages/*,
//     apps/*, workers/*, or the root package, which is everything else):
//     cross-package access goes through the package name;
//   - an import reaches past a package's `exports` (`@dothingslol/x/src/...`).
// Plain Node, no dependencies, so it runs before anything else is trusted.
//
// ponytail: imports are found with a regex, not a parser. Good enough for
// ESM import/export/import()/require() with string literals; a specifier
// built at runtime is invisible to it. Use a real parser if that ever matters.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// PLAN §2.3, keyed by package name. Only packages that exist are listed, and
// an unlisted package fails. Later sub-phases add rows; they never loosen one.
const ALLOWED = {
	// The root package is still web + pipeline until 1.9/1.10 move them into
	// apps/, so it carries the pipeline's row (the wider of the two).
	eventyr: [
		"@dothingslol/core",
		"@dothingslol/utils",
		"@dothingslol/llm",
		"@dothingslol/scraper",
	],
	"@dothingslol/web": ["@dothingslol/core", "@dothingslol/utils"],
	"@dothingslol/pipeline": ["@dothingslol/core", "@dothingslol/utils", "@dothingslol/llm", "@dothingslol/scraper"],
	"@dothingslol/utils": [],
	"@dothingslol/core": ["@dothingslol/utils"],
	"@dothingslol/llm": ["@dothingslol/utils"],
	"@dothingslol/scraper": ["@dothingslol/core", "@dothingslol/utils"],
	// workers/mcp; becomes apps/mcp (@dothingslol/mcp) in 1.12.
	"eventyr-mcp": ["@dothingslol/core", "@dothingslol/utils"],
};

const PACKAGE_PARENTS = ["packages", "apps", "workers"];
// Plus every dot-directory (.git, .astro, .wrangler).
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const SOURCE_FILE = /\.(ts|tsx|astro|mjs|js)$/;
const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const IMPORT_RE =
	/\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)|\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));
const errors = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);

// Package roots, keyed by their path relative to ROOT ("" is the root package).
const packages = new Map([["", { dir: ROOT, json: readJson(join(ROOT, "package.json")) }]]);
for (const parent of PACKAGE_PARENTS) {
	if (!existsSync(join(ROOT, parent))) continue;
	for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
		const dir = join(ROOT, parent, entry.name);
		if (entry.isDirectory() && existsSync(join(dir, "package.json"))) {
			packages.set(`${parent}/${entry.name}`, { dir, json: readJson(join(dir, "package.json")) });
		}
	}
}
const byName = new Map([...packages.values()].map((p) => [p.json.name, p]));

/** The package root (key of `packages`) that owns an absolute path, or null
 * when the path is outside the repo. */
function ownerOf(abs) {
	const rel = relative(ROOT, abs);
	if (rel.startsWith("..")) return null;
	const [parent, child] = rel.split(sep);
	return PACKAGE_PARENTS.includes(parent) && packages.has(`${parent}/${child}`)
		? `${parent}/${child}`
		: "";
}

// 1. Workspace dependencies against the table.
for (const [key, { json }] of packages) {
	const file = join(key, "package.json");
	const allowed = ALLOWED[json.name];
	if (!allowed) {
		fail(file, `package "${json.name}" is not in the dependency table (PLAN §2.3)`);
		continue;
	}
	for (const field of DEP_FIELDS) {
		for (const [dep, version] of Object.entries(json[field] ?? {})) {
			if (String(version).startsWith("workspace:") && !allowed.includes(dep)) {
				fail(file, `${field} "${dep}" is not an allowed dependency of ${json.name}`);
			}
		}
	}
}

/** Where `sub` ("./shared") lands through a package's exports map, or null. */
function resolveExport(exportsMap, sub) {
	const map = typeof exportsMap === "string" ? { ".": exportsMap } : (exportsMap ?? {});
	for (const [key, value] of Object.entries(map)) {
		const target = typeof value === "string" ? value : Object.values(value).find((v) => typeof v === "string");
		if (!target) continue;
		if (key === sub) return target;
		const star = key.indexOf("*");
		if (star === -1) continue;
		const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
		if (sub.startsWith(prefix) && sub.endsWith(suffix) && sub.length >= key.length - 1) {
			return target.replace("*", sub.slice(prefix.length, sub.length - suffix.length));
		}
	}
	return null;
}

// 2 and 3. Every import in every source file.
function checkImport(file, specifier) {
	const relFile = relative(ROOT, file);
	if (specifier.startsWith(".")) {
		const from = ownerOf(file);
		const to = ownerOf(resolve(dirname(file), specifier));
		if (from === to) return;
		const target = to === null ? "outside the repo" : `into ${to || "the root package"}`;
		fail(relFile, `"${specifier}" reaches ${target}; import it by package name`);
		return;
	}
	const m = /^(@dothingslol\/[^/]+)(?:\/(.*))?$/.exec(specifier);
	if (!m) return;
	const [, name, rest] = m;
	const pkg = byName.get(name);
	if (!pkg) return fail(relFile, `"${specifier}": no workspace package is called ${name}`);
	if (rest?.startsWith("src/")) {
		return fail(relFile, `"${specifier}" reaches into ${name}'s internals; use an exports entry`);
	}
	const target = resolveExport(pkg.json.exports, rest ? `./${rest}` : ".");
	if (!target) return fail(relFile, `"${specifier}" is not in ${name}'s exports`);
	if (!existsSync(join(pkg.dir, target))) {
		fail(relFile, `"${specifier}" maps to ${target}, which does not exist (no .ts on package specifiers)`);
	}
}

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path);
		else if (SOURCE_FILE.test(entry.name)) {
			for (const m of readFileSync(path, "utf-8").matchAll(IMPORT_RE)) {
				checkImport(path, m[1] ?? m[2] ?? m[3]);
			}
		}
	}
}
walk(ROOT);

if (errors.length) {
	console.error(`check-boundaries: ${errors.length} violation(s)\n${errors.map((e) => `  ${e}`).join("\n")}`);
	process.exit(1);
}
console.log(`check-boundaries: ${packages.size} packages, graph OK`);
