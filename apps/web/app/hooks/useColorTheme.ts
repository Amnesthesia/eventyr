import { useState } from "react";

export function useColorTheme() {
	const [theme, setTheme] = useState<"light" | "dark">(() => {
		if (typeof localStorage === "undefined") return "light";
		const saved = localStorage.getItem("theme");
		if (saved === "dark" || saved === "light") return saved;
		return typeof window !== "undefined" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	});

	function toggle() {
		const next = theme === "dark" ? "light" : "dark";
		document.documentElement.setAttribute("data-theme", next);
		localStorage.setItem("theme", next);
		setTheme(next);
	}

	return { theme, toggle };
}
