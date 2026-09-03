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
			// One React instance, always. app/ sits outside Astro's src/, and its
			// modules are reached both through the @react alias and through
			// relative paths from .astro files — enough for Vite to end up with two
			// module graphs and therefore two copies of React. The symptom is
			// "Invalid hook call" pointing at whichever hook runs first
			// (useColorTheme, here), not at anything actually wrong with the hook.
			dedupe: ["react", "react-dom", "react/jsx-runtime"],
		},
		css: {
			preprocessorOptions: {
				scss: {
					silenceDeprecations: ["if-function"],
				},
			},
		},
	},
});
