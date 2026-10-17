import { isIP } from "node:net";
import { AppError } from "../core/errors";
export function normalizeGuestIp(value: string): string {
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) {
    const ip = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = ip.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (mapped) {
      const n = parseInt(mapped[1]!, 16) * 65536 + parseInt(mapped[2]!, 16);
      return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
    return ip;
  }
  throw new AppError("INVALID_INPUT", "Unable to identify guest IP");
}
