import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import { seedDemoWorkflowRepository } from "./demo-workflow";

describe("seedDemoWorkflowRepository (expanded demo seed)", () => {
  it("seeds two drives (115 + quark) so the switcher shows", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    const drives = await repo.listConnectedStorages("acct_default");
    expect(drives).toHaveLength(2);
    const providers = drives.map((d) => d.provider).sort();
    expect(providers).toEqual(["pan115", "quark"]);
  });

  it("seeds the tracked show + two completed movies with their runs", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    // the three seeded runs exist
    for (const runId of ["run_demo_qiaochu", "run_demo_truman", "run_demo_shawshank"]) {
      const snap = await repo.getWorkflowRunSnapshot(runId, "acct_default");
      expect(snap, runId).not.toBeNull();
    }
  });
});
