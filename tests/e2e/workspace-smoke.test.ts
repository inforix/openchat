import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("loads shared packages", async () => {
    const protocol = await import("@openchat/protocol");
    expect(protocol).toBeDefined();
  });
});
