import { matchesSpec, networkOf, inSubnet } from './ip'
import { emptySimState, resolveL2, type SimState } from './l2'
import { natIn, natOut } from './nat'
import { DEVICE_CATALOG, getDevice, isHost, isRouterLike, isSvi } from './network'
import { configured, lookup, routingTable as table, type L3Iface, type RouteCandidate } from './routing'
import type { Device, FwRule, Hop, Iface, PingResult, Proto, Topology } from './types'

export { emptySimState, type SimState }

const MAX_TTL = 32

/** A switch with an address on a VLAN interface can send and answer traffic itself (management). */
export const hasSvi = (d: Device) => d.type === 'switch' && d.ifaces.some((i) => isSvi(i.name) && i.ip && !i.shutdown)
/** Can originate and receive IP packets. */
export const speaksIp = (d: Device) => DEVICE_CATALOG[d.type].layer === 3 || hasSvi(d)
/** Picks its next hop like a host: local subnet, else the default gateway. */
const hostLike = (d: Device) => isHost(d) || d.type === 'switch'

interface Egress {
  iface: L3Iface
  nextHop: string
  detail: string
}

/** The routing table (`show ip route`). */
export function routingTable(topo: Topology, d: Device): RouteCandidate[] {
  return table(topo, d)
}

function chooseEgress(topo: Topology, d: Device, dstIp: string): Egress | string {
  const ifaces = d.ifaces.filter((i): i is L3Iface => configured(d, i))
  if (ifaces.length === 0) return `${d.name} has no IP address configured`

  if (hostLike(d)) {
    const local = ifaces.find((i) => inSubnet(dstIp, i.ip, i.prefix))
    if (local) return { iface: local, nextHop: dstIp, detail: `${dstIp} is on the local subnet` }
    if (!d.gateway)
      return d.type === 'switch'
        ? `${dstIp} is outside ${d.name}'s management subnet and no default gateway is set (ip default-gateway <router IP>)`
        : `${dstIp} is outside ${d.name}'s subnet and no default gateway is set`
    const gw = d.gateway
    const gwIface = ifaces.find((i) => inSubnet(gw, i.ip, i.prefix))
    if (!gwIface)
      return `Default gateway ${gw} is not inside ${d.name}'s subnet (${networkOf(ifaces[0].ip, ifaces[0].prefix)}/${ifaces[0].prefix})`
    return { iface: gwIface, nextHop: gw, detail: `not local, sending to gateway ${gw}` }
  }

  const best = lookup(topo, d, dstIp)
  if (!best) return `No route to ${dstIp} on ${d.name}`
  const via: Record<string, string> = { ospf: 'OSPF', 'ospf-ia': 'OSPF inter-area', 'ospf-e2': 'OSPF external', eigrp: 'EIGRP', rip: 'RIP', ebgp: 'eBGP', ibgp: 'iBGP', static: 'static route', dhcp: 'DHCP default route' }
  return {
    iface: best.iface,
    nextHop: best.kind === 'connected' ? dstIp : best.nextHop,
    detail:
      best.kind === 'connected'
        ? `${best.network}/${best.prefix} is directly connected on ${best.iface.name}`
        : `${via[best.kind]} ${best.network}/${best.prefix} via ${best.nextHop} (${best.iface.name})`,
  }
}

function firewallVerdict(
  fw: Device,
  src: string,
  dst: string,
  proto: Proto,
  port?: number,
): { allowed: boolean; rule?: number; text: string } {
  const idx = fw.fwRules.findIndex(
    (r: FwRule) =>
      matchesSpec(src, r.src) &&
      matchesSpec(dst, r.dst) &&
      (r.proto === 'any' || r.proto === proto) &&
      (r.port === undefined || r.port === port),
  )
  if (idx === -1)
    return { allowed: fw.fwDefault === 'allow', text: `default policy ${fw.fwDefault}` }
  const r = fw.fwRules[idx]
  return { allowed: r.action === 'allow', rule: idx + 1, text: `rule #${idx + 1} (${formatRule(r)})` }
}

export function formatRule(r: FwRule): string {
  return `${r.action} ${r.src} -> ${r.dst} ${r.proto}${r.port !== undefined ? '/' + r.port : ''}`
}

interface LegResult {
  ok: boolean
  reason: string
  /** Source address as the destination saw it (after NAT). */
  srcIp?: string
  target?: Device
  ttl: number
}

function forwardLeg(
  topo: Topology,
  state: SimState,
  src: Device,
  dstIn: string,
  proto: Proto,
  port: number | undefined,
  reply: boolean,
  hops: Hop[],
  srcIpIn?: string,
): LegResult {
  const hop = (d: Device, action: Hop['action'], detail: string, linkId?: string) =>
    hops.push({ deviceId: d.id, deviceName: d.name, action, detail, linkId, reply })

  let dstIp = dstIn
  if (src.ifaces.some((i) => i.ip === dstIp)) {
    hop(src, 'deliver', `${dstIp} is my own address`)
    return { ok: true, reason: '', srcIp: dstIp, target: src, ttl: MAX_TTL }
  }

  let cur = src
  let inIface: Iface | undefined
  let ttl = MAX_TTL
  let srcIp = srcIpIn

  for (;;) {
    const egress = chooseEgress(topo, cur, dstIp)
    if (typeof egress === 'string') {
      hop(cur, 'drop', egress)
      return { ok: false, reason: egress, srcIp, ttl }
    }
    srcIp ??= egress.iface.ip
    if (cur === src) hop(cur, 'send', `${srcIp} → ${dstIp}: ${egress.detail}`)
    else hops[hops.length - 1].detail += ` — ${egress.detail}`

    // Inside -> outside through a NAT router: the source address is rewritten.
    if (cur !== src && isRouterLike(cur)) {
      const translated = natOut(state, cur, inIface, egress.iface, srcIp, dstIp, proto)
      if (translated && translated !== srcIp) {
        hops[hops.length - 1].detail += ` — NAT: source ${srcIp} → ${translated}`
        srcIp = translated
      }
    }

    const l2 = resolveL2(topo, state, cur, egress.iface, egress.nextHop)
    if (typeof l2 === 'string') {
      hop(cur, 'drop', l2)
      return { ok: false, reason: l2, srcIp, ttl }
    }
    for (const step of l2.path.slice(0, -1)) {
      const sw = getDevice(topo, step.deviceId)!
      hop(sw, 'switch', `frame for ${l2.iface.mac} switched${step.vlan !== null ? ` in VLAN ${step.vlan}` : ''}`, step.linkId)
    }
    const arriveLink = l2.path[l2.path.length - 1].linkId
    const next = l2.device

    // Outside -> inside: a reply to a translated flow, or a static NAT mapping.
    let natNote = ''
    if (isRouterLike(next)) {
      const local = natIn(state, next, l2.iface, srcIp, dstIp)
      if (local) {
        natNote = ` — NAT: destination ${dstIp} → ${local}`
        dstIp = local
      }
    }

    if (next.ifaces.some((i) => i.ip === dstIp)) {
      hop(next, 'deliver', `${dstIp} reached on ${l2.iface.name}${natNote}`, arriveLink)
      return { ok: true, reason: '', srcIp, target: next, ttl }
    }
    if (!isRouterLike(next)) {
      const why = `${next.name} received a packet for ${dstIp} but is not a router (check the gateway)`
      hop(next, 'drop', why, arriveLink)
      return { ok: false, reason: why, srcIp, ttl }
    }
    ttl--
    if (ttl <= 0) {
      const why = `TTL expired at ${next.name} — routing loop?`
      hop(next, 'drop', why, arriveLink)
      return { ok: false, reason: why, srcIp, ttl }
    }
    if (next.type === 'firewall' && !reply) {
      const v = firewallVerdict(next, srcIp, dstIp, proto, port)
      if (!v.allowed) {
        const why = `Blocked by ${next.name} ${v.text}`
        hop(next, 'drop', why, arriveLink)
        return { ok: false, reason: why, srcIp, ttl }
      }
      hop(next, 'route', `${next.name} ${v.text}: allowed${natNote}`, arriveLink)
    } else {
      hop(next, 'route', `received on ${l2.iface.name}${natNote}`, arriveLink)
    }
    cur = next
    inIface = l2.iface
  }
}

/** Simulates a request and its reply. Firewalls are stateful: replies to allowed flows pass. */
export function sendPacket(
  topo: Topology,
  state: SimState,
  srcId: string,
  dstIp: string,
  proto: Proto = 'icmp',
  port?: number,
): PingResult {
  const src = getDevice(topo, srcId)
  if (!src) return { success: false, hops: [], message: 'Unknown source device' }
  if (!speaksIp(src))
    return {
      success: false,
      hops: [],
      message: src.type === 'switch' ? `${src.name} has no management address: interface vlan 1 → ip address …` : `${src.name} is a layer 2 device and cannot send packets`,
    }

  const hops: Hop[] = []
  const req = forwardLeg(topo, state, src, dstIp, proto, port, false, hops)
  if (!req.ok) {
    return { success: false, hops, message: `Destination unreachable: ${req.reason}` }
  }
  if (req.target === src) return { success: true, hops, message: `Reply from ${dstIp}: ttl=${MAX_TTL}` }

  // The reply goes back to the address the destination saw (the NAT address, if translated).
  const replyFrom = req.target!.ifaces.find((i) => i.ip === dstIp)?.ip ?? req.target!.ifaces.find((i) => i.ip)!.ip!
  const rep = forwardLeg(topo, state, req.target!, req.srcIp!, proto, port, true, hops, replyFrom)
  if (!rep.ok) {
    return { success: false, hops, message: `Request timed out: reply from ${dstIp} was lost — ${rep.reason}` }
  }
  return { success: true, hops, message: `Reply from ${dstIp}: ttl=${rep.ttl}` }
}

export function ping(topo: Topology, state: SimState, srcId: string, dstIp: string): PingResult {
  return sendPacket(topo, state, srcId, dstIp, 'icmp')
}
