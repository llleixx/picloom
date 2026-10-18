import { test, expect } from "bun:test";
import { fixture } from "./helpers";
test("random path works through upload profiles and keeps historical URLs after profile edits", async () => {
  const f = await fixture();
  try {
    const profile = await f.app.configuration.profileEditor(f.profileId);
    expect(profile.path.pluginId).toBe("builtin.random-path");
    expect(profile.path.config.directoryDepth).toBe(2);
    const response = await f.upload();
    expect(response.status).toBe(201);
    const file = await response.json();
    const path = new URL(file.url).pathname;
    expect(path).toMatch(/^\/i\/[0-9a-f]{32}\.png$/);
    const record = await f.app.db.read((tx) => tx.file(file.id));
    expect(record!.logical_key).toBe(path.slice(3));
    expect(record!.storage_key).toBe(
      record!.logical_key.slice(0, 2) +
        "/" +
        record!.logical_key.slice(2, 4) +
        "/" +
        record!.logical_key,
    );
    expect(
      await Bun.file(f.root + "/originals/" + record!.storage_key).exists(),
    ).toBe(true);
    const detail = await (await f.request("/api/files/" + file.id)).json();
    expect(detail.storageKey).toBe(record!.storage_key);
    const replicas = await f.app.db.read((tx) => tx.replicas(file.id));
    const scan = await f.request(
      `/api/storage-sources/${replicas[0]!.storage_instance_id}/import`,
      "POST",
      {
        publicPrefix: "/scan/",
        mimeTypes: ["image/png"],
      },
    );
    expect(scan.status).toBe(200);
    expect(await scan.json()).toMatchObject({ imported: 0, skipped: 1 });
    const read = await f.request(path);
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(f.png)).toBe(true);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        path: { pluginId: "builtin.date-path", version: "1.0.0", config: {} },
      },
      profile.id,
    );
    await f.restart();
    const historical = await f.request(path);
    expect(historical.status).toBe(200);
    await historical.arrayBuffer();
    const processed = await f.request(path + "?w=12");
    expect(processed.status).toBe(200);
    await processed.arrayBuffer();
    expect((await f.request("/api/files/" + file.id, "DELETE")).ok).toBe(true);
    await f.app.files.sweep();
    expect(
      await Bun.file(f.root + "/originals/" + record!.storage_key).exists(),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
