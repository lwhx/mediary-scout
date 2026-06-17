import { describe, expect, it } from "vitest";
import { getQualityPreference } from "./workflow-runtime";

function repoWith(value: string | null) {
  return { getSetting: async () => value };
}

describe("getQualityPreference", () => {
  it("unset → undefined (default 不限, no quality injection)", async () => {
    expect(await getQualityPreference(repoWith(null))).toBeUndefined();
  });

  it("'any' → undefined", async () => {
    expect(await getQualityPreference(repoWith("any"))).toBeUndefined();
  });

  it("'high'/'medium' pass through (trimmed)", async () => {
    expect(await getQualityPreference(repoWith("high"))).toBe("high");
    expect(await getQualityPreference(repoWith(" medium "))).toBe("medium");
  });

  it("garbage (incl. legacy '4K') → undefined (safe)", async () => {
    expect(await getQualityPreference(repoWith("4K"))).toBeUndefined();
    expect(await getQualityPreference(repoWith("ultra"))).toBeUndefined();
  });
});
