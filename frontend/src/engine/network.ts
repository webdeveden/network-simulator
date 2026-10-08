import { parseCidr } from './ip'
import type { CableChoice, CableType, Device, DeviceType, Iface, Link, Topology } from './types'

export interface DeviceInfo {
  label: string
  prefix: string
  cost: number
  ifaces: string[]
  /** Ports that take fiber (SFP) instead of copper RJ45. */
  fiber?: string[]
  layer: 2 | 3
  description: string
}

export interface CableInfo {
  label: string
  cost: number
  /** 2D/3D colour. */
  color: string
  description: string
}

export const CABLES: Record<CableType, CableInfo> = {
  straight: {
    label: 'Straight-through',
    cost: 10,
    color: '#22d3ee',
    description: 'Cat6 copper. Joins different kinds of ports: PC, router, AP or firewall to a switch.',
  },
  crossover: {
    label: 'Crossover',
    cost: 10,
    color: '#ff6bd6',
    description: 'Cat6 copper with the send and receive pairs swapped. Joins like devices: switch↔switch, router↔router, PC↔PC, PC↔router.',
  },
  fiber: {
    label: 'Fiber',
    cost: 40,
    color: '#ffb020',
    description: 'Light instead of electricity: long distances, no interference. Only fits fiber (SFP) ports.',
  },
  console: {
    label: 'Console',
    cost: 15,
    color: '#a5b4fc',
    description: "Rollover cable from a PC's COM1 to a device's console port. No network traffic: type `console` on the PC to manage the device without an IP.",
  },
}

/** Cost of the default copper cable. */
export const CABLE_COST = CABLES.straight.cost

/** Patch panel ports: front p1..p48 and the rear (punch-down) side p1r..p48r. */
const PATCH_PORTS = Array.from({ length: 48 }, (_, k) => `p${k + 1}`)

export const DEVICE_CATALOG: Record<DeviceType, DeviceInfo> = {
  pc: {
    label: 'PC',
    prefix: 'PC',
    cost: 100,
    ifaces: ['eth0', 'com1'],
    layer: 3,
    description: 'End host. One NIC, needs an IP and a default gateway. COM1 takes a console cable.',
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
    ifaces: ['fa0/1', 'fa0/2', 'fa0/3', 'fa0/4', 'fa0/5', 'fa0/6', 'fa0/7', 'fa0/8', 'g0/1', 'g0/2', 'con0'],
    fiber: ['g0/1', 'g0/2'],
    layer: 2,
    description: 'Layer 2. Forwards frames inside one LAN by MAC address.',
  },
  ap: {
    label: 'Access point',
    prefix: 'AP',
    cost: 250,
    ifaces: ['g0/0', 'd0', 'con0'],
    layer: 2,
    description: 'Layer 2. Bridges Wi-Fi clients on its radio (Dot11Radio0) to the wired LAN on g0/0.',
  },
  router: {
    label: 'Router',
    prefix: 'R',
    cost: 500,
    ifaces: ['g0/0', 'g0/1', 'g0/2', 'g0/3', 'g0/4', 'con0'],
    fiber: ['g0/4'],
    layer: 3,
    description: 'Layer 3. Connects subnets and forwards packets using its routing table.',
  },
  patch: {
    label: 'Patch panel',
    prefix: 'PP',
    cost: 60,
    ifaces: [...PATCH_PORTS, ...PATCH_PORTS.map((p) => `${p}r`)],
    layer: 2,
    description: '48 ports, passive. Front port N is wired straight through to rear port N: office cable runs land on the rear, patch cords go from the front to a switch.',
  },
  modem: {
    label: 'ONT / modem',
    prefix: 'ONT',
    cost: 80,
    ifaces: ['pon', 'lan1', 'lan2', 'lan3', 'lan4'],
    fiber: ['pon'],
    layer: 2,
    description: "Where the ISP's line enters the building: the fiber PON port faces the ISP, the LAN ports go to your edge router. A layer 2 bridge.",
  },
  printer: {
    label: 'Printer',
    prefix: 'PRN',
    cost: 300,
    ifaces: ['eth0'],
    layer: 3,
    description: 'Network printer in an office. A host: needs an IP and a gateway; print jobs arrive on TCP 9100.',
  },
  phone: {
    label: 'IP phone',
    prefix: 'TEL',
    cost: 90,
    ifaces: ['eth0', 'pc'],
    layer: 3,
    description: 'Desk phone that talks over the network (VoIP). Two ports with a built-in switch: eth0 goes to the network, the PC on the desk plugs into the pc port. Needs an IP and a gateway.',
  },
  isp: {
    label: 'ISP / Internet',
    prefix: 'ISP',
    cost: 0,
    ifaces: ['pon0', 'g0/0', 'g0/1', 'g0/2', 'g0/3', 'lo0'],
    fiber: ['pon0'],
    layer: 3,
    description: "Your Internet provider, outside the building (2D map only). Routes like a router; 8.8.8.8 on lo0 stands for 'the Internet'.",
  },
  firewall: {
    label: 'Firewall',
    prefix: 'FW',
    cost: 800,
    ifaces: ['g0/0', 'g0/1', 'g0/2', 'g0/3', 'con0'],
    fiber: ['g0/3'],
    layer: 3,
    description: 'A router that filters traffic with ordered allow/deny rules.',
  },
}

export const isHost = (d: Device) => ['pc', 'laptop', 'server', 'printer', 'phone'].includes(d.type)
/** Layer 2 devices that forward frames between all their links. */
export const isBridge = (d: Device) => d.type === 'switch' || d.type === 'ap' || d.type === 'modem'
/** Routes packets: routers, firewalls and the ISP. */
export const isRouterLike = (d: Device) => d.type === 'router' || d.type === 'firewall' || d.type === 'isp'
/** Outside the building: drawn on the 2D map only. */
export const isOutside = (d: Device) => d.type === 'isp'
/** A patch panel port's other side: p5 <-> p5r. */
export const patchPartner = (iface: string) => (iface.endsWith('r') ? iface.slice(0, -1) : `${iface}r`)
/** Radio interfaces take Wi-Fi associations, never cables. */
export const isRadio = (iface: string) => iface === 'd0' || iface === 'wlan0'
/** Serial management ports: con0 on network gear, com1 on PCs. They never carry network traffic. */
export const isConsolePort = (iface: string) => iface === 'con0' || iface === 'com1'
/** Ports that carry network traffic (everything but console ports). */
export const netIfaces = (d: Device) => d.ifaces.filter((i) => !isConsolePort(i.name))

export type PortKind = 'copper' | 'fiber' | 'console' | 'radio' | 'virtual'

export function portKind(d: Device, iface: string): PortKind {
  if (isRadio(iface)) return 'radio'
  if (iface === 'lo0') return 'virtual'
  if (isConsolePort(iface)) return 'console'
  return DEVICE_CATALOG[d.type].fiber?.includes(iface) ? 'fiber' : 'copper'
}

/**
 * Switch ports cross over internally (MDI-X); everything else transmits on the "PC"
 * pins (MDI). An IP phone's pc port is a switch port; its eth0 uplink is not.
 */
const crossesInternally = (d: Device, iface?: string) => d.type === 'switch' || d.type === 'modem' || (d.type === 'phone' && iface === 'pc')

/** The copper cable two ports need: crossover between like ports, straight between unlike. */
export function copperFor(a: Device, b: Device, aIface?: string, bIface?: string): 'straight' | 'crossover' {
  return crossesInternally(a, aIface) === crossesInternally(b, bIface) ? 'crossover' : 'straight'
}

/** A phone's pc port is part of its built-in switch: it has no IP of its own. */
export const isPhonePcPort = (d: Device, iface: string) => d.type === 'phone' && iface === 'pc'

/**
 * The cable to lay between two ports for the player's choice, or why it can't go there.
 * Physical mismatches (copper into fiber, network cable into a console port) are refused;
 * a wrong straight/crossover plugs in fine but the link stays down (see cableProblem).
 */
export function cableFor(choice: CableChoice, a: Device, aIface: string, b: Device, bIface: string): CableType | string {
  const ka = portKind(a, aIface)
  const kb = portKind(b, bIface)
  const port = (d: Device, i: string, k: PortKind) => `${d.name} ${i} is a ${k === 'console' ? 'console' : k === 'fiber' ? 'fiber (SFP)' : 'copper RJ45'} port`
  if (ka === 'radio' || kb === 'radio') return 'Radios connect over Wi-Fi, not by cable'
  if (ka === 'virtual' || kb === 'virtual') return 'lo0 is a virtual (loopback) interface: no cable fits'
  const want = choice === 'auto' ? (ka === kb ? (ka === 'copper' ? copperFor(a, b, aIface, bIface) : ka) : null) : choice
  if (!want) return `${port(a, aIface, ka)} but ${port(b, bIface, kb)}: they can't be cabled together`
  const need: PortKind = want === 'fiber' ? 'fiber' : want === 'console' ? 'console' : 'copper'
  for (const [d, i, k] of [[a, aIface, ka], [b, bIface, kb]] as const)
    if (k !== need) return `${port(d, i, k)}: a ${CABLES[want].label.toLowerCase()} cable doesn't fit`
  if (want === 'console' && !((aIface === 'com1') !== (bIface === 'com1')))
    return "A console cable goes from a PC's COM1 to a device's console port (con0)"
  return want
}

/** Why a plugged-in cable can't carry traffic, or null if it's fine. */
export function cableProblem(topo: Topology, link: Link): string | null {
  if (link.cable !== 'straight' && link.cable !== 'crossover') return null
  const a = getDevice(topo, link.a.device)
  const b = getDevice(topo, link.b.device)
  // A patch panel is just wire: what matters is the gear at the far ends, so NetSim doesn't judge these.
  if (!a || !b || a.type === 'patch' || b.type === 'patch') return null
  const need = copperFor(a, b, link.a.device === a.id ? link.a.iface : link.b.iface, link.b.device === b.id ? link.b.iface : link.a.iface)
  if (link.cable === need) return null
  return need === 'crossover'
    ? `${a.name}↔${b.name} needs a crossover cable: both ends transmit on the same pins (${a.type}↔${b.type})`
    : `${a.name}↔${b.name} needs a straight-through cable: a switch port (or a phone's pc port) already crosses the pairs internally`
}

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
  const d: Device = {
    id: randomId(),
    name,
    type,
    ifaces: DEVICE_CATALOG[type].ifaces.map((n): Iface => ({ name: n, mac: randomMac() })),
    routes: [],
    fwRules: [],
    fwDefault: 'allow',
    x,
    y,
    // The ISP comes with "the Internet" on a loopback, so there is always something to reach.
    ...(type === 'isp' ? { w: 170, h: 110 } : {}),
  }
  if (type === 'isp') setIfaceIp(d, 'lo0', '8.8.8.8/32')
  return d
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
  if (!link.up || link.cable === 'console' || cableProblem(topo, link)) return false
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

export function freeIface(topo: Topology, device: Device, kind: PortKind = 'copper'): Iface | undefined {
  return device.ifaces.find((i) => portKind(device, i.name) === kind && !linkOn(topo, device.id, i.name))
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

/**
 * Which patch panel port a new cable from `other` should use: rack gear patches into
 * the front, everything else (office runs) lands on the rear. Prefer a port whose
 * other side is already cabled, so the cable completes a circuit.
 */
function patchPort(topo: Topology, panel: Device, other: Device): Iface | undefined {
  const office = other.type === 'pc' || other.type === 'laptop' || other.type === 'ap'
  const front = !office
  const side = (i: Iface) => (front ? !i.name.endsWith('r') : i.name.endsWith('r'))
  const free = panel.ifaces.filter((i) => side(i) && !linkOn(topo, panel.id, i.name))
  return free.find((i) => linkOn(topo, panel.id, patchPartner(i.name))) ?? free[0]
}

/** A phone takes its desk PC on the pc port and everything else on the eth0 uplink. */
function phonePort(topo: Topology, phone: Device, other: Device): Iface | undefined {
  if (phone.type !== 'phone') return undefined
  const name = other.type === 'pc' || other.type === 'laptop' ? 'pc' : 'eth0'
  return linkOn(topo, phone.id, name) ? undefined : phone.ifaces.find((i) => i.name === name)
}

/** Cables two devices together on their first free ports that fit the cable. */
export function connect(topo: Topology, aId: string, bId: string, choice: CableChoice = 'auto'): Link | string {
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
  for (const d of [a, b])
    if (d.type === 'laptop' && choice !== 'console') return `${d.name} is a laptop: it joins over Wi-Fi (wifi connect <ssid> <password>), not by cable`
  if (choice === 'console') {
    const pc = [a, b].find((d) => d.ifaces.some((i) => i.name === 'com1'))
    const gear = [a, b].find((d) => d.ifaces.some((i) => i.name === 'con0'))
    if (!pc || !gear || pc === gear) return "A console cable goes from a PC's COM1 to a router, switch, firewall or AP's console port"
    if (linkOn(topo, pc.id, 'com1')) return `${pc.name}'s COM1 already has a console cable`
    if (linkOn(topo, gear.id, 'con0')) return `${gear.name}'s console port is already in use`
    return connectPorts(topo, pc.id, 'com1', gear.id, 'con0', 'console')
  }
  // Auto prefers copper, and uses fiber when both ends only have fiber ports left.
  // The ISP's line into an ONT is always the fiber PON port.
  const ispToOnt = (a.type === 'isp' && b.type === 'modem') || (a.type === 'modem' && b.type === 'isp')
  const kind: PortKind = choice === 'fiber' || (choice === 'auto' && ispToOnt) ? 'fiber' : 'copper'
  let ia = a.type === 'patch' ? patchPort(topo, a, b) : phonePort(topo, a, b) ?? freeIface(topo, a, kind)
  let ib = b.type === 'patch' ? patchPort(topo, b, a) : phonePort(topo, b, a) ?? freeIface(topo, b, kind)
  if (choice === 'auto' && (!ia || !ib)) {
    const fa = freeIface(topo, a, 'fiber')
    const fb = freeIface(topo, b, 'fiber')
    if (fa && fb) [ia, ib] = [fa, fb]
  }
  const what = kind === 'fiber' ? 'fiber' : 'copper'
  if (!ia) return `${a.name} has no free ${what} ports`
  if (!ib) return `${b.name} has no free ${what} ports`
  return connectPorts(topo, a.id, ia.name, b.id, ib.name, choice)
}

/** Cables two specific ports together (used when plugging cables by hand in the 3D room). */
export function connectPorts(topo: Topology, aId: string, aIface: string, bId: string, bIface: string, choice: CableChoice = 'auto'): Link | string {
  const a = getDevice(topo, aId)
  const b = getDevice(topo, bId)
  if (!a || !b) return 'Unknown device'
  if (a.id === b.id) return 'Cannot connect a device to itself'
  if (!a.ifaces.some((i) => i.name === aIface) || !b.ifaces.some((i) => i.name === bIface)) return 'Unknown port'
  if (linkOn(topo, a.id, aIface)) return `${a.name} ${aIface} already has a cable`
  if (linkOn(topo, b.id, bIface)) return `${b.name} ${bIface} already has a cable`
  const cable = cableFor(choice, a, aIface, b, bIface)
  if (!(cable in CABLES)) return cable
  const link: Link = { id: randomId(), a: { device: a.id, iface: aIface }, b: { device: b.id, iface: bIface }, up: true, cable: cable as CableType }
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
  if (isConsolePort(ifaceName)) return `${ifaceName} is a console port: it has no IP address`
  if (isPhonePcPort(device, ifaceName)) return `${ifaceName} is the phone's PC pass-through port: the phone's IP goes on eth0`
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
    topo.links.filter((l) => !l.wifi).reduce((sum, l) => sum + CABLES[l.cable ?? 'straight'].cost, 0)
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
  /** Office in the 3D building, for desk devices. */
  room?: string
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
    if (s.room) d.room = s.room
    topo.devices.push(d)
  }
  for (const [a, b] of spec.links ?? []) {
    const da = getDevice(topo, a)
    const db = getDevice(topo, b)
    if (da && db) connect(topo, da.id, db.id)
  }
  return topo
}
