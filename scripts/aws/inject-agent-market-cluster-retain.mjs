import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function fail(code) {
  throw new Error(code);
}

function records(source) {
  const result = [];
  let cursor = 0;
  while (cursor < source.length) {
    const lf = source.indexOf("\n", cursor);
    if (lf === -1) {
      result.push({ start: cursor, end: source.length, content: source.slice(cursor), eol: "" });
      break;
    }
    const hasCr = lf > cursor && source[lf - 1] === "\r";
    result.push({
      start: cursor,
      end: lf + 1,
      content: source.slice(cursor, hasCr ? lf - 1 : lf),
      eol: hasCr ? "\r\n" : "\n",
    });
    cursor = lf + 1;
  }
  return result;
}

export function injectRetainPolicies(source) {
  if (typeof source !== "string" || source.length === 0) fail("TEMPLATE_BODY_EMPTY");
  if (source.includes("\t")) fail("TABS_NOT_ALLOWED");
  if (/\r(?!\n)/u.test(source)) fail("BARE_CR_NOT_ALLOWED");

  const lines = records(source);
  const resources = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.content === "Resources:");
  if (resources.length !== 1) fail("RESOURCES_SECTION_MATCH_COUNT");

  const resourcesIndex = resources[0].index;
  let resourcesEnd = lines.length;
  for (let index = resourcesIndex + 1; index < lines.length; index += 1) {
    const content = lines[index].content;
    if (content !== "" && !/^\s*#/u.test(content) && /^[^ ]/u.test(content)) {
      resourcesEnd = index;
      break;
    }
  }

  const candidates = [];
  for (let index = resourcesIndex + 1; index < resourcesEnd; index += 1) {
    if (/^ +PerformanceCluster:\s*$/u.test(lines[index].content)) candidates.push(index);
  }
  if (candidates.length !== 1) fail("PERFORMANCE_CLUSTER_MATCH_COUNT");
  const targetIndex = candidates[0];
  const target = lines[targetIndex];
  if (target.content !== "  PerformanceCluster:") fail("PERFORMANCE_CLUSTER_INDENTATION_INVALID");
  if (target.eol === "") fail("PERFORMANCE_CLUSTER_BLOCK_TRUNCATED");

  let blockEnd = resourcesEnd;
  for (let index = targetIndex + 1; index < resourcesEnd; index += 1) {
    if (/^  [A-Za-z0-9][A-Za-z0-9._-]*:\s*$/u.test(lines[index].content)) {
      blockEnd = index;
      break;
    }
  }
  const block = lines.slice(targetIndex + 1, blockEnd);
  const typeLines = block.filter(({ content }) => content.trim() === "Type: AWS::ECS::Cluster");
  if (typeLines.length !== 1 || typeLines[0].content !== "    Type: AWS::ECS::Cluster") {
    fail("PERFORMANCE_CLUSTER_TYPE_INVALID");
  }
  if (block.some(({ content }) => /^\s*(?:DeletionPolicy|UpdateReplacePolicy):/u.test(content))) {
    fail("PERFORMANCE_CLUSTER_POLICY_CONFLICT");
  }

  const insertion = `    DeletionPolicy: Retain${target.eol}    UpdateReplacePolicy: Retain${target.eol}`;
  const insertAt = target.end;
  const transformed = source.slice(0, insertAt) + insertion + source.slice(insertAt);
  const restored = transformed.slice(0, insertAt) + transformed.slice(insertAt + insertion.length);
  if (restored !== source) fail("BYTE_INVARIANT_FAILED");
  return transformed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) fail("USAGE_INPUT_OUTPUT_REQUIRED");
  const source = readFileSync(input, "utf8");
  writeFileSync(output, injectRetainPolicies(source));
}
