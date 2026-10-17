import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Config } from "../plugins/api";
export class Secrets {
  private key: Buffer;
  constructor(hex: string) {
    this.key = Buffer.from(hex, "hex");
  }
  encrypt(value: Config, id: string) {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      c.update(JSON.stringify(value), "utf8"),
      c.final(),
    ]);
    return JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  decrypt(value: string | null, id: string): Config {
    if (!value) return {};
    const x = JSON.parse(value);
    if (x.version !== 1) throw new Error("Unsupported key version");
    const c = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(x.nonce, "base64"),
    );
    c.setAAD(Buffer.from(id));
    c.setAuthTag(Buffer.from(x.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        c.update(Buffer.from(x.data, "base64")),
        c.final(),
      ]).toString("utf8"),
    );
  }
}
