import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const REVIEW_SCHEMA = "agent-market.visual-review.v1";

async function pngFiles(directory) {
  return (await readdir(directory)).filter((file) => file.endsWith(".png")).sort();
}

async function reviewMap(reviewPath) {
  if (!reviewPath) return new Map();
  const document = JSON.parse(await readFile(reviewPath, "utf8"));
  if (document.schemaVersion !== REVIEW_SCHEMA || !Array.isArray(document.reviews)) {
    throw new Error("VISUAL_REVIEW_INVALID");
  }
  return new Map(document.reviews.map((review) => [review.file, review]));
}

export async function compareVisualAudits({ baselineDirectory, candidateDirectory, outputDirectory, reviewPath }) {
  const [baselineFiles, candidateFiles, reviews] = await Promise.all([
    pngFiles(baselineDirectory),
    pngFiles(candidateDirectory),
    reviewMap(reviewPath),
  ]);
  const candidateSet = new Set(candidateFiles);
  const files = baselineFiles.filter((file) => candidateSet.has(file));
  if (files.length === 0) throw new Error("VISUAL_COMPARISON_EMPTY");
  await mkdir(outputDirectory, { recursive: true });

  const comparisons = [];
  for (const file of files) {
    const [baselineBytes, candidateBytes] = await Promise.all([
      readFile(join(baselineDirectory, file)),
      readFile(join(candidateDirectory, file)),
    ]);
    const baseline = PNG.sync.read(baselineBytes);
    const candidate = PNG.sync.read(candidateBytes);
    if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
      comparisons.push({ file, status: "dimension-mismatch", baseline: [baseline.width, baseline.height], candidate: [candidate.width, candidate.height] });
      continue;
    }
    const diff = new PNG({ width: baseline.width, height: baseline.height });
    const diffPixels = pixelmatch(baseline.data, candidate.data, diff.data, baseline.width, baseline.height, {
      threshold: 0.1,
      includeAA: false,
    });
    const changed = diffPixels > 0;
    const review = reviews.get(file);
    const reviewStatus = changed ? review?.status ?? "unreviewed" : "not-required";
    if (changed) await writeFile(join(outputDirectory, file), PNG.sync.write(diff));
    comparisons.push({
      file,
      status: "compared",
      width: baseline.width,
      height: baseline.height,
      diffPixels,
      diffRatio: diffPixels / (baseline.width * baseline.height),
      reviewStatus,
      reviewReason: typeof review?.reason === "string" ? review.reason : null,
    });
  }

  const missingBaseline = candidateFiles.filter((file) => !baselineFiles.includes(file));
  const missingCandidate = baselineFiles.filter((file) => !candidateFiles.includes(file));
  const failed = comparisons.some((entry) =>
    entry.status === "dimension-mismatch"
    || entry.reviewStatus === "unreviewed"
    || entry.reviewStatus === "rejected",
  ) || missingBaseline.length > 0 || missingCandidate.length > 0;
  const summary = { schemaVersion: "agent-market.visual-comparison.v1", files: files.length, missingBaseline, missingCandidate, failed, comparisons };
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baselineDirectory = process.env.AGENT_MARKET_VISUAL_BASELINE;
  const candidateDirectory = process.env.AGENT_MARKET_VISUAL_CANDIDATE;
  const outputDirectory = process.env.AGENT_MARKET_VISUAL_DIFF;
  if (!baselineDirectory || !candidateDirectory || !outputDirectory) {
    throw new Error("AGENT_MARKET_VISUAL_BASELINE, AGENT_MARKET_VISUAL_CANDIDATE and AGENT_MARKET_VISUAL_DIFF are required");
  }
  const summary = await compareVisualAudits({
    baselineDirectory,
    candidateDirectory,
    outputDirectory,
    reviewPath: process.env.AGENT_MARKET_VISUAL_REVIEW,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed) process.exitCode = 1;
}
