import { test, expect } from "bun:test";
import { cacheKey } from "../src/core/cache";
import { entity, type Step } from "../src/persistence/port";
import { instance } from "./persistence.contract";
test("cache keys cover ordered steps, configuration, policy and version", async () => {
  const record = instance();
  const step: Step = {
    ...entity(),
    enabled_params: [],
    pipeline_id: "access",
    position: 0,
    plugin_instance_id: record.id,
    on_not_applicable: "skip",
  };
  const steps = [{ record, step }];
  const key = await cacheKey("file", { w: 10, q: 80 }, steps);
  expect(key).toMatch(/^[a-f0-9]{32}$/);
  expect(await cacheKey("file", { q: 80, w: 10 }, steps)).toBe(key);
  expect(await cacheKey("other", { q: 80, w: 10 }, steps)).not.toBe(key);
  expect(
    await cacheKey("file", { w: 10, q: 80 }, [
      { record, step: { ...step, on_not_applicable: "abort" } },
    ]),
  ).not.toBe(key);
  expect(
    await cacheKey("file", { w: 10, q: 80 }, [
      { record: { ...record, plugin_version: "2" }, step },
    ]),
  ).not.toBe(key);
  expect(
    await cacheKey("file", { w: 10, q: 80 }, [
      { record: { ...record, config_json: { changed: true } }, step },
    ]),
  ).not.toBe(key);
  const other = {
    step: { ...step, id: "other" },
    record: { ...record, id: "other" },
  };
  expect(await cacheKey("file", {}, [...steps, other])).not.toBe(
    await cacheKey("file", {}, [other, ...steps]),
  );
  expect(
    await cacheKey("file", {}, [
      {
        record,
        step,
        cacheConfig: { ...record.config_json, credential: "old" },
      },
    ]),
  ).not.toBe(
    await cacheKey("file", {}, [
      {
        record,
        step,
        cacheConfig: { ...record.config_json, credential: "new" },
      },
    ]),
  );
});
