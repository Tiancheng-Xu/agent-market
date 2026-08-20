import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_DIRECTORIES = [
	"apps/web",
	"apps/transaction-engine",
	"packages/shared-contracts",
	"packages/contracts",
	"services/matcher-go",
	"services/trainer",
	"docs/evidence",
];

export function validateRepository(root) {
	return REQUIRED_DIRECTORIES
		.filter((path) => !existsSync(resolve(root, path)))
		.map((path) => `required-directory-missing:${path}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const violations = validateRepository(process.cwd());
	if (violations.length > 0) {
		console.error(violations.join("\n"));
		process.exitCode = 1;
	}
}
