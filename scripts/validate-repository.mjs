import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
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

const AWS_DEPLOY_GATES = new Map([
	["deploy", new Set(["scripts/aws/deploy-agent-market.sh"])],
	["create-change-set", new Set(["scripts/aws/prepare-agent-market-cluster-transition.sh"])],
	["execute-change-set", new Set(["scripts/aws/prepare-agent-market-cluster-transition.sh"])],
	["update-stack", new Set()],
]);
const SOURCE_EXTENSIONS = new Set([".sh", ".yml", ".yaml", ".js", ".mjs", ".cjs", ".ts", ".py"]);
const EXCLUDED_DIRECTORIES = new Set([".git", ".next", ".pnpm-store", ".tc-flow", "coverage", "dist", "node_modules"]);
const AWS_FLAG_OPTIONS = new Set([
	"--debug", "--no-sign-request", "--no-verify-ssl", "--no-cli-pager", "--no-paginate",
	"--cli-auto-prompt", "--no-cli-auto-prompt",
]);
const AWS_VALUE_OPTIONS = new Set([
	"--profile", "--region", "--endpoint-url", "--ca-bundle", "--cli-connect-timeout",
	"--cli-read-timeout", "--output", "--query", "--color", "--cli-binary-format",
]);

function extension(path) {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot);
}

function isProductionSource(path) {
	const normalized = path.replaceAll("\\", "/");
	if (/(?:^|\/)(?:test|tests|fixtures?)(?:\/|$)/u.test(normalized)) return false;
	if (/\.(?:test|spec)\.[^.]+$/u.test(normalized)) return false;
	return basename(path) === "Makefile" || SOURCE_EXTENSIONS.has(extension(path));
}

function productionFiles(root) {
	const found = [];
	function walk(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(resolve(directory, entry.name));
			} else if (entry.isFile()) {
				const path = resolve(directory, entry.name);
				if (isProductionSource(relative(root, path))) found.push(path);
			}
		}
	}
	walk(root);
	return found.sort((left, right) => {
		const rank = (path) => path.includes("/scripts/") ? 0 : basename(path) === "Makefile" ? 2 : 1;
		return rank(left) - rank(right) || left.localeCompare(right);
	});
}

function withoutComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//gu, (value) => value.replace(/[^\n]/gu, " "))
		.replace(/^\s*(?:#|\/\/).*$/gmu, (value) => " ".repeat(value.length));
}

function commandMatches(source) {
	const clean = withoutComments(source.replace(/\\\r?\n/gu, "  "));
	const tokens = [...clean.matchAll(/[A-Za-z0-9_.:/-]+/gu)].map((match) => ({
		value: match[0].toLowerCase(),
		index: match.index,
	}));
	const matches = [];
	const parseOptions = (start) => {
		let cursor = start;
		while (cursor < tokens.length) {
			if (AWS_FLAG_OPTIONS.has(tokens[cursor].value)) { cursor += 1; continue; }
			if (AWS_VALUE_OPTIONS.has(tokens[cursor].value) && cursor + 1 < tokens.length) { cursor += 2; continue; }
			if (tokens[cursor].value.startsWith("--")) return { cursor, unknownOption: tokens[cursor].value };
			break;
		}
		return { cursor };
	};
	for (let index = 0; index < tokens.length; index += 1) {
		if (tokens[index].value !== "aws") continue;
		const globalOptions = parseOptions(index + 1);
		const line = clean.slice(0, tokens[index].index).split("\n").length;
		if (globalOptions.unknownOption !== undefined) {
			const hasStaticCloudFormation = tokens.slice(globalOptions.cursor + 1, globalOptions.cursor + 65)
				.some((token) => token.value === "cloudformation");
			if (hasStaticCloudFormation) matches.push({ unknownOption: globalOptions.unknownOption, line });
			continue;
		}
		const cloudformationIndex = globalOptions.cursor;
		if (tokens[cloudformationIndex]?.value !== "cloudformation") continue;
		const serviceOptions = parseOptions(cloudformationIndex + 1);
		if (serviceOptions.unknownOption !== undefined) {
			matches.push({ unknownOption: serviceOptions.unknownOption, line });
			continue;
		}
		const actionIndex = serviceOptions.cursor;
		const action = tokens[actionIndex];
		if (action === undefined || AWS_DEPLOY_GATES.has(action.value) === false) continue;
		matches.push({ action: action.value, line });
	}
	return matches;
}

export function validateAwsDeployPolicy(root) {
	const violations = [];
	for (const absolute of productionFiles(root)) {
		const path = relative(root, absolute).replaceAll("\\", "/");
		for (const { action, line, unknownOption } of commandMatches(readFileSync(absolute, "utf8"))) {
			if (unknownOption !== undefined) {
				violations.push("aws-cloudformation-unknown-option:" + path + ":" + line + ":" + unknownOption);
				continue;
			}
			if (!AWS_DEPLOY_GATES.get(action).has(path)) {
				violations.push("aws-" + action + "-command-outside-gate:" + path + ":" + line);
			}
		}
	}
	return violations;
}

export function validateRepository(root) {
	const directoryViolations = REQUIRED_DIRECTORIES
		.filter((path) => !existsSync(resolve(root, path)))
		.map((path) => "required-directory-missing:" + path);
	return [...directoryViolations, ...validateAwsDeployPolicy(root)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const violations = validateRepository(process.cwd());
	if (violations.length > 0) {
		console.error(violations.join("\n"));
		process.exitCode = 1;
	}
}
