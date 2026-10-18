import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./action-fixture";
import { SqlRepositories } from "../src/persistence/repositories";

test("management lists batch related data and configuration views omit usage queries", async () => {
  const f = await fixture();
  const spies: Array<{ mockRestore(): void }> = [];
  try {
    const pipeline = await f.app.configuration.savePipeline({
      name: "Ordered notifications",
      kind: "post_save",
      steps: ["first", "second"].map((name) => ({
        pluginId: "test.action",
        version: "1.0.0",
        config: { url: `http://localhost/${name}` },
        secretEdits: {
          "/token": { action: "replace" as const, value: "private-test-token" },
        },
      })),
    });
    await f.app.configuration.duplicatePipeline(pipeline.id);
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        postSavePipelineId: pipeline.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const group = await f.app.configuration.group(profile.storageGroupId);
    const extra = await f.app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Extra",
      config: { root: join(f.root, "extra") },
    });
    const secondGroup = await f.app.configuration.saveGroup({
      ...group,
      name: "Second",
      members: [{ instanceId: extra.id, weight: 3 }, ...group.members],
    });
    for (const [username, profileIds] of [
      ["assigned", [f.profileId]],
      ["unassigned", []],
    ] as const) {
      expect(
        (
          await f.request("/api/users", "POST", {
            username,
            password: "test-password-123",
            role: "member",
            profileIds,
          })
        ).status,
      ).toBe(201);
    }
    const batchSteps = spyOn(SqlRepositories.prototype, "stepsForPipelines");
    const refs = spyOn(SqlRepositories.prototype, "referencesForInstances");
    const counts = spyOn(SqlRepositories.prototype, "replicaCounts");
    const singleSteps = spyOn(SqlRepositories.prototype, "steps");
    const singleMembers = spyOn(SqlRepositories.prototype, "members");
    const singleProfiles = spyOn(SqlRepositories.prototype, "userProfiles");
    const fullView = spyOn(f.app.plugins, "view");
    spies.push(
      batchSteps,
      refs,
      counts,
      singleSteps,
      singleMembers,
      singleProfiles,
      fullView,
    );
    const pipelines = await f.app.configuration.pipelines();
    const listed = pipelines.find((p) => p.id === pipeline.id)!;
    expect(listed.steps.map((s) => s.config.url)).toEqual([
      "http://localhost/first",
      "http://localhost/second",
    ]);
    expect(listed.steps.every((s) => s.secretPresence?.["/token"])).toBe(true);
    expect(listed.references).toContainEqual({
      type: "profile",
      id: f.profileId,
      name: profile.name,
    });
    expect(JSON.stringify(pipelines)).not.toContain("private-test-token");
    await f.app.configuration.profileEditor(f.profileId);
    expect(batchSteps).toHaveBeenCalledTimes(1);
    expect(singleSteps).not.toHaveBeenCalled();
    expect(fullView).not.toHaveBeenCalled();
    expect(refs).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
    const groups = await f.app.configuration.groups();
    expect(groups.find((g) => g.id === secondGroup.id)?.members).toEqual(
      secondGroup.members,
    );
    expect(singleMembers).not.toHaveBeenCalled();
    const sources = await (await f.request("/api/storage-sources")).json();
    expect(
      sources.find((s: { id: string }) => s.id === extra.id),
    ).toMatchObject({
      replicaCount: 0,
      references: [{ type: "group", id: secondGroup.id, name: "Second" }],
    });
    expect(refs).toHaveBeenCalledTimes(1);
    expect(counts).toHaveBeenCalledTimes(1);
    const users = await f.app.auth.listUsers(20, 0);
    expect(
      users.items.find((u) => u.username === "assigned")?.profileIds,
    ).toEqual([f.profileId]);
    expect(
      users.items.find((u) => u.username === "unassigned")?.profileIds,
    ).toEqual([]);
    expect(singleProfiles).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
    await f.close();
  }
});
