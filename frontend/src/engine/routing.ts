/**
 * Routing tables: connected and static routes, plus what OSPF, EIGRP, RIP and BGP
 * learn. NetSim computes the converged result straight from the topology (no
 * timers): neighbors form when two routers share a subnet, can reach each other
 * at layer 2, and both run the protocol on that interface with matching settings.
 * Each router then keeps, per prefix, the route with the lowest administrative distance.
 */
import { inSubnet, intToIp, ipToInt, isValidIp, maskInt, networkOf } from './ip'
import { broadcastDomain } from './l2'
import { isRouterLike } from './network'
import type { Device, Iface, NetworkStatement, Route, Topology } from './types'

export type RouteKind = 'connected' | 'static' | 'dhcp' | 'ospf' | 'ospf-ia' | 'ospf-e2' | 'eigrp' | 'rip' | 'ebgp' | 'ibgp'

export const AD: Record<RouteKind, number> = { connected: 0, static: 1, ebgp: 20, eigrp: 90, ospf: 110, 'ospf-ia': 110, 'ospf-e2': 110, rip: 120, ibgp: 200, dhcp: 254 }

export type L3Iface = Iface & { ip: string; prefix: number }

export interface RouteCandidate {
  network: string
  prefix: number
  iface: L3Iface
  nextHop: string
  kind: RouteKind
  ad: number
  metric: number
}

/** Has an address and is not shut down, so it can carry traffic and has a connected route. */
export const configured = (d: Device, i: Iface): i is L3Iface =>
  i.ip !== undefined && i.prefix !== undefined && !i.shutdown && !d.ifaces.find((p) => p.name === i.name.split('.')[0])?.shutdown

// ---------- matching network statements ----------

/** `network 10.1.0.0 0.0.255.255` style match. */
export function wildcardMatch(ip: string, network: string, wildcard: string): boolean {
  const care = ~ipToInt(wildcard) >>> 0
  return ((ipToInt(ip) ^ ipToInt(network)) & care) >>> 0 === 0
}

/** Classful network of an address: 10.x -> /8, 172.16.x -> /16, 192.168.1.x -> /24. */
export function classfulPrefix(ip: string): number {
  const first = Number(ip.split('.')[0])
  return first < 128 ? 8 : first < 192 ? 16 : 24
}
export const classfulNetwork = (ip: string) => networkOf(ip, classfulPrefix(ip))

/** The most specific statement covering this address (IOS picks the longest match). */
function statementFor(ip: string, nets: NetworkStatement[]): NetworkStatement | undefined {
  const hits = nets.filter((n) => (n.wildcard ? wildcardMatch(ip, n.network, n.wildcard) : classfulNetwork(ip) === classfulNetwork(n.network)))
  return hits.sort((a, b) => ipToInt(a.wildcard ?? '0.255.255.255') - ipToInt(b.wildcard ?? '0.255.255.255'))[0]
}

// ---------- interface speeds ----------

function speed(i: Iface): { bw: number; delay: number } {
  const n = i.name
  if (n === 'lo0') return { bw: 8_000_000, delay: 5000 }
  if (n.startsWith('fa')) return { bw: 100_000, delay: 100 }
  return { bw: 1_000_000, delay: 10 }
}
export const ospfCost = (i: Iface) => i.ospfCost ?? Math.max(1, Math.floor(100_000 / speed(i).bw))

/** Router ID: configured, else the highest loopback address, else the highest interface address. */
export function routerId(d: Device, configuredId?: string): string | null {
  if (configuredId) return configuredId
  const ips = d.ifaces.filter((i) => configured(d, i))
  const lo = ips.filter((i) => i.name === 'lo0')
  const pool = lo.length ? lo : ips
  if (!pool.length) return null
  return intToIp(Math.max(...pool.map((i) => ipToInt(i.ip))))
}

// ---------- layer 3 adjacency ----------

export interface Adjacent {
  iface: L3Iface
  peer: Device
  peerIface: L3Iface
}

/** Router-like devices this one shares a subnet with and can reach at layer 2. */
function adjacencies(topo: Topology, d: Device): Adjacent[] {
  const out: Adjacent[] = []
  for (const i of d.ifaces) {
    if (!configured(d, i) || i.name === 'lo0') continue
    for (const h of broadcastDomain(topo, d, i)) {
      if (!isRouterLike(h.device) || !configured(h.device, h.iface)) continue
      if (!inSubnet(h.iface.ip, i.ip, i.prefix) || h.iface.prefix !== i.prefix) continue
      out.push({ iface: i, peer: h.device, peerIface: h.iface })
    }
  }
  return out
}

// ---------- protocol participation ----------

type Proto = 'ospf' | 'eigrp' | 'rip'

function enabledOn(d: Device, proto: Proto, i: L3Iface): { area?: number } | null {
  const c = d.ios
  if (proto === 'ospf') {
    const st = c?.ospf && statementFor(i.ip, c.ospf.networks)
    return st ? { area: st.area ?? 0 } : null
  }
  if (proto === 'eigrp') return c?.eigrp && statementFor(i.ip, c.eigrp.networks) ? {} : null
  return c?.rip && c.rip.networks.some((n) => classfulNetwork(n) === classfulNetwork(i.ip)) ? {} : null
}

const passive = (d: Device, proto: Proto, iface: string) => !!d.ios?.[proto]?.passive?.includes(iface)

export interface Neighbor {
  adj: Adjacent
  /** Empty when the neighbor relationship is up, else why not. */
  problem: string
}

/** Every router on a shared subnet, with whether `proto` forms a neighbor relationship there and why not. */
export function protocolNeighbors(topo: Topology, d: Device, proto: Proto): Neighbor[] {
  const out: Neighbor[] = []
  for (const adj of adjacencies(topo, d)) {
    const mine = enabledOn(d, proto, adj.iface)
    if (!mine) continue
    const name = proto.toUpperCase()
    const theirs = enabledOn(adj.peer, proto, adj.peerIface)
    let problem = ''
    if (passive(d, proto, adj.iface.name)) problem = `${adj.iface.name} is passive on ${d.name}`
    else if (!theirs) problem = `${adj.peer.name} does not run ${name} on ${adj.peerIface.name} (no matching network statement)`
    else if (passive(adj.peer, proto, adj.peerIface.name)) problem = `${adj.peerIface.name} is passive on ${adj.peer.name}`
    else if (proto === 'ospf' && mine.area !== theirs.area) problem = `area mismatch: ${d.name} has area ${mine.area}, ${adj.peer.name} has area ${theirs.area}`
    else if (proto === 'ospf' && routerId(d, d.ios?.ospf?.routerId) === routerId(adj.peer, adj.peer.ios?.ospf?.routerId))
      problem = `duplicate router ID ${routerId(d, d.ios?.ospf?.routerId)}`
    else if (proto === 'eigrp' && d.ios!.eigrp!.as !== adj.peer.ios!.eigrp!.as) problem = `AS mismatch: ${d.ios!.eigrp!.as} vs ${adj.peer.ios!.eigrp!.as}`
    out.push({ adj, problem })
  }
  return out
}

// ---------- BGP sessions ----------

export interface BgpSession {
  neighbor: string
  remoteAs: number
  state: 'Established' | 'Idle' | 'Active'
  problem: string
  peer?: Device
  /** Our interface toward the peer. */
  iface?: L3Iface
  ebgp: boolean
}

export function bgpSessions(topo: Topology, d: Device): BgpSession[] {
  const bgp = d.ios?.bgp
  if (!bgp) return []
  const adj = adjacencies(topo, d)
  return bgp.neighbors.map((n): BgpSession => {
    const base = { neighbor: n.ip, remoteAs: n.remoteAs, ebgp: n.remoteAs !== bgp.as }
    const a = adj.find((x) => x.peerIface.ip === n.ip)
    if (!a) {
      const owner = topo.devices.find((x) => x.ifaces.some((i) => i.ip === n.ip))
      return {
        ...base,
        state: 'Active',
        problem: owner ? `${n.ip} (${owner.name}) is not directly connected: NetSim BGP peers must share a subnet` : `nobody has address ${n.ip}`,
      }
    }
    const pb = a.peer.ios?.bgp
    if (!pb) return { ...base, state: 'Active', peer: a.peer, iface: a.iface, problem: `${a.peer.name} is not running BGP` }
    if (pb.as !== n.remoteAs) return { ...base, state: 'Idle', peer: a.peer, iface: a.iface, problem: `${a.peer.name} is in AS ${pb.as}, not ${n.remoteAs} (bad remote-as)` }
    const back = pb.neighbors.find((x) => x.ip === a.iface.ip)
    if (!back) return { ...base, state: 'Active', peer: a.peer, iface: a.iface, problem: `${a.peer.name} has no neighbor ${a.iface.ip} remote-as ${bgp.as}` }
    if (back.remoteAs !== bgp.as) return { ...base, state: 'Idle', peer: a.peer, iface: a.iface, problem: `${a.peer.name} expects AS ${back.remoteAs} for us, we are AS ${bgp.as}` }
    return { ...base, state: 'Established', peer: a.peer, iface: a.iface, problem: '' }
  })
}

// ---------- the routing table ----------

interface Advert {
  network: string
  prefix: number
  /** Router that advertises it. */
  origin: string
  /** OSPF: cost of the stub link; EIGRP: speed of the interface. */
  iface?: Iface
  area?: number
  external?: boolean
}

function connectedRoutes(d: Device): RouteCandidate[] {
  return d.ifaces
    .filter((i) => configured(d, i))
    .map((i) => ({ network: networkOf(i.ip, i.prefix), prefix: i.prefix, iface: i as L3Iface, nextHop: '-', kind: 'connected' as const, ad: 0, metric: 0 }))
}

/**
 * The interface a static route leaves through, or null while it can't be used: its exit
 * interface is down or unaddressed, or its next hop isn't in a connected subnet.
 */
export function staticEgress(d: Device, r: Route): L3Iface | null {
  const ifaces = d.ifaces.filter((i): i is L3Iface => configured(d, i))
  if (r.iface) {
    const i = ifaces.find((x) => x.name === r.iface)
    if (!i) return null
    return !r.via || inSubnet(r.via, i.ip, i.prefix) ? i : null
  }
  return ifaces.find((i) => inSubnet(r.via, i.ip, i.prefix)) ?? null
}

function staticRoutes(d: Device): RouteCandidate[] {
  const ifaces = d.ifaces.filter((i): i is L3Iface => configured(d, i))
  const out: RouteCandidate[] = []
  for (const r of d.routes) {
    const iface = staticEgress(d, r)
    // nextHop '-': an exit-interface route; each destination is ARPed for directly.
    if (iface) out.push({ network: r.network, prefix: r.prefix, iface, nextHop: r.via || '-', kind: 'static', ad: r.ad ?? 1, metric: 0 })
  }
  // A DHCP lease's default router becomes a default route (AD 254), like IOS.
  for (const i of ifaces) if (i.dhcp && i.dhcpGateway) out.push({ network: '0.0.0.0', prefix: 0, iface: i, nextHop: i.dhcpGateway, kind: 'dhcp', ad: 254, metric: 0 })
  return out
}

const key = (network: string, prefix: number) => `${network}/${prefix}`

function hasDefault(d: Device) {
  return staticRoutes(d).some((r) => r.prefix === 0)
}

/** Shortest paths from every router to every other, over the given neighbor links. */
function spf(routers: Device[], links: Map<string, { to: string; cost: number; iface: L3Iface; nextHop: string }[]>, root: string) {
  const dist = new Map<string, number>([[root, 0]])
  const first = new Map<string, { iface: L3Iface; nextHop: string }>()
  const done = new Set<string>()
  while (done.size < routers.length) {
    let u: string | null = null
    for (const [k, v] of dist) if (!done.has(k) && (u === null || v < dist.get(u)!)) u = k
    if (u === null) break
    done.add(u)
    for (const e of links.get(u) ?? []) {
      const nd = dist.get(u)! + e.cost
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd)
        first.set(e.to, u === root ? { iface: e.iface, nextHop: e.nextHop } : first.get(u)!)
      }
    }
  }
  return { dist, first }
}

function ospfRoutes(topo: Topology, routers: Device[], igp: Map<string, RouteCandidate[]>) {
  const members = routers.filter((r) => r.ios?.ospf && routerId(r, r.ios.ospf.routerId))
  const links = new Map<string, { to: string; cost: number; iface: L3Iface; nextHop: string }[]>()
  const adverts: Advert[] = []
  for (const r of members) {
    links.set(
      r.id,
      protocolNeighbors(topo, r, 'ospf')
        .filter((n) => !n.problem)
        .map((n) => ({ to: n.adj.peer.id, cost: ospfCost(n.adj.iface), iface: n.adj.iface, nextHop: n.adj.peerIface.ip })),
    )
    for (const i of r.ifaces) {
      if (!configured(r, i)) continue
      const on = enabledOn(r, 'ospf', i)
      if (!on) continue
      // Loopbacks are advertised as host routes, like real OSPF.
      const prefix = i.name === 'lo0' ? 32 : i.prefix
      adverts.push({ network: networkOf(i.ip, prefix), prefix, origin: r.id, iface: i, area: on.area })
    }
    if (r.ios!.ospf!.defaultOriginate && hasDefault(r)) adverts.push({ network: '0.0.0.0', prefix: 0, origin: r.id, external: true })
  }
  for (const r of members) {
    const { dist, first } = spf(members, links, r.id)
    const myAreas = new Set(r.ifaces.filter((i): i is L3Iface => configured(r, i)).map((i) => enabledOn(r, 'ospf', i)?.area).filter((a) => a !== undefined))
    const best = new Map<string, RouteCandidate>()
    for (const a of adverts) {
      if (a.origin === r.id || !dist.has(a.origin)) continue
      const hop = first.get(a.origin)!
      const metric = a.external ? 20 : dist.get(a.origin)! + ospfCost(a.iface!)
      const kind: RouteKind = a.external ? 'ospf-e2' : myAreas.has(a.area ?? 0) ? 'ospf' : 'ospf-ia'
      const k = key(a.network, a.prefix)
      const cur = best.get(k)
      if (!cur || metric < cur.metric) best.set(k, { network: a.network, prefix: a.prefix, iface: hop.iface, nextHop: hop.nextHop, kind, ad: 110, metric })
    }
    igp.get(r.id)!.push(...best.values())
  }
}

/** Distance-vector protocols (EIGRP, RIP): Bellman-Ford until nothing changes. */
function distanceVector(topo: Topology, routers: Device[], proto: 'eigrp' | 'rip', igp: Map<string, RouteCandidate[]>) {
  const members = routers.filter((r) => r.ios?.[proto])
  const nbrs = new Map(members.map((r) => [r.id, protocolNeighbors(topo, r, proto).filter((n) => !n.problem)]))
  type Entry = { bw: number; delay: number; hops: number; iface?: L3Iface; nextHop?: string; network: string; prefix: number }
  const table = new Map<string, Map<string, Entry>>(members.map((r) => [r.id, new Map()]))
  for (const r of members) {
    for (const i of r.ifaces) {
      if (!configured(r, i) || !enabledOn(r, proto, i)) continue
      const s = speed(i)
      table.get(r.id)!.set(key(networkOf(i.ip, i.prefix), i.prefix), { bw: s.bw, delay: s.delay, hops: 0, network: networkOf(i.ip, i.prefix), prefix: i.prefix })
    }
    if (proto === 'rip' && r.ios!.rip!.defaultOriginate && hasDefault(r)) table.get(r.id)!.set('0.0.0.0/0', { bw: 1e9, delay: 0, hops: 0, network: '0.0.0.0', prefix: 0 })
  }
  const metricOf = (e: Entry) => (proto === 'rip' ? e.hops : 256 * (Math.floor(1e7 / e.bw) + Math.floor(e.delay / 10)))
  for (let round = 0; round < members.length + 1; round++) {
    let changed = false
    for (const r of members) {
      const mine = table.get(r.id)!
      for (const n of nbrs.get(r.id)!) {
        const theirs = table.get(n.adj.peer.id)
        if (!theirs) continue
        const s = speed(n.adj.iface)
        for (const [k, e] of theirs) {
          // Split horizon: don't take back what we told them.
          if (e.nextHop && r.ifaces.some((i) => i.ip === e.nextHop)) continue
          const cand: Entry = { bw: Math.min(e.bw, s.bw), delay: e.delay + s.delay, hops: e.hops + 1, iface: n.adj.iface, nextHop: n.adj.peerIface.ip, network: e.network, prefix: e.prefix }
          if (proto === 'rip' && cand.hops > 15) continue
          const cur = mine.get(k)
          if (cur && cur.hops === 0) continue
          if (!cur || metricOf(cand) < metricOf(cur)) {
            mine.set(k, cand)
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }
  for (const r of members)
    for (const e of table.get(r.id)!.values())
      if (e.hops > 0) igp.get(r.id)!.push({ network: e.network, prefix: e.prefix, iface: e.iface!, nextHop: e.nextHop!, kind: proto, ad: AD[proto], metric: metricOf(e) })
}

function bgpRoutes(topo: Topology, routers: Device[], ribs: Map<string, RouteCandidate[]>) {
  const members = routers.filter((r) => r.ios?.bgp)
  const sessions = new Map(members.map((r) => [r.id, bgpSessions(topo, r).filter((s) => s.state === 'Established')]))
  type Path = { network: string; prefix: number; asPath: number[]; nextHop?: string; iface?: L3Iface; ibgp: boolean; local: boolean }
  const best = new Map<string, Map<string, Path>>(members.map((r) => [r.id, new Map()]))
  for (const r of members)
    for (const n of r.ios!.bgp!.networks) {
      // `network` only advertises prefixes this router already has an exact route for.
      if (!ribs.get(r.id)!.some((x) => x.network === n.network && x.prefix === n.prefix)) continue
      best.get(r.id)!.set(key(n.network, n.prefix), { network: n.network, prefix: n.prefix, asPath: [], ibgp: false, local: true })
    }
  const better = (a: Path, b: Path) => (a.asPath.length !== b.asPath.length ? a.asPath.length < b.asPath.length : !a.ibgp && b.ibgp)
  for (let round = 0; round < members.length * 2 + 1; round++) {
    let changed = false
    for (const r of members) {
      const myAs = r.ios!.bgp!.as
      for (const s of sessions.get(r.id)!) {
        const from = best.get(s.peer!.id)
        if (!from) continue
        for (const [k, p] of from) {
          // iBGP-learned routes are not passed to other iBGP peers.
          if (!s.ebgp && p.ibgp) continue
          const asPath = s.ebgp ? [s.remoteAs, ...p.asPath] : p.asPath
          if (asPath.includes(myAs)) continue
          const cand: Path = { network: p.network, prefix: p.prefix, asPath, nextHop: s.neighbor, iface: s.iface, ibgp: !s.ebgp, local: false }
          const cur = best.get(r.id)!.get(k)
          if (cur?.local) continue
          // Take a better path, or an update from the peer we already use.
          const update = cur && cur.nextHop === cand.nextHop && cur.asPath.join() !== cand.asPath.join()
          if (!cur || better(cand, cur) || update) {
            best.get(r.id)!.set(k, cand)
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }
  const out = new Map<string, (RouteCandidate & { asPath: number[] })[]>()
  for (const r of members) {
    out.set(
      r.id,
      [...best.get(r.id)!.values()]
        .filter((p) => !p.local)
        .map((p) => ({ network: p.network, prefix: p.prefix, iface: p.iface!, nextHop: p.nextHop!, kind: p.ibgp ? ('ibgp' as const) : ('ebgp' as const), ad: p.ibgp ? 200 : 20, metric: 0, asPath: p.asPath })),
    )
  }
  return { out, best }
}

/** Keeps the lowest administrative distance (then metric) per prefix. */
function select(routes: RouteCandidate[]): RouteCandidate[] {
  const best = new Map<string, RouteCandidate>()
  const extra: RouteCandidate[] = []
  for (const r of routes) {
    const k = key(r.network, r.prefix)
    const cur = best.get(k)
    // Several connected interfaces in one subnet would be a misconfiguration; keep them all.
    if (cur && cur.kind === 'connected' && r.kind === 'connected') extra.push(r)
    else if (!cur || r.ad < cur.ad || (r.ad === cur.ad && r.metric < cur.metric)) best.set(k, r)
  }
  return [...best.values(), ...extra]
}

interface Computed {
  sig: string
  ribs: Map<string, RouteCandidate[]>
  bgpTables: Map<string, Map<string, { network: string; prefix: number; asPath: number[]; nextHop?: string; local: boolean }>>
}
const cache = new WeakMap<Topology, Computed>()

function signature(topo: Topology): string {
  return JSON.stringify([
    topo.devices.map((d) => [d.id, d.type, d.ifaces, d.routes, d.ios?.ospf, d.ios?.eigrp, d.ios?.rip, d.ios?.bgp, d.ios?.vlans, d.ios?.wlan, d.ios?.nat]),
    topo.links.map((l) => [l.id, l.a, l.b, l.up, l.cable, l.wifi]),
  ])
}

function compute(topo: Topology): Computed {
  const sig = signature(topo)
  const hit = cache.get(topo)
  if (hit && hit.sig === sig) return hit
  const routers = topo.devices.filter(isRouterLike)
  const ribs = new Map<string, RouteCandidate[]>()
  const igp = new Map<string, RouteCandidate[]>(routers.map((r) => [r.id, []]))
  ospfRoutes(topo, routers, igp)
  distanceVector(topo, routers, 'eigrp', igp)
  distanceVector(topo, routers, 'rip', igp)
  for (const r of routers) ribs.set(r.id, select([...connectedRoutes(r), ...staticRoutes(r), ...igp.get(r.id)!]))
  const { out: bgp, best } = bgpRoutes(topo, routers, ribs)
  for (const [id, routes] of bgp) ribs.set(id, select([...ribs.get(id)!, ...routes]))
  const res: Computed = { sig, ribs, bgpTables: best }
  cache.set(topo, res)
  return res
}

/**
 * A device's routing table: the best route per prefix. Routers learn from their
 * protocols; anything else just has its connected subnets and static routes.
 */
export function routingTable(topo: Topology, d: Device): RouteCandidate[] {
  if (isRouterLike(d)) return compute(topo).ribs.get(d.id) ?? []
  return select([...connectedRoutes(d), ...staticRoutes(d)])
}

/** The best route for a destination: longest prefix match. */
export function lookup(topo: Topology, d: Device, dstIp: string): RouteCandidate | undefined {
  let best: RouteCandidate | undefined
  for (const r of routingTable(topo, d)) if (inSubnet(dstIp, r.network, r.prefix) && (!best || r.prefix > best.prefix)) best = r
  return best
}

/** The BGP table (`show ip bgp`): best path per prefix, including our own networks. */
export function bgpTable(topo: Topology, d: Device) {
  return [...(compute(topo).bgpTables.get(d.id)?.values() ?? [])]
}

/** Address and prefix from `network A.B.C.D mask M` style input. */
export function parseNetMask(net: string, mask: string): { network: string; prefix: number } | null {
  if (!isValidIp(net) || !isValidIp(mask)) return null
  const n = ipToInt(mask) >>> 0
  for (let p = 0; p <= 32; p++) if (maskInt(p) >>> 0 === n) return { network: networkOf(net, p), prefix: p }
  return null
}

