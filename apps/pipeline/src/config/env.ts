export function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) throw new Error(`${name} env var is required`);
	return val;
}
