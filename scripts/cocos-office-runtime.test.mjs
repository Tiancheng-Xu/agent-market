import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../apps/office-cocos/runtime/office-runtime.js", import.meta.url), "utf8");
const exports = {};
runInNewContext(source, {
  System: {
    register(_dependencies, declare) {
      declare((name, value) => { exports[name] = value; }).execute();
    },
  },
});

function engine(width, height) {
  const calls = [];
  const root = {
    mainWindow: { width: 759, height: 618 },
    resize(nextWidth, nextHeight) {
      calls.push([nextWidth, nextHeight]);
      this.mainWindow.width = nextWidth;
      this.mainWindow.height = nextHeight;
    },
  };
  return { cc: { director: { root }, screen: { windowSize: { width, height } } }, calls, root };
}

test("synchronizes an existing render window with the resized iframe canvas", () => {
  const { cc, calls, root } = engine(356, 222);
  assert.equal(exports.syncOfficeViewport(cc), true);
  assert.deepEqual(calls, [[356, 222]]);
  assert.deepEqual(root.mainWindow, { width: 356, height: 222 });
});

test("does not resize an already synchronized render window", () => {
  const { cc, calls } = engine(759, 618);
  assert.equal(exports.syncOfficeViewport(cc), false);
  assert.deepEqual(calls, []);
});

test("ignores hidden and invalid sizes without allocating graphics targets", () => {
  for (const [width, height] of [[0, 222], [356, 0], [-1, 100], [Infinity, 100], [100, NaN]]) {
    const { cc, calls } = engine(width, height);
    assert.equal(exports.syncOfficeViewport(cc), false);
    assert.deepEqual(calls, []);
  }
});

test("waits for the engine render window instead of initializing an extra one", () => {
  assert.equal(exports.syncOfficeViewport({ director: {}, screen: { windowSize: { width: 356, height: 222 } } }), false);
  assert.equal(exports.syncOfficeViewport({ director: { root: {} }, screen: {} }), false);
});

test("published runtime is generated from the editable runtime source", async () => {
  const published = await readFile(new URL("../apps/web/public/office-cocos/src/office-runtime.js", import.meta.url), "utf8");
  assert.equal(published, source);
});
