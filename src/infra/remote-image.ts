import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { AppError } from "../core/errors";
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
export function publicImageAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        global6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
const invalid = () =>
  new AppError("REMOTE_IMAGE_FAILED", "Could not download this image URL", 400);
export async function downloadImage(
  value: string,
  limit: number,
  parent: AbortSignal,
): Promise<File> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
  try {
    let url = new URL(value);
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw invalid();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true });
      if (
        !addresses.length ||
        addresses.some((a) => !publicImageAddress(a.address))
      )
        throw invalid();
      const address = addresses[0]!;
      // Connect to the checked IP; preserve Host and TLS verification for the original hostname.
      const response = await new Promise<import("node:http").IncomingMessage>(
        (resolve, reject) => {
          const request = (url.protocol === "https:" ? https : http)(
            {
              protocol: url.protocol,
              hostname: address.address,
              family: address.family,
              port: url.port || undefined,
              path: url.pathname + url.search,
              servername: isIP(hostname) ? undefined : hostname,
              headers: {
                host: url.host,
                "user-agent": "Picloom/0.1",
                accept: "image/*",
                "accept-encoding": "identity",
              },
              signal,
              agent: false,
            },
            resolve,
          );
          request.on("error", reject);
          request.end();
        },
      );
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects === 5) throw invalid();
        url = new URL(location, url);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new AppError("REMOTE_IMAGE_HTTP", "Image host rejected the download", 400);
      }
      if (Number(response.headers["content-length"]) > limit) {
        response.destroy();
        throw new AppError(
          "TOO_LARGE",
          "Remote image exceeds the upload limit",
          413,
        );
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > limit) {
          response.destroy();
          throw new AppError(
            "TOO_LARGE",
            "Remote image exceeds the upload limit",
            413,
          );
        }
        chunks.push(Buffer.from(chunk));
      }
      if (!size) throw invalid();
      const name = decodeURIComponent(
        url.pathname.split("/").pop() || "remote-image",
      );
      return new File([new Uint8Array(Buffer.concat(chunks))], name, {
        type: response.headers["content-type"] ?? "application/octet-stream",
      });
    }
    throw invalid();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw invalid();
  }
}
