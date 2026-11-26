/** The blocked address ranges of the address guard (specs/web-fetch.md, Section 3.4). */

import { isIP } from "node:net";

export type BlockedKind =
  | "unspecified"
  | "loopback"
  | "private"
  | "shared"
  | "link-local"
  | "unique-local"
  | "multicast"
  | "reserved";

const V4_RANGES: readonly (readonly [string, number, BlockedKind])[] = [
  ["0.0.0.0", 8, "unspecified"],
  ["127.0.0.0", 8, "loopback"],
  ["10.0.0.0", 8, "private"],
  ["172.16.0.0", 12, "private"],
  ["192.168.0.0", 16, "private"],
  ["100.64.0.0", 10, "shared"],
  ["169.254.0.0", 16, "link-local"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function v4Value(ip: string): bigint {
  let value = 0n;
  for (const part of ip.split(".")) value = (value << 8n) | BigInt(Number(part));
  return value;
}

/** The 128-bit value of an IPv6 address, an embedded dotted IPv4 tail included. */
function v6Value(ip: string): bigint {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const v4 = v4Value(dotted[1]);
    text = `${text.slice(0, dotted.index)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const groups = [...headParts, ...Array.from({ length: fill }, () => "0"), ...tailParts];
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  return value;
}

function inRange(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

function v4Kind(ip: string): BlockedKind | undefined {
  const value = v4Value(ip);
  for (const [base, prefix, kind] of V4_RANGES) {
    if (inRange(value, v4Value(base), prefix, 32)) return kind;
  }
  return undefined;
}

function v4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** The kind of blocked range an IP address lies in, or `undefined` for a public address. */
export function blockedKind(ip: string): BlockedKind | undefined {
  const family = isIP(ip);
  if (family === 4) return v4Kind(ip);
  if (family !== 6) return undefined;
  const value = v6Value(ip);
  if (value === 0n) return "unspecified";
  if (value === 1n) return "loopback";
  if (inRange(value, 0xffffn << 32n, 96, 128) || inRange(value, 0x64ff9bn << 96n, 96, 128)) {
    return v4Kind(v4Text(value & 0xffffffffn));
  }
  if (inRange(value, 0xfe80n << 112n, 10, 128)) return "link-local";
  if (inRange(value, 0xfc00n << 112n, 7, 128)) return "unique-local";
  if (inRange(value, 0xff00n << 112n, 8, 128)) return "multicast";
  return undefined;
}

/** The canonical text form of an IP address, as the URL host serialiser writes it. */
export function canonicalIp(ip: string): string {
  const family = isIP(ip);
  if (family === 6) {
    const bare = ip.split("%")[0] ?? ip;
    return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  }
  if (family === 4) return new URL(`http://${ip}/`).hostname;
  return ip;
}

/** Whether a host name is a loopback name: `localhost` or a name under it. */
export function isLocalhostName(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}
