import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git")) {
	execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
		stdio: "inherit",
	});
}
