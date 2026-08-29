import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../apps/web/public/office-cocos/", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Cocos office artifact contains a real responsive runtime build", async () => {
  const [settingsText, configText, sceneImport, index, style, runtimeIndex, officeRuntime, background, atlas, atlasBytes, webpBackground, webpAtlas] = await Promise.all([
    read("src/settings.json"),
    read("assets/main/config.json"),
    read("assets/main/import/e4/e4f83b65-2b89-4c40-9e64-798b3380272d.json"),
    read("index.html"),
    read("style.css"),
    read("index.js"),
    read("src/office-runtime.js"),
    stat(new URL("art/starbuddy-office-background.png", root)),
    stat(new URL("art/starbuddy-agent-atlas.png", root)),
    readFile(new URL("art/starbuddy-agent-atlas.png", root)),
    stat(new URL("art/starbuddy-office-background.webp", root)),
    stat(new URL("art/starbuddy-agent-atlas.webp", root)),
  ]);
  const settings = JSON.parse(settingsText);
  const config = JSON.parse(configText);

  assert.equal(settings.CocosEngine, "3.8.8");
  assert.equal(settings.launch?.launchScene, "");
  assert.equal(settings.splashScreen?.logo?.type, "none");
  assert.ok(Array.isArray(settings.scripting?.scriptPackages));
  assert.ok(settings.scripting.scriptPackages.length > 0);
  assert.ok(Array.isArray(config.uuids));
  assert.ok(config.uuids.length > 0);
  assert.match(sceneImport, /7ab4cPSHl9KkLjHbV5POisc/);
  assert.match(index, /cc_exact_fit_screen="true"/);
  assert.match(index, /style="width: 100%; height: 100%;"/);
  assert.match(index, /rel="preload" as="image" type="image\/webp" href="\/office-cocos\/art\/starbuddy-office-background\.webp" fetchpriority="high"/);
  assert.match(index, /rel="preload" as="image" type="image\/webp" href="\/office-cocos\/art\/starbuddy-agent-atlas\.webp" fetchpriority="high"/);
  assert.match(style, /agent-market-responsive-office/);
  assert.match(runtimeIndex, /office-runtime\.js/);
  assert.match(officeRuntime, /agent-market\.office\.ready\.v2/);
  assert.match(officeRuntime, /agent-market\.office\.snapshot\.v2/);
  assert.match(officeRuntime, /activityColumn/);
  assert.match(officeRuntime, /starbuddy-agent-atlas\.webp/);
  assert.match(officeRuntime, /agent-market\.office\.degraded\.v2/);
  assert.doesNotMatch(officeRuntime, /\.finally\(function \(\) \{\s*window\.parent\.postMessage\(\{ type: "agent-market\.office\.ready\.v2"/);
  assert.match(officeRuntime, /setContentSize\(76, 76\)/);
  assert.match(officeRuntime, /sprite\.sizeMode = cc\.Sprite\.SizeMode\.CUSTOM;\s*node\.getComponent\(cc\.UITransform\)\.setContentSize\(76, 76\)/);
  assert.ok(background.size > 100_000);
  assert.ok(atlas.size > 100_000);
  assert.ok(atlasBytes[25] === 4 || atlasBytes[25] === 6, "StarBuddy atlas must contain a PNG alpha channel");
  assert.ok(webpBackground.size < 300_000, "Optimized office background must stay below 300 KB");
  assert.ok(webpAtlas.size < 600_000, "Optimized agent atlas must stay below 600 KB");
});
