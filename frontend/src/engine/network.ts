import { parseCidr } from './ip'
import type { Device, DeviceType, Iface, Link, Topology } from './types'

export interface DeviceInfo {
  label: string
  prefix: string
  cost: number
  ifaces: string[]
  layer: 2 | 3
  description: string
}

export const CABLE_COST = 10

export const DEVICE_CATALOG: Record<DeviceType, DeviceInfo> = {
  pc: {
    label: 'PC',
    prefix: 'PC',
    cost: 100,
    ifaces: ['eth0'],
    layer: 3,
    description: 'End host. One NIC, needs an IP and a default gateway.',
  },
  laptop: {
    label: 'Laptop',
    prefix: 'LT',
    cost: 120,
    ifaces: ['wlan0'],
    layer: 3,
    description: 'Wireless host. Joins Wi-Fi with: wifi connect <ssid> <password>',
  },
  server: {
    label: 'Server',
    prefix: 'SRV',
    cost: 400,
    ifaces: ['eth0'],
    layer: 3,
    description: 'Hosts services. Same networking as a PC.',
  },
  switch: {
    label: 'Switch',
    prefix: 'SW',
    cost: 150,
    ifaces: ['fa0/1', 'fa0/2', 'fa0/3', 'fa0/4', 'fa0/5', 'fa0/6', 'fa0/7', 'fa0/8'],
    layer: 2,
    description: 'Layer 2. Forwards frames inside one LAN by MAC address.',
  },
  ap: {
    label: 'Access point',
    prefix: 'AP',
    cost: 250,
    ifaces: ['g0/0', 'd0'],
    layer: 2,
    description: 'Layer 2. Bridges Wi-Fi clients on its radio (Dot11Radio0) to the wired LAN on g0/0.',
  },
  router: {
    label: 'Router',
    prefix: 'R',
    cost: 500,
    ifaces: ['g0/0', 'g0/1', 'g0/2', 'g0/3'],
    layer: 3,
    description: 'Layer 3. Connects subnets and forwards packets using its routing table.',
  },
  firewall: {
    label: 'Firewall',
    prefix: 'FW',
    cost: 800,
    ifaces: ['g0/0', 'g0/1', 'g0/2'],
    layer: 3,
    description: 'A router that filters traffic with ordered allow/deny rules.',
  },
}

export const isHost = (d: Device) => d.type === 'pc' || d.type === 'laptop' || d.type === 'server'
/** Layer 2 devices that forward frames between all their links. */
export const isBridge = (d: Device) => d.type === 'switch' || d.type === 'ap'
/** Radio interfaces take Wi-Fi associations, never cables. */
export const isRadio = (iface: string) => iface === 'd0' || iface === 'wlan0'

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function randomMac(): string {
  const bytes = [0x02, ...Array.from({ length: 5 }, () => Math.floor(Math.random() * 256))]
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':')
}

export function emptyTopology(): Topology {
  return { devices: [], links: [] }
}

export function nextName(topo: Topology, type: DeviceType): string {
  const prefix = DEVICE_CATALOG[type].prefix
  let n = 1
  const names = new Set(topo.devices.map((d) => d.name))
  while (names.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export function createDevice(type: DeviceType, name: string, x = 0, y = 0): Device {
  return {
    id: randomId(),
    name,
    type,
    ifaces: DEVICE_CATALOG[type].ifaces.map((n): Iface => ({ name: n, mac: randomMac() })),
    routes: [],
    fwRules: [],
    fwDefault: 'allow',
    x,
    y,
  }
}

export function addDevice(topo: Topology, type: DeviceType, x = 0, y = 0): Device {
  const d = createDevice(type, nextName(topo, type), x, y)
  topo.devices.push(d)
  return d
}

export function removeDevice(topo: Topology, id: string): void {
  topo.devices = topo.devices.filter((d) => d.id !== id)
  topo.links = topo.links.filter((l) => l.a.device !== id && l.b.device !== id)
}

export function getDevice(topo: Topology, idOrName: string): Device | undefined {
  return (
    topo.devices.find((d) => d.id === idOrName) ??
    topo.devices.find((d) => d.name.toLowerCase() === idOrName.toLowerCase())
  )
}

export function linkOn(topo: Topology, deviceId: string, iface: string): Link | undefined {
  return topo.links.find(
    (l) =>
      (l.a.device === deviceId && l.a.iface === iface) ||
      (l.b.device === deviceId && l.b.iface === iface),
  )
}

export function peerOf(link: Link, deviceId: string, iface: string) {
  return link.a.device === deviceId && link.a.iface === iface ? link.b : link.a
}

/** A cable carries traffic only if it is up and neither end is shut down. */
export function linkActive(topo: Topology, link: Link): boolean {
  if (!link.up) return false
  if (link.wifi) {
    const ap = getDevice(topo, link.a.device)
    if (!ap || wifiProblem(ap, link.wifi.ssid, link.wifi.key) !== null) return false
  }
  return [link.a, link.b].every((end) => {
    const d = getDevice(topo, end.device)
    return !d?.ifaces.find((i) => i.name === end.iface)?.shutdown
  })
}

/** All links on a device, or on one of its interfaces (an AP radio can have many). */
export function linksOn(topo: Topology, deviceId: string, iface?: string): Link[] {
  return topo.links.filter(
    (l) =>
      (l.a.device === deviceId && (iface === undefined || l.a.iface === iface)) ||
      (l.b.device === deviceId && (iface === undefined || l.b.iface === iface)),
  )
}

export function freeIface(topo: Topology, device: Device): Iface | undefined {
  return device.ifaces.find((i) => !isRadio(i.name) && !linkOn(topo, device.id, i.name))
}

/** Why `ap` would refuse a client joining `ssid` with `key`, or null if it accepts. */
export function wifiProblem(ap: Device, ssid: string, key: string | undefined): string | null {
  const w = ap.ios?.wlan
  const radio = ap.ifaces.find((i) => i.name === 'd0')
  if (!w || !radio || radio.shutdown || w.radioSsid !== ssid) return `${ap.name} is not serving "${ssid}"`
  const s = w.ssids[ssid]
  if (!s) return `${ap.name} is not serving "${ssid}"`
  if (!s.open) return `${ap.name} rejects the association: SSID ${ssid} has no "authentication open"`
  if (!s.wpa2) return null
  if (!s.psk) return `${ap.name} has WPA2 on ${ssid} but no "wpa-psk ascii <key>"`
  if (!w.aes) return `${ap.name} has WPA2 on ${ssid} but Dot11Radio0 has no "encryption mode ciphers aes-ccm"`
  if (key !== s.psk) return 'wrong password'
  return null
}

/** Cables two devices together on their first free interfaces. */
export function connect(topo: Topology, aId: string, bId: string): Link | string {
  if (aId === bId) return 'Cannot connect a device to itself'
  const a = getDevice(topo, aId)
  const b = getDevice(topo, bId)
  if (!a || !b) return 'Unknown device'
  const already = topo.links.some(
    (l) =>
      (l.a.device === a.id && l.b.device === b.id) ||
      (l.a.device === b.id && l.b.device === a.id),
  )
  if (already) return `${a.name} and ${b.name} are already connected`
  const ia = freeIface(topo, a)
  const ib = freeIface(topo, b)
  for (const d of [a, b]) if (d.type === 'laptop') return `${d.name} is a laptop: it joins over Wi-Fi (wifi connect <ssid> <password>), not by cable`
  if (!ia) return `${a.name} has no free ports`
  if (!ib) return `${b.name} has no free ports`
  const link: Link = {
    id: randomId(),
    a: { device: a.id, iface: ia.name },
    b: { device: b.id, iface: ib.name },
    up: true,
  }
  topo.links.push(link)
  return link
}

/** Cables two specific ports together (used when plugging cables by hand in the 3D room). */
export function connectPorts(topo: Topology, aId: string, aIface: string, bId: string, bIface: string): Link | string {
  const a = getDevice(topo, aId)
  const b = getDevice(topo, bId)
  if (!a || !b) return 'Unknown device'
  if (a.id === b.id) return 'Cannot connect a device to itself'
  if (!a.ifaces.some((i) => i.name === aIface) || !b.ifaces.some((i) => i.name === bIface)) return 'Unknown port'
  if (isRadio(aIface) || isRadio(bIface)) return 'Radios connect over Wi-Fi, not by cable'
  if (linkOn(topo, a.id, aIface)) return `${a.name} ${aIface} already has a cable`
  if (linkOn(topo, b.id, bIface)) return `${b.name} ${bIface} already has a cable`
  const link: Link = { id: randomId(), a: { device: a.id, iface: aIface }, b: { device: b.id, iface: bIface }, up: true }
  topo.links.push(link)
  return link
}

export function disconnect(topo: Topology, linkId: string): void {
  topo.links = topo.links.filter((l) => l.id !== linkId)
}

export function setIfaceIp(device: Device, ifaceName: string, cidr: string): string | null {
  const iface = device.ifaces.find((i) => i.name === ifaceName)
  if (!iface) return `No interface ${ifaceName} on ${device.name}`
  if (DEVICE_CATALOG[device.type].layer === 2) return `${device.name} is a layer 2 switch: its ports have no IP`
  if (cidr === '' || cidr === 'none') {
    delete iface.ip
    delete iface.prefix
    return null
  }
  const c = parseCidr(cidr, -1)
  if (!c || c.prefix < 0) return `Invalid address "${cidr}": use CIDR notation like 192.168.1.10/24`
  iface.ip = c.ip
  iface.prefix = c.prefix
  return null
}

export function topologyCost(topo: Topology): number {
  return (
    topo.devices
      .filter((d) => !d.locked)
      .reduce((sum, d) => sum + DEVICE_CATALOG[d.type].cost, 0) +
    topo.links.filter((l) => !l.wifi).length * CABLE_COST
  )
}

/** Compact description used by missions to define a starting topology. */
export interface DeviceSpec {
  type: DeviceType
  name: string
  x: number
  y: number
  /** iface name -> CIDR */
  ifaces?: Record<string, string>
  gateway?: string
}

export interface TopologySpec {
  devices: DeviceSpec[]
  links?: [string, string][]
}

export function buildTopology(spec: TopologySpec, locked = true): Topology {
  const topo = emptyTopology()
  for (const s of spec.devices) {
    const d = createDevice(s.type, s.name, s.x, s.y)
    d.locked = locked
    for (const [name, cidr] of Object.entries(s.ifaces ?? {})) setIfaceIp(d, name, cidr)
    if (s.gateway) d.gateway = s.gateway
    topo.devices.push(d)
  }
  for (const [a, b] of spec.links ?? []) {
    const da = getDevice(topo, a)
    const db = getDevice(topo, b)
    if (da && db) connect(topo, da.id, db.id)
  }
  return topo
}
