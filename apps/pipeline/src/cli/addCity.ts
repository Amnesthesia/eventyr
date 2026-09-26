import { requireEnv } from "../config/env.js";
import { addCity } from "../sources/addCity.js";

async function main(): Promise<void> {
	await addCity(console, {
		cityName: requireEnv("CITY_NAME"),
		cityKey: requireEnv("CITY_KEY"),
		cityTimezone: requireEnv("CITY_TIMEZONE"),
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
