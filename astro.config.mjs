import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	integrations: [react()],
	output: "static",
	outDir: "./dist",
	site: "https://www.dothings.lol",
	vite: {
		resolve: {
			alias: {
				"@react": fileURLToPath(new URL("./app", import.meta.url)),
			},
		},
	},
});
