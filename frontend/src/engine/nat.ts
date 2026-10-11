/**
 * NAT on IOS routers: `ip nat inside` / `ip nat outside` on interfaces, then either
 * static one-to-one mappings or PAT (`overload`) behind the outside interface's
 * address for the hosts an access list permits. Translations live in the runtime
 * state, so replies can be translated back.
 */
import { wildcardMatch } from './routing'
import type { NatEntry, SimState } from './l2'
import type { Device, Iface } from './types'

/** First matching line of a numbered standard ACL; no match = implicit deny. */
export function aclPermits(d: Device, acl: number, ip: string): boolean {
  for (const e of d.ios?.acls?.[acl] ?? []) {
    const hit = e.src === 'any' || (e.wildcard ? wildcardMatch(ip, e.src, e.wildcard) : ip === e.src)
    if (hit) return e.action === 'permit'
  }
  return false
}

const table = (state: SimState, d: Device) => ((state.nat ??= {})[d.id] ??= [])

/** Inside -> outside: the source address the packet leaves with, or null if it isn't translated. */
export function natOut(state: SimState, d: Device, inIface: Iface | undefined, outIface: Iface & { ip: string }, src: string, dst: string, proto: string): string | null {
  const nat = d.ios?.nat
  if (!nat || inIface?.nat !== 'inside' || outIface.nat !== 'outside') return null
  const entries = table(state, d)
  const st = nat.statics.find((s) => s.local === src)
  if (st) {
    if (!entries.some((e) => e.kind === 'static' && e.insideLocal === src && e.outside === dst && e.proto === proto))
      entries.push({ kind: 'static', proto, insideLocal: src, insideGlobal: st.global, outside: dst })
    return st.global
  }
  const ov = nat.overload
  if (ov && ov.iface === outIface.name && aclPermits(d, ov.acl, src)) {
    let e = entries.find((x) => x.kind === 'overload' && x.insideLocal === src && x.outside === dst && x.proto === proto)
    if (!e) {
      e = { kind: 'overload', proto, insideLocal: src, insideGlobal: outIface.ip, outside: dst, port: 1024 + entries.length }
      entries.push(e)
    }
    return outIface.ip
  }
  return null
}

/** Outside -> inside: the inside address a packet for `dst` (from `src`) goes to, or null. */
export function natIn(state: SimState, d: Device, inIface: Iface, src: string, dst: string): string | null {
  const nat = d.ios?.nat
  if (!nat || inIface.nat !== 'outside') return null
  const e = table(state, d).find((x: NatEntry) => x.insideGlobal === dst && x.outside === src)
  if (e) return e.insideLocal
  // Static mappings also accept new connections from outside.
  return nat.statics.find((s) => s.global === dst)?.local ?? null
}
