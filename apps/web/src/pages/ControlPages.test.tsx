import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommitteePage } from "./ControlPages";

describe("V3 platform final arbitration feedback", () => {
  it("renders an explicit local-only acknowledgement after platform review", () => {
    const markup = renderToStaticMarkup(<CommitteePage initialConflictStatus="declared" walletAddress={null} />);

    expect(markup).toContain("Platform review recorded locally");
    expect(markup).toContain("No resolution or blockchain transaction was submitted");
    expect(markup).toContain("disabled");
  });

  it("keeps final resolution wallet-gated and delegates the sole arbiter role to the server", () => {
    const markup = renderToStaticMarkup(<CommitteePage initialConflictStatus="declared" walletAddress={null} />);
    expect(markup).toContain("configured platform arbiter wallet");
    expect(markup).toContain("Resolve on Sepolia");
    expect(markup).toContain("Recheck RPC receipt");
  });
});
