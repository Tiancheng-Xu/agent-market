import { expect, it } from "vitest";
import { activeNavigationPath } from "./navigation";

const paths = ["/", "/agents", "/agents/local", "/tasks", "/office"];
const cases: Array<[string, string | undefined]> = [
  ["/", "/"], ["/agents/local", "/agents/local"], ["/agents/local/", "/agents/local"],
  ["/agents/register", "/agents"], ["/agents/local/session", "/agents/local"],
  ["/tasks/example/workspace", "/tasks"], ["/office", "/office"],
  ["/AGENTS/LOCAL", "/agents/local"], ["/agents-other", undefined], ["/unknown", undefined],
];
it.each(cases)("selects exactly the intended navigation section for %s", (path, expected) => {
  expect(activeNavigationPath(path, paths)).toBe(expected);
  expect(activeNavigationPath(path, [...paths].reverse())).toBe(expected);
});
