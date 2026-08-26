import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommitteePage } from "./ControlPages";

describe("committee demo feedback", () => {
  it("renders an explicit local-only acknowledgement after declaring no conflict", () => {
    const markup = renderToStaticMarkup(<CommitteePage initialConflictStatus="declared" walletAddress={null} />);

    expect(markup).toContain("Conflict declaration recorded locally");
    expect(markup).toContain("No vote or blockchain transaction was submitted");
    expect(markup).toContain("disabled");
  });

  it("keeps voting wallet-gated and delegates committee membership to the server", () => {
    const markup = renderToStaticMarkup(<CommitteePage initialConflictStatus="declared" walletAddress={null} />);
    expect(markup).toContain("Committee membership is checked server-side");
    expect(markup).toContain("Cast Sepolia vote");
    expect(markup).toContain("Recheck RPC receipt");
  });
});
