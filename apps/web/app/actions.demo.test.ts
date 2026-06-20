import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DemoReadOnlyError } from "../lib/demo-mode";

// Defense-in-depth: even if the UI is bypassed, side-effectful server actions must
// reject in demo mode. Smoke-checks the gate is wired (one representative action).
describe("server actions honor demo read-only", () => {
  beforeEach(() => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
  });
  afterEach(() => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
  });

  it("testStorageConnectionAction rejects in demo mode", async () => {
    const { testStorageConnectionAction } = await import("./actions");
    await expect(testStorageConnectionAction("cs_x")).rejects.toBeInstanceOf(DemoReadOnlyError);
  });

  it("savePushSettingsAction rejects in demo mode", async () => {
    const { savePushSettingsAction } = await import("./actions");
    await expect(savePushSettingsAction({ bark: "x" })).rejects.toBeInstanceOf(DemoReadOnlyError);
  });
});
