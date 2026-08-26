import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommitteePage } from "./ControlPages";

describe("committee demo feedback", () => {
  it("renders an explicit local-only acknowledgement after declaring no conflict", () => {
    const markup = renderToStaticMarkup(<CommitteePage initialConflictStatus="declared" />);

    expect(markup).toContain("Conflict declaration recorded locally");
    expect(markup).toContain("No vote or blockchain transaction was submitted");
    expect(markup).toContain("disabled");
  });
});
