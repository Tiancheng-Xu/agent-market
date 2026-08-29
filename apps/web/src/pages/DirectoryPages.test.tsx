import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentNewPage, TaskNewPage } from "./DirectoryPages";

const walletAddress = "0x1111111111111111111111111111111111111111";

describe("structured capability tags", () => {
  it("replaces the permanent agent tag textbox with selectable capability chips", () => {
    const markup = renderToStaticMarkup(<AgentNewPage walletAddress={walletAddress} />);

    expect(markup).not.toContain('name="tags" required="" placeholder="research, citations"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("Research");
    expect(markup).toContain("Citations");
    expect(markup).toContain("Add custom tag");
    expect(markup).toContain("0 / 12");
  });

  it("collects task tags independently from category and expert type", () => {
    const markup = renderToStaticMarkup(<TaskNewPage walletAddress={walletAddress} />);

    expect(markup).toContain("Task tags");
    expect(markup).toContain("Architecture");
    expect(markup).toContain("Validation");
    expect(markup).toContain("Add custom tag");
    expect(markup).toContain("0 / 12");
  });
});
