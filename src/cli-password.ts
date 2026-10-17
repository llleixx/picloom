import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export async function promptOwnerPassword(
  input = process.stdin,
  output: Pick<typeof process.stdout, "write"> = process.stdout,
) {
  if (!input.isTTY)
    throw new Error(
      "Run reset-owner-password in an interactive terminal; password input is hidden.",
    );
  // Readline handles editing and restores terminal mode; discard its echo.
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({ input, output: silent, terminal: true });
  const question = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      output.write(prompt);
      const cancel = () => {
        cleanup();
        reject(new Error("Password reset cancelled"));
      };
      const cleanup = () => {
        reader.off("SIGINT", cancel);
        reader.off("close", cancel);
      };
      reader.once("SIGINT", cancel);
      reader.once("close", cancel);
      reader.question("", (value) => {
        cleanup();
        output.write("\n");
        resolve(value);
      });
    });
  try {
    const password = await question(
      "New Owner password (at least 12 characters): ",
    );
    const confirmation = await question("Confirm new Owner password: ");
    if (password !== confirmation)
      throw new Error("Passwords do not match; unchanged");
    return password;
  } finally {
    reader.close();
    silent.destroy();
  }
}
