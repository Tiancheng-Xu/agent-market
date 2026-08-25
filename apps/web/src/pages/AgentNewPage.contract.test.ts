import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Agent registration form lifecycle", () => {
  it("retains the form element before asynchronous IndexedDB work", () => {
    const source = readFileSync(new URL("./DirectoryPages.tsx", import.meta.url), "utf8");
    expect(source).toContain("const formElement = event.currentTarget;");
    expect(source).toContain("const form = new FormData(formElement);");
    expect(source).toContain("formElement.reset();");
    expect(source).not.toContain("event.currentTarget.reset();");
  });
});
