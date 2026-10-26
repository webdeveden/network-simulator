/**
 * Cisco access lists: numbered (1-99 standard, 100-199 extended) and named
 * (`ip access-list standard|extended NAME`). Standard lines match the source address
 * only; extended lines match protocol, source, destination and an optional port.
 * Lines are checked top to bottom, the first match decides, and a packet that matches
 * nothing is denied (the implicit deny at the end).
 *
 * ACLs are stateless: applied with `ip access-group`, they also check the replies
 * coming back, unlike NetSim's stateful firewall. `established` matches TCP replies.
 */
import { ipToInt, isValidIp } from './ip'
import type { AclEntry, AclProto, Device } from './types'

export type AclKind = 'standard' | 'extended'

/** What an ACL line is compared with. */
export interface AclPacket {
  src: string
  dst: string
  proto: 'icmp' | 'tcp' | 'udp' | 'any'
  srcPort?: number
  dstPort?: number
  /** A reply in an existing session (TCP ACK set): what `established` matches. */
  reply: boolean
}

/** Well-known port names IOS accepts after `eq`. */
export const PORT_NAMES: Record<string, number> = {
  ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, bootps: 67, bootpc: 68, tftp: 69, www: 80, http: 80, pop3: 110, ntp: 123, snmp: 161, https: 443, syslog: 514,
}

/** Numbered lists: 1-99 and 1300-1999 standard, 100-199 and 2000-2699 extended; named lists say which they are. */
export function aclKind(d: Device, name: string): AclKind | null {
  const n = Number(name)
  if (Number.isInteger(n)) {
    if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return 'standard'
    if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return 'extended'
    return null
  }
  return d.ios?.aclTypes?.[name] ?? null
}

/** `10.1.0.0 0.0.0.255`, `host 10.1.0.5` or `any`: how many tokens it took, or an error. */
function parseAddress(tokens: string[], k: number, wildcardRequired: boolean): { addr: string; wildcard?: string; used: number } | string {
  const t = tokens[k]?.toLowerCase()
  if (t === 'any') return { addr: 'any', used: 1 }
  if (t === 'host') {
    if (!tokens[k + 1] || !isValidIp(tokens[k + 1])) return '% Incomplete command. host <address>'
    return { addr: tokens[k + 1], used: 2 }
  }
  if (!t || !isValidIp(t)) return `% Invalid address ${tokens[k] ?? ''} (an address with a wildcard, host <address> or any)`
  const w = tokens[k + 1]
  if (w && isValidIp(w)) {
    if (!isWildcard(w)) {
      const asMask = w.split('.').map((o) => 255 - Number(o)).join('.')
      return isWildcard(asMask) ? `% ${w} is a subnet mask; ACLs use wildcards: ${asMask}` : `% ${w} is not a wildcard mask (0.0.0.255 for a /24)`
    }
    return { addr: t, wildcard: w, used: 2 }
  }
  if (wildcardRequired) return `% ${t} needs a wildcard mask (e.g. ${t} 0.0.0.255), or use host ${t}`
  return { addr: t, used: 1 }
}

/** A contiguous wildcard (0s then 1s): 0.0.0.255 yes, 0.255.0.255 no. */
function isWildcard(w: string): boolean {
  const n = ipToInt(w) >>> 0
  return ((n + 1) & n) >>> 0 === 0
}

/** `eq 22` / `eq ssh` after an address: the port, how many tokens, or an error. */
function parsePort(tokens: string[], k: number): { port?: number; used: number } | string {
  const op = tokens[k]?.toLowerCase()
  if (op !== 'eq') {
    if (op === 'gt' || op === 'lt' || op === 'neq' || op === 'range') return `% NetSim supports only eq for ports (eq 80, eq www)`
    return { used: 0 }
  }
  const v = tokens[k + 1]?.toLowerCase()
  const port = v === undefined ? NaN : (PORT_NAMES[v] ?? Number(v))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `% Invalid port ${tokens[k + 1] ?? ''} (a number, or a name like www, ssh, telnet, domain)`
  return { port, used: 2 }
}

/**
 * One ACL line from tokens after the list name: `permit|deny …` or `remark …`.
 * Standard: `<source>`. Extended: `<ip|icmp|tcp|udp> <source> [eq p] <destination> [eq p] [established]`.
 */
export function parseAclLine(kind: AclKind, tokens: string[]): AclEntry | string {
  const word = tokens[0]?.toLowerCase() ?? ''
  if (word === 'remark') return { action: 'permit', src: 'any', remark: tokens.slice(1).join(' ') || ' ' }
  const action = word && 'permit'.startsWith(word) ? 'permit' : word && 'deny'.startsWith(word) ? 'deny' : null
  if (!action) return '% Incomplete command. permit|deny … or remark <text>'
  if (kind === 'standard') {
    const a = parseAddress(tokens, 1, false)
    if (typeof a === 'string') return a
    if (tokens.length > 1 + a.used) return `% Standard lists match the source only. For destinations or ports use an extended list (100-199 or ip access-list extended)`
    return { action, src: a.addr, ...(a.wildcard ? { wildcard: a.wildcard } : {}) }
  }
  const proto = tokens[1]?.toLowerCase() as AclProto | undefined
  if (!proto || !['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return '% Incomplete command. permit|deny ip|icmp|tcp|udp <source> <destination> [eq <port>]'
  let k = 2
  const src = parseAddress(tokens, k, true)
  if (typeof src === 'string') return src
  k += src.used
  const sp = parsePort(tokens, k)
  if (typeof sp === 'string') return sp
  k += sp.used
  const dst = parseAddress(tokens, k, true)
  if (typeof dst === 'string') return dst
  k += dst.used
  const dp = parsePort(tokens, k)
  if (typeof dp === 'string') return dp
  k += dp.used
  let established = false
  if (tokens[k]?.toLowerCase() === 'established') {
    established = true
    k++
  }
  if (k < tokens.length) return `% Invalid input "${tokens.slice(k).join(' ')}"`
  if ((sp.port || dp.port || established) && proto !== 'tcp' && proto !== 'udp') return '% Ports and established only go with tcp or udp'
  if (established && proto !== 'tcp') return '% established is for tcp'
  return {
    action,
    proto,
    src: src.addr,
    ...(src.wildcard ? { wildcard: src.wildcard } : {}),
    ...(sp.port ? { srcPort: sp.port } : {}),
    dst: dst.addr,
    ...(dst.wildcard ? { dstWildcard: dst.wildcard } : {}),
    ...(dp.port ? { port: dp.port } : {}),
    ...(established ? { established } : {}),
  }
}

const portText = (p?: number) => {
  if (!p) return ''
  const name = Object.entries(PORT_NAMES).find(([n, v]) => v === p && n !== 'http')?.[0]
  return ` eq ${name ?? p}`
}
const addrText = (a: string, w?: string) => (a === 'any' ? 'any' : w ? `${a} ${w}` : `host ${a}`)

/** The line as IOS prints it (without the list name or sequence number). */
export function aclLineText(e: AclEntry): string {
  if (e.remark !== undefined) return `remark ${e.remark}`
  if (!e.proto) return `${e.action} ${e.src === 'any' ? 'any' : e.wildcard ? `${e.src} ${e.wildcard}` : e.src}`
  return `${e.action} ${e.proto} ${addrText(e.src, e.wildcard)}${portText(e.srcPort)} ${addrText(e.dst ?? 'any', e.dstWildcard)}${portText(e.port)}${e.established ? ' established' : ''}`
}

function addrMatch(ip: string, addr: string, wildcard?: string): boolean {
  if (addr === 'any') return true
  if (!wildcard) return ip === addr
  const care = ~ipToInt(wildcard) >>> 0
  return ((ipToInt(ip) ^ ipToInt(addr)) & care) >>> 0 === 0
}

function lineMatches(e: AclEntry, p: AclPacket): boolean {
  if (e.remark !== undefined) return false
  if (!addrMatch(p.src, e.src, e.wildcard)) return false
  // Standard line: the source address is all it looks at.
  if (!e.proto) return true
  if (e.proto !== 'ip' && e.proto !== p.proto) return false
  if (!addrMatch(p.dst, e.dst ?? 'any', e.dstWildcard)) return false
  if (e.port !== undefined && e.port !== p.dstPort) return false
  if (e.srcPort !== undefined && e.srcPort !== p.srcPort) return false
  if (e.established && !(p.proto === 'tcp' && p.reply)) return false
  return true
}

export interface AclVerdict {
  permit: boolean
  /** Sequence number of the matching line, or null for the implicit deny. */
  seq: number | null
  text: string
}

/** Sequence numbers: 10, 20, 30… unless the line was entered with its own. */
export const seqOf = (list: AclEntry[], k: number) => list[k].seq ?? (k + 1) * 10

/** Checks a packet against a list. A missing list permits everything, as on IOS. Counts matches in `hits`. */
export function aclCheck(d: Device, name: string, p: AclPacket, hits?: Record<string, number>): AclVerdict {
  const list = d.ios?.acls?.[name]
  if (!list) return { permit: true, seq: null, text: `access list ${name} doesn't exist, so it filters nothing` }
  for (let k = 0; k < list.length; k++) {
    if (!lineMatches(list[k], p)) continue
    const seq = seqOf(list, k)
    if (hits) hits[`${name}#${seq}`] = (hits[`${name}#${seq}`] ?? 0) + 1
    return { permit: list[k].action === 'permit', seq, text: `line ${seq}: ${aclLineText(list[k])}` }
  }
  if (hits) hits[`${name}#deny`] = (hits[`${name}#deny`] ?? 0) + 1
  return { permit: false, seq: null, text: 'the implicit deny at the end (no line matched)' }
}

/** Standard-style check of one source address (NAT's `source list`, vty `access-class`). */
export function aclPermits(d: Device, name: string | number, ip: string): boolean {
  return aclCheck(d, String(name), { src: ip, dst: '0.0.0.0', proto: 'any', reply: false }).permit
}