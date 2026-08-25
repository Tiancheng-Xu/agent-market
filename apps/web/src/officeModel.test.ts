import { describe, expect, it } from "vitest";

import { filterOfficeDesks, visibleDeskForWallet, type OfficeTaskDesk } from "./officeModel";

const desk: OfficeTaskDesk = {
  taskId: "task-1",
  ownerWallet: "0x1111111111111111111111111111111111111111",
  ownerLabel: "Owner 01",
  title: "Build workflow",
  category: "Code",
  tags: ["code"],
  status: "in_progress",
  agents: [],
  nodeInput: "private input",
  nodeOutput: "private output",
  downloadableResult: "private result",
};

describe("virtual office access", () => {
  it("lets the owner read task material", () => {
    expect(visibleDeskForWallet(desk, desk.ownerWallet)).toMatchObject({ access: "owner", nodeInput: "private input" });
  });

  it("strips task input, output, and downloads from visitors", () => {
    const visible = visibleDeskForWallet(desk, "0x2222222222222222222222222222222222222222");
    expect(visible.access).toBe("visitor");
    expect(JSON.stringify(visible)).not.toMatch(/private input|private output|private result/);
  });

  it("filters desks by public task status", () => {
    expect(filterOfficeDesks([desk], "completed")).toEqual([]);
    expect(filterOfficeDesks([desk], "all")).toHaveLength(1);
  });
});
