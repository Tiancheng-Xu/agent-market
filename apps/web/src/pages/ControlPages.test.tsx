import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { arbitrationErrorMessage, CommitteePage, reviewMatchesSelection } from "./ControlPages";
import { translateVisibleText } from "../i18n/translations";

describe("V3 platform final arbitration feedback", () => {
  it("does not expose a browser-only switch that grants review completion", () => {
    const markup = renderToStaticMarkup(<CommitteePage walletAddress={null} />);

    expect(markup).toContain("No persisted review loaded");
    expect(markup).not.toContain("Platform review recorded locally");
    expect(markup).toContain("disabled");
  });

  it("keeps final resolution wallet-gated and delegates the sole arbiter role to the server", () => {
    const markup = renderToStaticMarkup(<CommitteePage walletAddress={null} />);
    expect(markup).toContain("configured platform arbiter wallet");
    expect(markup).toContain("Resolve on Sepolia");
    expect(markup).toContain("Recheck RPC receipt");
  });

  it("accepts completion only when the server review matches the selected resource, outcome, and wallet", () => {
    const review = {
      reviewId: "0191f6f8-cb6b-7f31-81ad-c497d7d90305", resourceId: "0191f6f8-cb6b-7f31-81ad-c497d7d90304",
      resourceRevision: 3, reviewerWallet: "0x1111111111111111111111111111111111111111", agentsWin: true,
      args: { agentsWin: true }, reviewHash: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-09-12T12:00:00.000Z", expiresAt: "2026-09-12T12:10:00.000Z",
    };
    const now = Date.parse("2026-09-12T12:05:00.000Z");
    expect(reviewMatchesSelection(review, review.resourceId, true, review.reviewerWallet, now)).toBe(true);
    expect(reviewMatchesSelection(review, review.resourceId, false, review.reviewerWallet, now)).toBe(false);
    expect(reviewMatchesSelection(review, review.resourceId, true, "0x2222222222222222222222222222222222222222", now)).toBe(false);
  });

  it("uses finite, fully translated messages for dynamic arbitration states", () => {
    const messages = [
      arbitrationErrorMessage(new Error("AUTH_WALLET_CHANGED"), "fallback"),
      arbitrationErrorMessage(new Error("SERVER_INTERNAL_DETAIL"), "Unable to load the platform review. Reauthenticate and try again."),
      "Enter a valid task resource UUID.",
      "Platform review persisted by the server. No blockchain transaction was submitted.",
      "Unable to persist the platform review. No blockchain transaction was submitted.",
      "Unable to prepare final arbitration. No blockchain transaction was submitted.",
      "Resolution remains unconfirmed. No ruling has been claimed.",
      "Unable to verify the resolution. No ruling has been claimed.",
    ];
    for (const message of messages) expect(translateVisibleText("zh-CN", message)).not.toBe(message);
  });
});
