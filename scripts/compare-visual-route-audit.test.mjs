import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PNG } from "pngjs";

import { compareVisualAudits } from "./compare-visual-route-audit.mjs";

function image(changed = false) {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(0);
  if (changed) png.data.set([255, 255, 255, 255], 0);
  return PNG.sync.write(png);
}

test("requires explicit human review for every changed screenshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-market-visual-"));
  const baselineDirectory = join(root, "baseline");
  const candidateDirectory = join(root, "candidate");
  const outputDirectory = join(root, "diff");
  await Promise.all([
    import("node:fs/promises").then(({ mkdir }) => mkdir(baselineDirectory)),
    import("node:fs/promises").then(({ mkdir }) => mkdir(candidateDirectory)),
  ]);
  await Promise.all([
    writeFile(join(baselineDirectory, "home.png"), image()),
    writeFile(join(candidateDirectory, "home.png"), image(true)),
  ]);

  const pending = await compareVisualAudits({ baselineDirectory, candidateDirectory, outputDirectory });
  assert.equal(pending.failed, true);
  assert.equal(pending.comparisons[0].reviewStatus, "unreviewed");

  const reviewPath = join(root, "review.json");
  await writeFile(reviewPath, JSON.stringify({
    schemaVersion: "agent-market.visual-review.v1",
    reviews: [{ file: "home.png", status: "approved", reason: "Expected trust section" }],
  }));
  const approved = await compareVisualAudits({ baselineDirectory, candidateDirectory, outputDirectory, reviewPath });
  assert.equal(approved.failed, false);
  assert.equal(approved.comparisons[0].reviewStatus, "approved");
});

test("fails closed when baseline and candidate file sets differ", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-market-visual-"));
  const baselineDirectory = join(root, "baseline");
  const candidateDirectory = join(root, "candidate");
  const outputDirectory = join(root, "diff");
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([mkdir(baselineDirectory), mkdir(candidateDirectory)]);
  await Promise.all([
    writeFile(join(baselineDirectory, "home.png"), image()),
    writeFile(join(candidateDirectory, "home.png"), image()),
    writeFile(join(candidateDirectory, "local.png"), image()),
  ]);
  const summary = await compareVisualAudits({ baselineDirectory, candidateDirectory, outputDirectory });
  assert.equal(summary.failed, true);
  assert.deepEqual(summary.missingBaseline, ["local.png"]);
});
