import { expect, test } from "bun:test";
import { fixture } from "./helpers";
import type { ProcessorPlugin, ProcessorInput } from "../plugin-sdk";

for (const stage of ["upload", "access"] as const) {
  test(`${stage} rejects malformed processor results before continuing the pipeline`, async () => {
    const f = await fixture();
    let checkResult: unknown = { status: "applicable" };
    let processResult: unknown = { status: "pass" };
    let processCalls = 0;
    let followingCalls = 0;
    let replace = false;
    const descriptor = {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async createInstance() {
        return {
          cacheable: false,
          async check() {
            return checkResult as Awaited<ReturnType<ProcessorPlugin["check"]>>;
          },
          async process(input: Pick<ProcessorInput, "createOutput">) {
            processCalls++;
            if (replace) {
              const output = await input.createOutput();
              await output.write(new Blob([new Uint8Array(f.png)]).stream());
              return { status: "replace" as const, output };
            }
            return processResult as Awaited<
              ReturnType<ProcessorPlugin["process"]>
            >;
          },
        };
      },
    };
    try {
      const original = await (await f.upload()).json();
      f.app.plugins.register({
        defaultLocale: "en-US",
        nameKey: "package.name",
        messages: {
          "en-US": {
            "package.name": "Results",
          },
        },

        id: "test.results",

        kind: "processor",
        version: "1",
        apiVersion: 1,
        stages: { [stage]: descriptor },
      });
      f.app.plugins.register({
        defaultLocale: "en-US",
        nameKey: "package.name",
        messages: {
          "en-US": {
            "package.name": "Following",
          },
        },

        id: "test.following",

        kind: "processor",
        version: "1",
        apiVersion: 1,
        stages: {
          [stage]: {
            ...descriptor,
            async createInstance() {
              return {
                cacheable: false,
                async check() {
                  followingCalls++;
                  return { status: "noop" as const };
                },
                async process() {
                  return { status: "pass" as const };
                },
              };
            },
          },
        },
      });
      const existing =
        stage === "access"
          ? (await f.app.configuration.pipelines()).find(
              (p) => p.kind === "access",
            )!
          : undefined;
      const chain = await f.app.configuration.savePipeline(
        {
          name: "Validate results",
          kind: stage,
          ...(existing ? { expectedVersion: existing.configVersion } : {}),
          steps: [
            {
              pluginId: "test.results",
              version: "1",
              config: {},
              onNotApplicable: "skip",
            },
            {
              pluginId: "test.following",
              version: "1",
              config: {},
              onNotApplicable: "abort",
            },
          ],
        },
        existing?.id,
      );
      if (stage === "upload") {
        const profile = await f.app.configuration.profileEditor(f.profileId);
        await f.app.configuration.saveProfileEditor(
          {
            ...profile,
            expectedVersion: profile.configVersion,
            uploadPipelineId: chain.id,
          },
          profile.id,
        );
      }
      const request = () =>
        stage === "upload"
          ? f.upload()
          : f.request(new URL(original.url).pathname);
      const assertInvalid = async (code = "PROCESSING_RESULT_INVALID") => {
        const before = followingCalls;
        const response = await request();
        expect(response.status).toBe(500);
        expect((await response.json()).error.code).toBe(code);
        expect(followingCalls).toBe(before);
      };
      for (const value of [
        undefined,
        null,
        [],
        "applicable",
        {},
        { status: "aplicable" },
        { status: "unsupported", reason: 1 },
      ]) {
        checkResult = value;
        const before = processCalls;
        await assertInvalid();
        expect(processCalls).toBe(before);
      }
      checkResult = { status: "applicable" };
      for (const value of [
        undefined,
        null,
        [],
        "pass",
        {},
        { status: "replcae" },
        { status: "reject" },
        { status: "reject", reason: 1 },
        { status: "replace" },
        { status: "replace", output: null },
        { status: "replace", output: { handle: 1 } },
      ]) {
        processResult = value;
        await assertInvalid();
      }
      processResult = { status: "replace", output: { handle: "foreign" } };
      await assertInvalid("PLUGIN_OUTPUT");
      // Valid skip/pass results still continue; malformed unsupported cannot exploit skip.
      for (const status of ["noop", "unsupported", "applicable"]) {
        checkResult = { status };
        processResult = { status: "pass" };
        const before = followingCalls;
        const response = await request();
        expect(response.status).toBe(stage === "upload" ? 201 : 200);
        await response.arrayBuffer();
        expect(followingCalls).toBe(before + 1);
      }
      processResult = { status: "reject", reason: "Policy rejected" };
      const rejected = await request();
      expect(rejected.status).toBe(422);
      expect((await rejected.json()).error.code).toBe("REJECTED");
      replace = true;
      const replaced = await request();
      expect(replaced.status).toBe(stage === "upload" ? 201 : 200);
      await replaced.arrayBuffer();
    } finally {
      await f.close();
    }
  });
}
