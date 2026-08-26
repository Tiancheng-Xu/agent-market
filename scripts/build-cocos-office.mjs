import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = resolve(root, "apps/office-cocos");
const output = resolve(project, "build/web-desktop-001");
const publicOutput = resolve(root, "apps/web/public/office-cocos");
const settingsPath = resolve(output, "src/settings.json");
const mainConfigPath = resolve(output, "assets/main/config.json");
const sceneImportPath = resolve(output, "assets/main/import/e4/e4f83b65-2b89-4c40-9e64-798b3380272d.json");

function requireFile(path, description) {
  if (!existsSync(path)) {
    throw new Error(`${description} is missing. Build web-desktop-001 from the Cocos Creator GUI before packaging.`);
  }
}

requireFile(settingsPath, "Cocos settings");
requireFile(mainConfigPath, "Cocos main bundle config");
requireFile(sceneImportPath, "Cocos OfficeScene import");

const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const mainConfig = JSON.parse(readFileSync(mainConfigPath, "utf8"));
const sceneImport = readFileSync(sceneImportPath, "utf8");

if (settings.CocosEngine !== "3.8.8") {
  throw new Error(`Expected Cocos Creator 3.8.8 output, received ${settings.CocosEngine ?? "unknown"}.`);
}
if (!Array.isArray(mainConfig.uuids) || mainConfig.uuids.length === 0) {
  throw new Error("Cocos main bundle contains no scene UUIDs; refusing to publish an empty build.");
}
if (!Array.isArray(settings.scripting?.scriptPackages) || settings.scripting.scriptPackages.length === 0) {
  throw new Error("Cocos output contains no script package; refusing to publish a non-interactive office.");
}
if (!sceneImport.includes("7ab4cPSHl9KkLjHbV5POisc")) {
  throw new Error("Cocos output does not contain the OfficeScene component identity.");
}

settings.splashScreen = {
  ...(settings.splashScreen ?? {}),
  totalTime: 0,
  logo: { type: "none" },
};
settings.launch = {
  ...(settings.launch ?? {}),
  launchScene: "",
};
writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`);

const indexPath = resolve(output, "index.html");
const stylePath = resolve(output, "style.css");
let index = readFileSync(indexPath, "utf8");
index = index.replace(
  /<div id="GameDiv"[^>]*>/,
  '<div id="GameDiv" cc_exact_fit_screen="true" style="width: 100%; height: 100%;">',
);
writeFileSync(indexPath, index);

const responsiveMarker = "/* agent-market-responsive-office */";
let style = readFileSync(stylePath, "utf8");
if (!style.includes(responsiveMarker)) {
  style += `\n${responsiveMarker}\nhtml, body {\n  width: 100%;\n  height: 100%;\n  overflow: hidden;\n  background: #07101f;\n}\n.header, .footer { display: none; }\n#GameDiv {\n  width: 100% !important;\n  height: 100% !important;\n  margin: 0;\n  border: 0;\n  border-radius: 0;\n  box-shadow: none;\n}\n`;
  writeFileSync(stylePath, style);
}

cpSync(resolve(project, "runtime/office-runtime.js"), resolve(output, "src/office-runtime.js"), { force: true });
cpSync(resolve(project, "runtime/index.js"), resolve(output, "index.js"), { force: true });
cpSync(output, publicOutput, { recursive: true, force: true });

console.log(JSON.stringify({
  creatorVersion: settings.CocosEngine,
  validatedSceneUuids: mainConfig.uuids.length,
  scriptPackages: settings.scripting.scriptPackages.length,
  splashScreen: "none",
  sceneMode: "programmatic-cocos-scene-with-gui-assets",
  responsiveHost: true,
  output: "apps/web/public/office-cocos",
}, null, 2));
