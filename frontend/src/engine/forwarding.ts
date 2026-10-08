import { inSubnet, matchesSpec, networkOf } from './ip'
import { cableProblem, DEVICE_CATALOG, getDevice, isBridge, isHost, linkActive, linkOn, linksOn, patchPartner, peerOf } from './network'
import type { Device, FwRule, Hop, Iface, PingResult, Proto, Topology } from './types'

const MAX_TTL = 32

/** Runtime tables learned while traffic flows. Not part of the saved topology. */
export interface SimState {
  /** deviceId -> ip -> mac */
  arp: Record<string, Record<string, string>>
  /** switchId -> mac -> port */
  mac: Record<string, Record<string, string>>
}

export function emptySimState(): SimState {
  return { arp: {}, mac: {} }
}

const isL3 = (d: Device) => DEVICE_CATALOG[d.type].layer === 3
/** Has an address and is not shut down, so it can carry traffic and has a connected route. */
const configured = (i: Iface): i is Iface & { ip: string; prefix: number } =>
  i.ip !== undefined && i.prefix !== undefined && !i.shutdown

interface Egress {
  iface: Iface & { ip: string; prefix: number }
  nextHop: string
  detail: string
}

interface RouteCandidate {
  network: string
  prefix: number
  iface: Iface & { ip: string; prefix: number }
  nextHop: string
  kind: 'connected' | 'static'
}

export function routingTable(d: Device, dstIp?: string): RouteCandidate[] {
  const out: RouteCandidate[] = []
  const ifaces = d.ifaces.filter(configured)
  for (const i of ifaces) {
    out.push({
      network: networkOf(i.ip, i.prefix),
      prefix: i.prefix,
      iface: i,
      nextHop: dstIp ?? '-',
      kind: 'connected',
    })
  }
  for (const r of d.routes) {
    const iface = ifaces.find((i) => inSubnet(r.via, i.ip, i.prefix))
    if (iface) out.push({ network: r.network, prefix: r.prefix, iface, nextHop: r.via, kind: 'static' })
  }
  return out
}

function chooseEgress(d: Device, dstIp: string): Egress | string {
  const ifaces = d.ifaces.filter(configured)
  if (ifaces.length === 0) return `${d.name} has no IP address configured`

  if (isHost(d)) {
    const local = ifaces.find((i) => inSubnet(dstIp, i.ip, i.prefix))
    if (local) return { iface: local, nextHop: dstIp, detail: `${dstIp} is on the local subnet` }
    if (!d.gateway)
      return `${dstIp} is outside ${d.name}'s subnet and no default gateway is set`
    const gw = d.gateway
    const gwIface = ifaces.find((i) => inSubnet(gw, i.ip, i.prefix))
    if (!gwIface)
      return `Default gateway ${gw} is not inside ${d.name}'s subnet (${networkOf(ifaces[0].ip, ifaces[0].prefix)}/${ifaces[0].prefix})`
    return { iface: gwIface, nextHop: gw, detail: `not local, sending to gateway ${gw}` }
  }

  const candidates = routingTable(d, dstIp).filter((r) => inSubnet(dstIp, r.network, r.prefix))
  if (candidates.length === 0) return `No route to ${dstIp} on ${d.name}`
  const best = candidates.reduce((a, b) => (b.prefix > a.prefix ? b : a))
  return {
    iface: best.iface,
    nextHop: best.nextHop,
    detail:
      best.kind === 'connected'
        ? `${best.network}/${best.prefix} is directly connected on ${best.iface.name}`
        : `route ${best.network}/${best.prefix} via ${best.nextHop} (${best.iface.name})`,
  }
}

interface L2Step {
  deviceId: string
  linkId: string
}

interface L2Found {
  device: Device
  iface: Iface
  path: L2Step[]
}

/** Finds which L3 interface owns `targetIp` in the broadcast domain behind `egress` (ARP). */
function resolveL2(
  topo: Topology,
  state: SimState,
  from: Device,
  egress: Iface,
  targetIp: string,
): L2Found | string {
  const first = linkOn(topo, from.id, egress.name)
  if (!first) return `${egress.name} on ${from.name} is not cabled`
  if (!linkActive(topo, first)) {
    const why = cableProblem(topo, first)
    return why ? `Link on ${from.name} ${egress.name} is down: ${why}` : `Link on ${from.name} ${egress.name} is down`
  }

  type Node = { linkId: string; dev: string; iface: string; path: L2Step[] }
  const startPeer = peerOf(first, from.id, egress.name)
  const queue: Node[] = [{ linkId: first.id, dev: startPeer.device, iface: startPeer.iface, path: [] }]
  const seenSwitches = new Set<string>()
  // A phone sending its own traffic can also reach the PC on its pc port.
  if (from.type === 'phone') {
    const pc = linkOn(topo, from.id, 'pc')
    if (pc && linkActive(topo, pc)) {
      const peer = peerOf(pc, from.id, 'pc')
      queue.push({ linkId: pc.id, dev: peer.device, iface: peer.iface, path: [] })
    }
  }

  while (queue.length) {
    const node = queue.shift()!
    const dev = getDevice(topo, node.dev)
    if (!dev) continue
    const path = [...node.path, { deviceId: dev.id, linkId: node.linkId }]

    if (dev.type === 'patch') {
      // Passive: the frame comes out of the same port number on the other side.
      const out = linkOn(topo, dev.id, patchPartner(node.iface))
      if (out && linkActive(topo, out)) {
        const peer = peerOf(out, dev.id, patchPartner(node.iface))
        queue.push({ linkId: out.id, dev: peer.device, iface: peer.iface, path })
      }
      continue
    }
    // IP phone: answers for its own IP, and switches everything else between its two ports.
    if (dev.type === 'phone' && !dev.ifaces.some((i) => i.ip === targetIp)) {
      if (seenSwitches.has(dev.id)) continue
      seenSwitches.add(dev.id)
      const other = node.iface === 'pc' ? 'eth0' : 'pc'
      const out = linkOn(topo, dev.id, other)
      if (out && linkActive(topo, out)) {
        const peer = peerOf(out, dev.id, other)
        queue.push({ linkId: out.id, dev: peer.device, iface: peer.iface, path })
      }
      continue
    }
    if (isBridge(dev)) {
      if (seenSwitches.has(dev.id)) continue
      seenSwitches.add(dev.id)
      // Flood out every other link. An AP radio carries several links, so two
      // Wi-Fi clients on the same AP reach each other through it.
      for (const l of linksOn(topo, dev.id)) {
        if (l.id === node.linkId || !linkActive(topo, l)) continue
        const here = l.a.device === dev.id ? l.a : l.b
        if (dev.ifaces.find((i) => i.name === here.iface)?.shutdown) continue
        const peer = peerOf(l, dev.id, here.iface)
        queue.push({ linkId: l.id, dev: peer.device, iface: peer.iface, path })
      }
      continue
    }

    // A phone reached on either port answers with its eth0 address.
    const iface = dev.type === 'phone' ? dev.ifaces.find((i) => i.ip === targetIp) : dev.ifaces.find((i) => i.name === node.iface)
    if (iface?.ip === targetIp) {
      // Learn: sender caches the MAC, switches learn the sender's port.
      ;(state.arp[from.id] ??= {})[targetIp] = iface.mac
      for (let k = 0; k < path.length - 1; k++) {
        const sw = path[k].deviceId
        const l = topo.links.find((x) => x.id === path[k].linkId)!
        const port = l.a.device === sw ? l.a.iface : l.b.iface
        ;(state.mac[sw] ??= {})[egress.mac] = port
        const next = topo.links.find((x) => x.id === path[k + 1].linkId)!
        const outPort = next.a.device === sw ? next.a.iface : next.b.iface
        state.mac[sw][iface.mac] = outPort
      }
      return { device: dev, iface, path }
    }
  }
  return `ARP: no reply for ${targetIp} — no device with that IP is reachable from ${from.name} ${egress.name}`
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
  srcIp?: string
  target?: Device
  ttl: number
}

function forwardLeg(
  topo: Topology,
  state: SimState,
  src: Device,
  dstIp: string,
  proto: Proto,
  port: number | undefined,
  reply: boolean,
  hops: Hop[],
  srcIpIn?: string,
): LegResult {
  const hop = (d: Device, action: Hop['action'], detail: string, linkId?: string) =>
    hops.push({ deviceId: d.id, deviceName: d.name, action, detail, linkId, reply })

  if (src.ifaces.some((i) => i.ip === dstIp)) {
    hop(src, 'deliver', `${dstIp} is my own address`)
    return { ok: true, reason: '', srcIp: dstIp, target: src, ttl: MAX_TTL }
  }

  let cur = src
  let ttl = MAX_TTL
  let srcIp = srcIpIn

  for (;;) {
    const egress = chooseEgress(cur, dstIp)
    if (typeof egress === 'string') {
      hop(cur, 'drop', egress)
      return { ok: false, reason: egress, srcIp, ttl }
    }
    srcIp ??= egress.iface.ip
    if (cur === src) hop(cur, 'send', `${srcIp} → ${dstIp}: ${egress.detail}`)
    else hops[hops.length - 1].detail += ` — ${egress.detail}`

    const l2 = resolveL2(topo, state, cur, egress.iface, egress.nextHop)
    if (typeof l2 === 'string') {
      hop(cur, 'drop', l2)
      return { ok: false, reason: l2, srcIp, ttl }
    }
    for (const step of l2.path.slice(0, -1)) {
      const sw = getDevice(topo, step.deviceId)!
      hop(sw, 'switch', `frame for ${l2.iface.mac} switched`, step.linkId)
    }
    const arriveLink = l2.path[l2.path.length - 1].linkId
    const next = l2.device

    if (next.ifaces.some((i) => i.ip === dstIp)) {
      hop(next, 'deliver', `${dstIp} reached on ${l2.iface.name}`, arriveLink)
      return { ok: true, reason: '', srcIp, target: next, ttl }
    }
    if (!isL3(next) || isHost(next)) {
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
      hop(next, 'route', `${next.name} ${v.text}: allowed`, arriveLink)
    } else {
      hop(next, 'route', `received on ${l2.iface.name}`, arriveLink)
    }
    cur = next
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
  if (!isL3(src)) return { success: false, hops: [], message: `${src.name} is a layer 2 switch and cannot send packets` }

  const hops: Hop[] = []
  const req = forwardLeg(topo, state, src, dstIp, proto, port, false, hops)
  if (!req.ok) {
    return { success: false, hops, message: `Destination unreachable: ${req.reason}` }
  }
  if (req.target === src) return { success: true, hops, message: `Reply from ${dstIp}: ttl=${MAX_TTL}` }

  const rep = forwardLeg(topo, state, req.target!, req.srcIp!, proto, port, true, hops, dstIp)
  if (!rep.ok) {
    return { success: false, hops, message: `Request timed out: reply from ${dstIp} was lost — ${rep.reason}` }
  }
  return { success: true, hops, message: `Reply from ${dstIp}: ttl=${rep.ttl}` }
}

export function ping(topo: Topology, state: SimState, srcId: string, dstIp: string): PingResult {
  return sendPacket(topo, state, srcId, dstIp, 'icmp')
}
