export function isValidIp(ip: string): boolean {
  const parts = ip.split('.')
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  )
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0)
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
}

export function maskInt(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
}

export function prefixToMask(prefix: number): string {
  return intToIp(maskInt(prefix))
}

export function networkOf(ip: string, prefix: number): string {
  return intToIp((ipToInt(ip) & maskInt(prefix)) >>> 0)
}

export function inSubnet(ip: string, network: string, prefix: number): boolean {
  const m = maskInt(prefix)
  return ((ipToInt(ip) & m) >>> 0) === ((ipToInt(network) & m) >>> 0)
}

/** Parses "10.0.0.1/24" (prefix required) or "10.0.0.1" (prefix defaults to 32). */
export function parseCidr(
  text: string,
  defaultPrefix = 32,
): { ip: string; prefix: number } | null {
  const [ip, p] = text.trim().split('/')
  if (!isValidIp(ip)) return null
  const prefix = p === undefined ? defaultPrefix : Number(p)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  return { ip, prefix }
}

/** Matches an IP against a firewall-style spec: 'any', a host IP, or a CIDR. */
export function matchesSpec(ip: string, spec: string): boolean {
  if (spec === 'any') return true
  const c = parseCidr(spec)
  return c !== null && inSubnet(ip, c.ip, c.prefix)
}

export function isHostAddress(ip: string, prefix: number): boolean {
  if (prefix >= 31) return true
  const host = ipToInt(ip) & ~maskInt(prefix)
  const all = ~maskInt(prefix) >>> 0
  return host !== 0 && host >>> 0 !== all
}
