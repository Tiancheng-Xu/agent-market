import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { StakingPage, WorkspacePage } from "./WorkflowPages";

describe("staking page", () => {
  it("keeps wallet actions disabled without a connected owner and explains receipt verification", () => {
    const markup = renderToStaticMarkup(<StakingPage walletAddress={null} />);
    expect(markup).toContain("Stake test YD");
    expect(markup).toContain("Recheck RPC receipt");
    expect(markup).toContain("disabled");
    expect(markup).toContain("not a real return");
  });
});

describe("virtual office identity boundary", () => {
  it("keeps anonymous visitors out of owner-only node data and downloads", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><WorkspacePage walletAddress={null} /></MemoryRouter>);
    expect(markup).toContain("Visitor mode");
    expect(markup).not.toContain("Authorized node boundary");
    expect(markup).not.toContain("Download my result");
    expect(markup).not.toContain("Latest private node output");
  });
});
