/**
 * Spanning tree, one tree per VLAN like Cisco's PVST+ / Rapid PVST+. NetSim computes
 * the converged result straight from the topology (no BPDU timers):
 *
 *  1. Root bridge: the lowest bridge ID (priority + VLAN number, then MAC).
 *  2. Root port on every other switch: its cheapest path to the root (port cost 19 for
 *     FastEthernet, 4 for gigabit), ties broken by the neighbor's bridge ID, then port ID.
 *  3. Designated port on each link: the end with the lower root path cost (then bridge
 *     ID, port ID). Root bridge ports are all designated.
 *  4. Everything else between switches is an alternate port: blocking. That is what
 *     breaks loops; if a forwarding link fails, the blocked port takes over.
 *
 * Ports to hosts, routers and APs are designated (forwarding). The result is cached
 * until the switches, their settings or the cables change.
 */
import { getDevice, linkActive, linkOn, patchPartner, peerOf } from './network'
import type { Device, Iface, Topology } from './types'

export type StpRole = 'Root' | 'Desg' | 'Altn'

export interface StpPort {
  port: string
  role: StpRole
  /** Forwarding or blocking. */
  forwarding: boolean
  cost: number
  /** 128.N, the port ID used in tie-breaks. */
  portId: number
  /** The switch on the other end, when there is one. */
  peer?: { switchId: string; port: string }
  edge: boolean
}

export interface StpSwitch {
  id: string
  name: string
  priority: number
  mac: string
  rootCost: number
  rootPort?: string
  ports: StpPort[]
}

export interface StpTree {
  vlan: number
  root: StpSwitch
  switches: Map<string, StpSwitch>
}

/** Default port costs (802.1D short method, as Cisco PVST uses). */
export const portCost = (i: Iface) => i.stp?.cost ?? (i.name.startsWith('fa') ? 19 : 4)

/** Bridge priority for a VLAN: configured, or 32768; the VLAN number is added (sys-id-ext). */
export const bridgePriority = (d: Device, vlan: number) => (d.ios?.stp?.priority?.[vlan] ?? 32768) + vlan

/** The switch's base MAC: its first port's address. */
const baseMac = (d: Device) => d.ifaces[0]?.mac ?? '00:00:00:00:00:00'

/** Does this switch port carry `vlan`? */
function carries(d: Device, i: Iface, vlan: number): boolean {
  if (vlan !== 1 && d.ios?.vlans?.[vlan] === undefined) return false
  const sp = i.switchport
  if (!sp || sp.mode === 'access') return (sp?.vlan ?? 1) === vlan
  return !sp.allowed || sp.allowed.includes(vlan)
}

/** Follow a cable from a port, through patch panels, to the device and port at the far end. */
function farEnd(topo: Topology, deviceId: string, port: string): { device: Device; port: string } | null {
  let l = linkOn(topo, deviceId, port)
  let from = { device: deviceId, iface: port }
  for (let hops = 0; l && hops < 8; hops++) {
    if (!linkActive(topo, l)) return null
    const peer = peerOf(l, from.device, from.iface)
    const d = getDevice(topo, peer.device)
    if (!d) return null
    if (d.type !== 'patch') return { device: d, port: peer.iface }
    from = { device: d.id, iface: patchPartner(peer.iface) }
    l = linkOn(topo, from.device, from.iface)
  }
  return null
}

const portIdOf = (d: Device, port: string) => 128 * 1000 + d.ifaces.findIndex((i) => i.name === port) + 1
/** Bridge IDs compare by priority, then MAC. */
const bidLess = (a: StpSwitch, b: StpSwitch) => (a.priority !== b.priority ? a.priority < b.priority : a.mac < b.mac)

function compute(topo: Topology, vlan: number): StpTree | null {
  const switches = topo.devices.filter((d) => d.type === 'switch' && (vlan === 1 || d.ios?.vlans?.[vlan] !== undefined))
  if (!switches.length) return null
  const info = new Map<string, StpSwitch>(
    switches.map((d) => [d.id, { id: d.id, name: d.name, priority: bridgePriority(d, vlan), mac: baseMac(d), rootCost: Infinity, ports: [] as StpPort[] }]),
  )
  // Segments: each up port that carries the VLAN, and what's at its far end.
  type Seg = { sw: Device; port: Iface; peer?: { sw: Device; port: Iface } }
  const segs: Seg[] = []
  for (const d of switches)
    for (const i of d.ifaces) {
      if (!(i.name.startsWith('fa') || i.name.startsWith('g')) || i.shutdown || i.errDisabled || !carries(d, i, vlan)) continue
      const far = farEnd(topo, d.id, i.name)
      if (!far) continue
      const pi = far.device.ifaces.find((x) => x.name === far.port)
      if (far.device.type === 'switch' && info.has(far.device.id) && pi && !pi.shutdown && !pi.errDisabled && carries(far.device, pi, vlan)) segs.push({ sw: d, port: i, peer: { sw: far.device, port: pi } })
      else segs.push({ sw: d, port: i })
    }

  const root = [...info.values()].reduce((a, b) => (bidLess(b, a) ? b : a))
  root.rootCost = 0
  // Dijkstra over switches: reaching S through its port P costs P's cost.
  const done = new Set<string>()
  type Best = { cost: number; viaBid: StpSwitch; viaPortId: number; ownPortId: number; port: string }
  const best = new Map<string, Best>()
  while (done.size < info.size) {
    let u: StpSwitch | null = null
    for (const s of info.values()) if (!done.has(s.id) && s.rootCost < Infinity && (!u || s.rootCost < u.rootCost)) u = s
    if (!u) break
    done.add(u.id)
    for (const sg of segs) {
      if (!sg.peer || sg.peer.sw.id !== u.id) continue
      const s = info.get(sg.sw.id)!
      if (done.has(s.id)) continue
      const cand: Best = { cost: u.rootCost + portCost(sg.port), viaBid: u, viaPortId: portIdOf(sg.peer.sw, sg.peer.port.name), ownPortId: portIdOf(sg.sw, sg.port.name), port: sg.port.name }
      const cur = best.get(s.id)
      const better =
        !cur ||
        cand.cost < cur.cost ||
        (cand.cost === cur.cost && (bidLess(cand.viaBid, cur.viaBid) || (cand.viaBid === cur.viaBid && (cand.viaPortId < cur.viaPortId || (cand.viaPortId === cur.viaPortId && cand.ownPortId < cur.ownPortId))))))
      if (better) {
        best.set(s.id, cand)
        s.rootCost = cand.cost
        s.rootPort = cand.port
      }
    }
  }

  // Roles per port.
  for (const sg of segs) {
    const me = info.get(sg.sw.id)!
    const edge = !sg.peer
    let role: StpRole
    if (edge) role = 'Desg'
    else if (me.rootPort === sg.port.name) role = 'Root'
    else {
      const them = info.get(sg.peer!.sw.id)!
      const mine = [me.rootCost, me, portIdOf(sg.sw, sg.port.name)] as const
      const theirs = [them.rootCost, them, portIdOf(sg.peer!.sw, sg.peer!.port.name)] as const
      const iWin = mine[0] !== theirs[0] ? mine[0] < theirs[0] : mine[1] !== theirs[1] ? bidLess(mine[1], theirs[1]) : mine[2] < theirs[2]
      role = iWin ? 'Desg' : 'Altn'
    }
    me.ports.push({
      port: sg.port.name,
      role,
      forwarding: role !== 'Altn',
      cost: portCost(sg.port),
      portId: portIdOf(sg.sw, sg.port.name) - 128 * 1000,
      ...(sg.peer ? { peer: { switchId: sg.peer.sw.id, port: sg.peer.port.name } } : {}),
      edge: edge && !!sg.port.stp?.portfast,
    })
  }
  return { vlan, root, switches: info }
}

const cache = new WeakMap<Topology, { sig: string; trees: Map<number, StpTree | null> }>()

function signature(topo: Topology): string {
  return JSON.stringify([
    topo.devices.filter((d) => d.type === 'switch' || d.type === 'patch').map((d) => [d.id, d.ios?.stp, d.ios?.vlans, d.ifaces.map((i) => [i.name, i.switchport, i.shutdown, i.errDisabled, i.stp, i.mac])]),
    topo.links.map((l) => [l.a, l.b, l.up, l.cable]),
  ])
}

/** The spanning tree for a VLAN (null when no switch has it). */
export function spanningTree(topo: Topology, vlan: number): StpTree | null {
  const sig = signature(topo)
  let c = cache.get(topo)
  if (!c || c.sig !== sig) {
    c = { sig, trees: new Map() }
    cache.set(topo, c)
  }
  if (!c.trees.has(vlan)) c.trees.set(vlan, compute(topo, vlan))
  return c.trees.get(vlan)!
}

/** Whether STP blocks a switch port in a VLAN (frames neither come in nor go out). */
export function stpBlocks(topo: Topology, switchId: string, port: string, vlan: number): boolean {
  const p = spanningTree(topo, vlan)?.switches.get(switchId)?.ports.find((x) => x.port === port)
  return !!p && !p.forwarding
}