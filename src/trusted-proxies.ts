import { BlockList, isIP } from "node:net";

export function createClientIpResolver(trustedProxies: readonly string[]) {
  const trusted = new BlockList();
  for (const entry of trustedProxies) {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address!);
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new Error(
        `Invalid TRUSTED_PROXIES entry: ${entry}; expected an IP or CIDR`,
      );
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) trusted.addAddress(address!, type);
    else trusted.addSubnet(address!, Number(prefix), type);
  }

  return (peer: string, forwarded: string | null): string => {
    const family = isIP(peer);
    // Only the immediate trusted proxy may supply a single client IP.
    return family &&
      trusted.check(peer, family === 4 ? "ipv4" : "ipv6") &&
      forwarded &&
      isIP(forwarded)
      ? forwarded
      : peer;
  };
}
