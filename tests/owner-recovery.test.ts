import { test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { promptOwnerPassword } from "../src/cli-password";
import { fixture } from "./helpers";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {
      return this;
    },
  });
  let text = "";
  const output = {
    write(value: string | Uint8Array) {
      text += value;
      return true;
    },
  };
  return {
    input: input as unknown as typeof process.stdin,
    output,
    text: () => text,
  };
}
async function enter(input: typeof process.stdin, value: string | null) {
  input.push(value);
  await Bun.sleep(10);
}
test("Owner recovery prompts hide input, confirm, cancel, and require a terminal", async () => {
  const t = terminal();
  const result = promptOwnerPassword(t.input, t.output);
  await enter(t.input, "recovered-password-123\r");
  await enter(t.input, "recovered-password-123\r");
  expect(await result).toBe("recovered-password-123");
  expect(t.text()).not.toContain("recovered-password-123");
  const mismatch = terminal();
  const pending = promptOwnerPassword(mismatch.input, mismatch.output);
  pending.catch(() => {});
  await enter(mismatch.input, "first-password-123\r");
  await enter(mismatch.input, "other-password-123\r");
  await expect(pending).rejects.toThrow("do not match");
  for (const end of ["\x03", null]) {
    const cancelled = terminal();
    const pending = promptOwnerPassword(cancelled.input, cancelled.output);
    pending.catch(() => {});
    await enter(cancelled.input, end);
    await expect(pending).rejects.toThrow("cancelled");
  }
  await expect(
    promptOwnerPassword(new PassThrough() as unknown as typeof process.stdin),
  ).rejects.toThrow("interactive terminal");
});
test("Owner recovery revokes sessions, retains upload tokens, and rejects invalid passwords", async () => {
  const f = await fixture();
  try {
    const owner = await f.app.db.read((r) => r.userByName("admin"));
    const tokenResponse = await f.request("/api/tokens", "POST", {
      name: "retained",
    });
    expect(tokenResponse.status).toBe(201);
    const token = (await tokenResponse.json()).token;
    await expect(f.app.auth.recoverOwnerPassword("short")).rejects.toThrow(
      "at least 12",
    );
    expect((await f.request("/api/auth/session")).status).toBe(200);
    expect(
      await f.app.auth.recoverOwnerPassword("recovered-password-123"),
    ).toBe("admin");
    expect((await f.request("/api/auth/session")).status).toBe(401);
    await expect(
      f.app.auth.login("admin", "test-password-123", "old"),
    ).rejects.toThrow("Invalid login");
    expect(
      (await f.app.auth.login("admin", "recovered-password-123", "new")).user
        .id,
    ).toBe(owner!.id);
    expect(
      (
        await f.app.auth.authenticate(
          new Request("http://localhost", {
            headers: { authorization: "Bearer " + token },
          }),
        )
      ).user.id,
    ).toBe(owner!.id);
  } finally {
    await f.close();
  }
});
test("Owner recovery refuses missing or ambiguous Owner accounts", async () => {
  const { Auth } = await import("../src/core/auth");
  for (const owners of [[], [{}, {}]]) {
    let changed = false;
    const db = {
      transaction: async (fn: Function) =>
        fn({
          owners: async () => owners,
          changePassword: async () => {
            changed = true;
          },
        }),
    };
    const auth = new Auth(db as never, {} as never);
    await expect(
      auth.recoverOwnerPassword("recovered-password-123"),
    ).rejects.toThrow("exactly one Owner");
    expect(changed).toBe(false);
  }
});
