/**
 * Layer 2: how a frame travels from an interface to the device that owns an IP,
 * through cables, patch panels, phones, access points and VLAN-aware switches.
 *
 * Frames carry an 802.1Q tag (a VLAN number) or none. Switch access ports put
 * untagged frames into their VLAN; trunks carry tagged frames for the VLANs they
 * allow plus the native VLAN untagged. Router subinterfaces (g0/0.10) send and
 * receive frames tagged with their VLAN; a switch's VLAN interface (SVI, vlan10)
 * answers for the switch's own address in that VLAN.
 */
import { cableProblem, getDevice, isBridge, isSubIface, isSvi, linkActive, linkOn, linksOn, patchPartner, peerOf, physPort } from './network'
import type { Device, Iface, Switchport, Topology } from './types'

/** Runtime tables learned while traffic flows. Not part of the saved topology. */
export interface SimState {
  /** deviceId -> ip -> mac */
  arp: Record<string, Record<string, string>>
  /** switchId -> mac -> port */
  mac: Record<string, Record<string, string>>
  /** switchId -> mac -> VLAN the MAC was learned in */
  macVlan?: Record<string, Record<string, number>>
  /** routerId -> NAT translations */
  nat?: Record<string, NatEntry[]>
}

export interface NatEntry {
  proto: string
  insideLocal: string
  insideGlobal: string
  outside: string
  port?: number
  kind: 'static' | 'overload'
}

export function emptySimState(): SimState {
  return { arp: {}, mac: {}, macVlan: {}, nat: {} }
}

// ---------- switch ports ----------

export const DEFAULT_PORT: Switchport = { mode: 'access', vlan: 1 }

export function switchport(d: Device, iface: string): Switchport {
  return d.ifaces.find((i) => i.name === iface)?.switchport ?? DEFAULT_PORT
}

/** VLAN 1 always exists; others once created (`vlan 10`, or by `switchport access vlan 10`). */
export function vlanExists(d: Device, vlan: number): boolean {
  return vlan === 1 || d.ios?.vlans?.[vlan] !== undefined
}

export function trunkAllows(sp: Switchport, vlan: number): boolean {
  return !sp.allowed || sp.allowed.includes(vlan)
}

/** The VLAN a frame arriving on this port belongs to, or null if the port drops it. */
export function ingressVlan(sp: Switchport, tag: number | null): number | null {
  if (sp.mode === 'access') return tag === null ? (sp.vlan ?? 1) : null
  const vlan = tag ?? sp.native ?? 1
  return trunkAllows(sp, vlan) ? vlan : null
}

/** How a frame in `vlan` leaves this port: its tag (null = untagged), or undefined if it doesn't. */
export function egressTag(sp: Switchport, vlan: number): number | null | undefined {
  if (sp.mode === 'access') return (sp.vlan ?? 1) === vlan ? null : undefined
  if (!trunkAllows(sp, vlan)) return undefined
  return vlan === (sp.native ?? 1) ? null : vlan
}

/** The tag an L3 interface puts on its frames. */
export const ifaceTag = (i: Iface): number | null => (isSubIface(i.name) && i.vlan !== undefined && !i.nativeVlan ? i.vlan : null)

/** The interface of an L3 device that takes a frame arriving on `port` with `tag`. */
function receiver(dev: Device, port: string, tag: number | null): Iface[] {
  if (tag === null)
    return dev.ifaces.filter((i) => i.name === port || (isSubIface(i.name) && physPort(i.name) === port && i.nativeVlan))
  return dev.ifaces.filter((i) => isSubIface(i.name) && physPort(i.name) === port && i.vlan === tag && !i.nativeVlan)
}

const up = (dev: Device, i: Iface) => !i.shutdown && !dev.ifaces.find((p) => p.name === physPort(i.name))?.shutdown

// ---------- walking the broadcast domain ----------

export interface L2Step {
  deviceId: string
  linkId: string
  /** VLAN the frame is in on this switch (null on non-switches). */
  vlan: number | null
}

export interface L2Hit {
  device: Device
  iface: Iface
  path: L2Step[]
}

/**
 * Floods a frame from `from`'s `egress` interface and calls `visit` for every L3
 * interface it reaches (and every SVI in the right VLAN). `visit` returns true to stop.
 * Returns why the frame couldn't leave at all, or null.
 */
export function walkL2(topo: Topology, from: Device, egress: Iface, visit: (hit: L2Hit) => boolean): string | null {
  type Node = { linkId: string; dev: string; iface: string; tag: number | null; path: L2Step[] }
  const queue: Node[] = []
  const seen = new Set<string>()

  const floodSwitch = (sw: Device, vlan: number, skipLink: string | null, path: L2Step[]) => {
    for (const l of linksOn(topo, sw.id)) {
      if (l.id === skipLink || !linkActive(topo, l)) continue
      const here = l.a.device === sw.id ? l.a : l.b
      const port = sw.ifaces.find((i) => i.name === here.iface)
      if (port?.shutdown) continue
      const tag = egressTag(switchport(sw, here.iface), vlan)
      if (tag === undefined) continue
      const peer = peerOf(l, sw.id, here.iface)
      queue.push({ linkId: l.id, dev: peer.device, iface: peer.iface, tag, path })
    }
  }

  if (isSvi(egress.name)) {
    // The switch's own address: the frame starts inside the switch, in that VLAN.
    const vlan = egress.vlan ?? Number(egress.name.slice(4))
    if (!vlanExists(from, vlan)) return `VLAN ${vlan} does not exist on ${from.name}`
    seen.add(`${from.id}:${vlan}`)
    floodSwitch(from, vlan, null, [])
  } else {
    const port = physPort(egress.name)
    const first = linkOn(topo, from.id, port)
    if (!first) return `${port} on ${from.name} is not cabled`
    if (!linkActive(topo, first)) {
      const why = cableProblem(topo, first)
      return why ? `Link on ${from.name} ${port} is down: ${why}` : `Link on ${from.name} ${port} is down`
    }
    const startPeer = peerOf(first, from.id, port)
    queue.push({ linkId: first.id, dev: startPeer.device, iface: startPeer.iface, tag: ifaceTag(egress), path: [] })
    // A phone sending its own traffic can also reach the PC on its pc port.
    if (from.type === 'phone') {
      const pc = linkOn(topo, from.id, 'pc')
      if (pc && linkActive(topo, pc)) {
        const peer = peerOf(pc, from.id, 'pc')
        queue.push({ linkId: pc.id, dev: peer.device, iface: peer.iface, tag: null, path: [] })
      }
    }
  }

  while (queue.length) {
    const node = queue.shift()!
    const dev = getDevice(topo, node.dev)
    if (!dev) continue

    if (dev.type === 'patch') {
      // Passive: the frame comes out of the same port number on the other side.
      const path = [...node.path, { deviceId: dev.id, linkId: node.linkId, vlan: null }]
      const out = linkOn(topo, dev.id, patchPartner(node.iface))
      if (out && linkActive(topo, out)) {
        const peer = peerOf(out, dev.id, patchPartner(node.iface))
        queue.push({ linkId: out.id, dev: peer.device, iface: peer.iface, tag: node.tag, path })
      }
      continue
    }

    if (dev.type === 'switch') {
      const port = dev.ifaces.find((i) => i.name === node.iface)
      if (port?.shutdown) continue
      const vlan = ingressVlan(switchport(dev, node.iface), node.tag)
      if (vlan === null || !vlanExists(dev, vlan)) continue
      const key = `${dev.id}:${vlan}`
      if (seen.has(key)) continue
      seen.add(key)
      const path = [...node.path, { deviceId: dev.id, linkId: node.linkId, vlan }]
      const svi = dev.ifaces.find((i) => i.name === `vlan${vlan}` && i.ip && !i.shutdown)
      if (svi && visit({ device: dev, iface: svi, path })) return null
      floodSwitch(dev, vlan, node.linkId, path)
      continue
    }

    const path = [...node.path, { deviceId: dev.id, linkId: node.linkId, vlan: null }]

    // IP phone: answers for its own IP, and switches everything else between its two ports.
    if (dev.type === 'phone') {
      const eth0 = dev.ifaces.find((i) => i.name === 'eth0')!
      if (node.tag === null && eth0.ip && visit({ device: dev, iface: eth0, path })) return null
      if (seen.has(dev.id)) continue
      seen.add(dev.id)
      const other = node.iface === 'pc' ? 'eth0' : 'pc'
      const out = linkOn(topo, dev.id, other)
      if (out && linkActive(topo, out)) {
        const peer = peerOf(out, dev.id, other)
        queue.push({ linkId: out.id, dev: peer.device, iface: peer.iface, tag: node.tag, path })
      }
      continue
    }

    if (isBridge(dev)) {
      // APs and modems: not VLAN-aware, they pass every frame on as it is. An AP
      // radio carries several links, so two Wi-Fi clients on the same AP reach each other.
      if (seen.has(dev.id)) continue
      seen.add(dev.id)
      for (const l of linksOn(topo, dev.id)) {
        if (l.id === node.linkId || !linkActive(topo, l)) continue
        const here = l.a.device === dev.id ? l.a : l.b
        if (dev.ifaces.find((i) => i.name === here.iface)?.shutdown) continue
        const peer = peerOf(l, dev.id, here.iface)
        queue.push({ linkId: l.id, dev: peer.device, iface: peer.iface, tag: node.tag, path })
      }
      continue
    }

    for (const i of receiver(dev, node.iface, node.tag)) if (up(dev, i) && visit({ device: dev, iface: i, path })) return null
  }
  return null
}

/** Finds which interface owns `targetIp` in the broadcast domain behind `egress` (ARP), learning MACs on the way. */
export function resolveL2(topo: Topology, state: SimState, from: Device, egress: Iface, targetIp: string): L2Hit | string {
  let found: L2Hit | null = null
  const owns = (h: L2Hit) =>
    h.iface.ip === targetIp ||
    // Static NAT: the router answers ARP for its global addresses on the outside interface.
    (h.iface.nat === 'outside' && !!h.device.ios?.nat?.statics.some((s) => s.global === targetIp))
  const err = walkL2(topo, from, egress, (h) => {
    if (!owns(h)) return false
    found = h
    return true
  })
  if (err) return err
  if (!found) return `ARP: no reply for ${targetIp} — no device with that IP is reachable from ${from.name} ${egress.name}${egress.vlan ? ` (VLAN ${egress.vlan})` : ''}`
  const hit: L2Hit = found
  ;(state.arp[from.id] ??= {})[targetIp] = hit.iface.mac
  // Switches on the way learn both MACs: the sender behind the port the frame came in on,
  // the target behind the port it went out of.
  const path = hit.path
  for (let k = 0; k < path.length - 1; k++) {
    const sw = path[k].deviceId
    const inLink = topo.links.find((x) => x.id === path[k].linkId)!
    const outLink = topo.links.find((x) => x.id === path[k + 1].linkId)!
    const inPort = inLink.a.device === sw ? inLink.a.iface : inLink.b.iface
    const outPort = outLink.a.device === sw ? outLink.a.iface : outLink.b.iface
    ;(state.mac[sw] ??= {})[egress.mac] = inPort
    state.mac[sw][hit.iface.mac] = outPort
    if (path[k].vlan !== null) {
      const vl = ((state.macVlan ??= {})[sw] ??= {})
      vl[egress.mac] = path[k].vlan!
      vl[hit.iface.mac] = path[k].vlan!
    }
  }
  return hit
}

/** Every L3 interface reachable by a broadcast from `egress` (for DHCP and neighbor discovery). */
export function broadcastDomain(topo: Topology, from: Device, egress: Iface): L2Hit[] {
  const hits: L2Hit[] = []
  walkL2(topo, from, egress, (h) => {
    if (h.device.id !== from.id) hits.push(h)
    return false
  })
  return hits
}
