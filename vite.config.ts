/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = process.cwd();

const moveIndex = {
	name: "move-index",
	closeBundle() {
		const src = path.join(projectRoot, "dist", "index.html");
		const dest = path.join(projectRoot, "index.html");
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, dest);
			fs.unlinkSync(src);
		}
	},
};

// Serve data/ and *.ics from project root during dev
const serveProjectFiles = {
	name: "serve-project-files",
	configureServer(server: import("vite").ViteDevServer) {
		server.middlewares.use((req, res, next) => {
			const url = (req.url ?? "").split("?")[0];
			if (url.startsWith("/data/") || /\/[^/]+\.ics$/.test(url)) {
				const filePath = path.join(projectRoot, url);
				if (fs.existsSync(filePath)) {
					const content = fs.readFileSync(filePath);
					res.setHeader(
						"Content-Type",
						url.endsWith(".json")
							? "application/json"
							: "text/calendar; charset=utf-8",
					);
					res.end(content);
					return;
				}
			}
			next();
		});
	},
};

export default defineConfig(({ command }) => ({
	root: "app",
	plugins: [
		react(),
		serveProjectFiles,
		...(command === "build" ? [moveIndex] : []),
	],
	base: command === "build" ? "/dist/" : "/",
	build: {
		outDir: path.join(projectRoot, "dist"),
		assetsDir: "assets",
		emptyOutDir: true,
	},
}));
