/**
 * Where everything sits in the 3D server room. Pure data, no Three.js, so it
 * can be unit tested. Units are metres; every device faces +z, towards the
 * player's spawn point.
 */
import { isOutside, portKind, type PortKind } from '../engine/network'
import type { Device, DeviceType, Topology } from '../engine/types'

/**
 * rack: in a rack · desk: in a cubicle · printer: printer stand · phone: on a PC's desk ·
 * lounge: balcony table · ceiling: AP on an office ceiling · wall: AP on the outside wall by a balcony ·
 * held: a laptop or smartphone used by a person on a balcony.
 */
export type Station = 'rack' | 'desk' | 'printer' | 'phone' | 'lounge' | 'ceiling' | 'wall' | 'held'

export interface PortSpot {
  iface: string
  /** Offset from the panel centre. */
  x: number
  y: number
}

export interface Placement {
  deviceId: string
  station: Station
  /** Rack index for rack-mounted devices. */
  rack?: number
  /** Centre of the rack or desk footprint along x; z is its front edge. */
  x: number
  z: number
  /** Front panel centre, world coordinates. */
  panel: { x: number; y: number; z: number; w: number; h: number }
  ports: PortSpot[]
  /** Desk top height, for desks that aren't the standard office height (the server room's standing desk). */
  deskH?: number
}

/** Axis-aligned footprint on the floor, for collisions. */
export interface Box2 {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface RackSpot {
  index: number
  /** Floor rack (MDF, server room) or wall-mounted mini rack (IDF, offices). */
  kind: 'floor' | 'wall'
  room: RoomId
  name: string
  /** Centre along x; z is the front edge. */
  x: number
  z: number
  deviceIds: string[]
}

/** A cubicle around one desk: back wall at `back`, open towards +z. */
export interface Cubicle {
  deviceId: string
  x: number
  back: number
  /** Draw the right-hand wall too (the left one is shared with the neighbour). */
  rightWall: boolean
}

export type RoomKind = 'racks' | 'office' | 'balcony'
export type RoomId = string

export interface RoomDef {
  id: RoomId
  label: string
  kind: RoomKind
}

/**
 * The building: a corridor along the front (+z), rooms side by side behind it, and
 * balconies off the corridor's outer wall. These are the rooms every network starts
 * with; players can add more offices and balconies (topo.customRooms).
 */
export const BASE_ROOMS: RoomDef[] = [
  { id: 'server', label: 'Server room', kind: 'racks' },
  { id: 'it', label: 'IT office', kind: 'office' },
  { id: 'accounting', label: 'Accounting', kind: 'office' },
  { id: 'sales', label: 'Sales', kind: 'office' },
]
export const DEFAULT_OFFICE: RoomId = 'it'

export function roomsOf(topo: Topology): RoomDef[] {
  const gone = new Set(topo.removedRooms ?? [])
  return [...BASE_ROOMS, ...(topo.customRooms ?? [])].filter((r) => !gone.has(r.id))
}

/** The office devices go to when theirs is gone: IT, or the first office left. */
export function defaultOffice(topo: Topology): RoomId {
  const offices = officesOf(topo)
  return offices.some((o) => o.id === DEFAULT_OFFICE) ? DEFAULT_OFFICE : (offices[0]?.id ?? 'server')
}
export const officesOf = (topo: Topology) => roomsOf(topo).filter((r) => r.kind === 'office')

/** Device types that can go out on a balcony: wireless gear. */
const BALCONY_TYPES: DeviceType[] = ['ap', 'laptop', 'mobile']

/** Rooms a desk device may go in: offices, plus balconies for wireless gear. */
/** Device types that can sit at the admin desks in the server room. */
const ADMIN_DESK_TYPES: DeviceType[] = ['pc', 'laptop']

export function deskRoomsFor(topo: Topology, type: DeviceType): RoomDef[] {
  return roomsOf(topo).filter(
    (r) =>
      r.kind === 'office' ||
      (r.kind === 'balcony' && BALCONY_TYPES.includes(type)) ||
      (r.kind === 'racks' && ADMIN_DESK_TYPES.includes(type)),
  )
}

export interface Room {
  id: RoomId
  label: string
  kind: RoomKind
  x0: number
  x1: number
  /** Offices: north wall (z0) to the corridor wall (z1 = 0). Balconies: corridor's outer wall (z0) to the railing (z1). */
  z0: number
  z1: number
  doorX: number
}

/** A straight wall segment along x or z, `glass` for see-through walls. */
export interface Wall {
  x0: number
  z0: number
  x1: number
  z1: number
  glass?: boolean
}

export interface RoomLayout {
  placements: Placement[]
  racks: RackSpot[]
  cubicles: Cubicle[]
  rooms: Room[]
  walls: Wall[]
  /** The corridor in front of the rooms. */
  corridor: Box2
  obstacles: Box2[]
  bounds: Box2
  spawn: { x: number; z: number }
  /**
   * Balcony spots, facing the view: lounge chairs and places at the railing. A spot
   * with a device has a person using it (a laptop on their lap, a smartphone in hand).
   */
  seats: { x: number; z: number; pose: 'sit' | 'stand'; deviceId?: string }[]
  /** Starting view: close up in front of rack 1 (or the first cubicle). */
  home: { x: number; z: number; look: [number, number, number]; rack?: number }
}

export const RACK = { w: 0.6, h: 2.0, d: 0.9, gap: 0.12, perRow: 7, rowPitch: 2.8 }
export const DESK = { w: 1.2, h: 0.75, d: 0.7, gap: 0.3 }
/** The admin desk in the server room is a standing desk: no chair, worked at standing up. */
export const ADMIN_DESK_H = 1.05
export const CUBE = { w: 1.7, d: 1.75, wallH: 1.25, wallT: 0.05, perRow: 4, aisle: 1.4 }
export const BUILDING = { corridor: 2.6, wallT: 0.1, door: 1.3, height: 3.1, minDepth: 6.5 }
/** Fixed room widths (sized for a full row), so a busy room never pushes its neighbours. */
const ROOM_W: Record<RoomKind, number> = { racks: RACK.perRow * (RACK.w + RACK.gap) + 2, office: CUBE.perRow * CUBE.w + 1.6, balcony: 8 }
/** Balcony depth (out from the corridor's outer wall) and its door. */
export const BALCONY = { d: 4.6, door: 1.6, table: { w: 0.8, d: 0.6, h: 0.7 }, railH: 1.05 }
/** Printer on a low cabinet: footprint and top height. */
export const PRINTER = { w: 0.6, d: 0.55, h: 0.75 }
/** Space between the corridor wall and the first row of racks or cubicles. */
const ENTRY = { racks: 3.6, office: 2.4 }
/** Height of the overhead cable tray. */
export const TRAY_Y = 2.35
/** Mounting zone inside a rack: devices stack down from the top. */
export const MOUNT_TOP = 1.84
export const MOUNT_BOTTOM = 0.5
export const MOUNT_GAP = 0.035
/** Wall-mounted mini rack (IDF): hangs on an office's back wall, chest height. */
export const WALL_RACK = { w: 0.6, h: 0.72, d: 0.45, bottom: 1.02 }
/** Wall rack ids start here, so they never clash with floor rack numbers. */
export const WALL_RACK_BASE = 1000
const isWallRack = (k: number) => k >= WALL_RACK_BASE
/** Where devices stack inside a rack of each kind. */
const mountZone = (k: number) =>
  isWallRack(k) ? { top: WALL_RACK.bottom + WALL_RACK.h - 0.05, bottom: WALL_RACK.bottom + 0.04 } : { top: MOUNT_TOP, bottom: MOUNT_BOTTOM }

/** Default room colours (2D boxes and 3D signs); players can change them. */
export const ROOM_COLORS: Record<string, string> = { server: '#22d3ee', it: '#39ff88', accounting: '#ffc94d', sales: '#ff6bd6' }
const EXTRA_COLORS = ['#a5b4fc', '#ff8a4d', '#7dd3fc', '#c084fc', '#facc15', '#f87171']
const PORT_PITCH = 0.06

const PANEL: Record<DeviceType, { w: number; h: number }> = {
  router: { w: 0.44, h: 0.13 },
  firewall: { w: 0.44, h: 0.13 },
  switch: { w: 0.44, h: 0.1 },
  server: { w: 0.44, h: 0.18 },
  pc: { w: 0.2, h: 0.42 },
  laptop: { w: 0.34, h: 0.022 },
  ap: { w: 0.26, h: 0.05 },
  patch: { w: 0.44, h: 0.13 },
  isp: { w: 0.44, h: 0.1 }, // never placed: the ISP is outside the building
  modem: { w: 0.44, h: 0.06 },
  printer: { w: 0.5, h: 0.32 },
  phone: { w: 0.2, h: 0.05 },
  mobile: { w: 0.075, h: 0.012 }, // lying flat on a desk; held upright on a balcony
}

export const panelHeight = (type: DeviceType) => PANEL[type].h

/** Whether devices of these heights fit in one rack (`rack` picks floor or wall size). */
export function rackHasRoom(heights: number[], rack = 0): boolean {
  const z = mountZone(rack)
  return heights.reduce((s, h) => s + h + MOUNT_GAP, 0) - MOUNT_GAP <= z.top - z.bottom + 1e-9
}

/** Devices that live in offices (desks, printer stands, on a desk) instead of in racks. */
export const onDesk = (d: Pick<Device, 'type'>) => ['pc', 'laptop', 'mobile', 'ap', 'printer', 'phone'].includes(d.type)

/** A room's colour: the one the player picked, or the default. */
export function roomColor(topo: Topology, id: RoomId): string {
  const custom = topo.rooms?.[id]?.color
  if (custom) return custom
  const k = (topo.customRooms ?? []).findIndex((r) => r.id === id)
  return ROOM_COLORS[id] ?? EXTRA_COLORS[Math.max(0, k) % EXTRA_COLORS.length]
}

/** A room's name: the one the player gave it, or the default. */
export function roomLabel(topo: Topology, id: RoomId): string {
  const custom = topo.rooms?.[id]?.label?.trim()
  return custom || roomsOf(topo).find((r) => r.id === id)?.label || id
}

/**
 * Which room a device is in: desk devices in their office, rack gear in the room of
 * its rack (the server room, or an office with a wall rack). Pass the topology so
 * wall racks can be looked up.
 */
export function roomOf(d: Device, topo?: Topology): RoomId {
  if (!onDesk(d)) {
    const wall = d.rack !== undefined && d.rack >= WALL_RACK_BASE ? topo?.wallRacks?.find((w) => w.id === d.rack) : undefined
    return wall && topo && officesOf(topo).some((o) => o.id === wall.room) ? wall.room : 'server'
  }
  // A desk phone is wherever the PC it sits next to is.
  const host = d.deskOf && topo?.devices.find((x) => x.id === d.deskOf)
  if (host && host !== d && !host.deskOf) return roomOf(host, topo)
  const rooms = topo ? deskRoomsFor(topo, d.type) : BASE_ROOMS.filter((r) => r.kind === 'office')
  return rooms.some((r) => r.id === d.room) ? d.room! : topo ? defaultOffice(topo) : DEFAULT_OFFICE
}

/** Port positions on the panel (radios have none). Switches use two rows, odd ports on top, like Cisco. */
export function portSpots(d: Device): PortSpot[] {
  const of = (k: PortKind) => d.ifaces.filter((i) => portKind(d, i.name) === k).map((i) => i.name)
  const copper = of('copper')
  const fiber = of('fiber')
  const consoles = of('console')
  const at = (iface: string, x: number, y: number): PortSpot => ({ iface, x, y })
  if (d.type === 'pc') return [...copper.map((n) => at(n, 0, 0.06)), ...consoles.map((n) => at(n, 0, -0.02))]
  if (d.type === 'laptop' || d.type === 'mobile' || d.type === 'isp') return []
  if (d.type === 'phone') return copper.map((n) => at(n, n === 'pc' ? 0.035 : 0.077, 0))
  if (d.type === 'printer') return copper.map((n) => at(n, 0.18, -0.09))
  if (d.type === 'patch') {
    // Two rows of 24 RJ45 jacks in front, and the rear punch-down side shown as two rows below.
    const x0 = -PANEL.patch.w / 2 + 0.018
    const pitch = (PANEL.patch.w - 0.036) / 23
    return d.ifaces.map((i) => {
      const n = Number(i.name.slice(1).replace('r', '')) - 1
      const rear = i.name.endsWith('r')
      const row = Math.floor(n / 24)
      return at(i.name, x0 + (n % 24) * pitch, rear ? -0.022 - row * 0.022 : 0.042 - row * 0.022)
    })
  }
  if (d.type === 'ap') return [...copper.map((n) => at(n, 0.08, 0)), ...consoles.map((n) => at(n, 0.02, 0))]

  const { w, h } = PANEL[d.type]
  const spots: PortSpot[] = []
  // Right to left: fiber cages, then the copper block; the console port sits bottom-left under the name.
  let right = w / 2 - 0.03
  if (d.type === 'switch') {
    fiber.forEach((n, k) => spots.push(at(n, right, k % 2 === 0 ? 0.022 : -0.022)))
    if (fiber.length) right -= 0.075
    const cols = Math.ceil(copper.length / 2)
    const x0 = right - (cols - 1) * PORT_PITCH
    copper.forEach((n, k) => spots.push(at(n, x0 + Math.floor(k / 2) * PORT_PITCH, k % 2 === 0 ? 0.022 : -0.022)))
  } else {
    fiber.forEach((n, k) => spots.push(at(n, right - k * 0.05, -0.01)))
    if (fiber.length) right -= fiber.length * 0.05 + 0.02
    const x0 = right - (copper.length - 1) * PORT_PITCH
    copper.forEach((n, k) => spots.push(at(n, x0 + k * PORT_PITCH, -0.01)))
  }
  consoles.forEach((n) => spots.push(at(n, -w / 2 + 0.05, -h / 2 + 0.016)))
  return spots
}

export function roomLayout(topo: Topology): RoomLayout {
  const racked = topo.devices.filter((d) => !onDesk(d) && !isOutside(d))
  const placements: Placement[] = []
  const obstacles: Box2[] = []

  // Rooms side by side along x; the corridor wall is at z = 0, rooms extend to -z.
  const rooms: Room[] = []
  let x = 0
  for (const r of roomsOf(topo).filter((r) => r.kind !== 'balcony')) {
    const w = ROOM_W[r.kind]
    rooms.push({ id: r.id, label: roomLabel(topo, r.id), kind: r.kind, x0: x, x1: x + w, z0: 0, z1: 0, doorX: x + w / 2 })
    x += w
  }
  const room = (id: RoomId) => rooms.find((r) => r.id === id)!
  const server = room('server')

  // Stack rack devices top-down. Devices with a chosen rack (d.rack, from the add
  // dialog, a drop or a rearrange) go first, in slot order; the rest follow in device
  // order, each into the first floor rack with room. Appending never moves anything.
  const wallRacks = (topo.wallRacks ?? []).filter((w) => officesOf(topo).some((o) => o.id === w.room))
  const rackExists = (k: number) => !isWallRack(k) || wallRacks.some((w) => w.id === k)
  const fill: Record<number, number> = {} // used height per rack
  const fits = (k: number, h: number) => mountZone(k).top - (fill[k] ?? 0) - h >= mountZone(k).bottom - 1e-9
  const index = new Map(racked.map((d, k) => [d.id, k]))
  const chosen = racked
    .filter((d) => d.rack !== undefined && d.rack >= 0 && rackExists(d.rack))
    .sort((a, b) => a.rack! - b.rack! || (a.slot ?? Infinity) - (b.slot ?? Infinity) || index.get(a.id)! - index.get(b.id)!)
  const order = [...chosen, ...racked.filter((d) => !chosen.includes(d))]
  const mounts: { d: Device; k: number; top: number }[] = []
  for (const d of order) {
    const h = PANEL[d.type].h
    let k = d.rack !== undefined && d.rack >= 0 && rackExists(d.rack) && fits(d.rack, h) ? d.rack : 0
    // A full wall rack spills into the server room's floor racks.
    if (isWallRack(k) && !fits(k, h)) k = 0
    while (!fits(k, h)) k++
    mounts.push({ d, k, top: mountZone(k).top - (fill[k] ?? 0) })
    fill[k] = (fill[k] ?? 0) + h + MOUNT_GAP
  }
  // Floor rack k: rows start near the door and grow deeper, so new rows never move old ones.
  const floorCount = Math.max(topo.serverRacks ?? 0, ...Object.keys(fill).map(Number).filter((k) => !isWallRack(k)).map((k) => k + 1))
  const racks: RackSpot[] = []
  for (let k = 0; k < floorCount; k++) {
    const x = server.x0 + 1 + RACK.w / 2 + (k % RACK.perRow) * (RACK.w + RACK.gap)
    const z = -ENTRY.racks - Math.floor(k / RACK.perRow) * RACK.rowPitch
    racks.push({ index: k, kind: 'floor', room: 'server', name: `Rack ${k + 1}`, x, z, deviceIds: [] })
    obstacles.push({ minX: x - RACK.w / 2, maxX: x + RACK.w / 2, minZ: z - RACK.d, maxZ: z })
  }
  // Admin desks in the server room: side by side in the middle of the room, straight
  // ahead as you come in the door, with the racks behind them. Walk round the sides
  // to reach the racks.
  const adminDesks = topo.devices.filter((d) => ADMIN_DESK_TYPES.includes(d.type) && roomOf(d, topo) === 'server')
  const pitch = DESK.w + 0.1
  const deskXs = [-0.5, 0.5, -1.5, 1.5]
    .map((k) => server.doorX + k * pitch)
    .filter((x) => x - DESK.w / 2 >= server.x0 + 0.1 && x + DESK.w / 2 <= server.x1 - 0.1)
  adminDesks.forEach((d, k) => {
    const x = deskXs[k % deskXs.length]
    const z = -1.75 // front edge, facing the door; the desk's back is towards the racks
    const p = PANEL[d.type]
    const px = d.type === 'pc' ? x - DESK.w / 2 + 0.2 : x
    const pz = d.type === 'laptop' ? z - 0.2 : z - 0.12
    placements.push({ deviceId: d.id, station: 'desk', x, z, deskH: ADMIN_DESK_H, panel: { x: px, y: ADMIN_DESK_H + p.h / 2, z: pz, ...p }, ports: portSpots(d) })
    obstacles.push({ minX: x - DESK.w / 2, maxX: x + DESK.w / 2, minZ: z - DESK.d, maxZ: z })
  })
  let depth = Math.max(BUILDING.minDepth, ...racks.map((r) => -(r.z - RACK.d) + 1))
  // Offices with wall racks need room on the back wall behind the deepest cubicles.
  const wallSpace = (id: RoomId) => (wallRacks.some((w) => w.room === id) ? WALL_RACK.d + 1.1 : 0)

  // A phone sits on its PC's desk; one without a PC (or on another phone) gets its own cubicle.
  const deskHost = (d: Device) => {
    const h = d.type === 'phone' && d.deskOf ? topo.devices.find((x) => x.id === d.deskOf) : undefined
    return h && (h.type === 'pc' || h.type === 'laptop') ? h : undefined
  }
  // APs aren't on desks: on the ceiling in offices, on the outside wall by balconies.
  const inCubicle = (d: Device) => d.type === 'pc' || d.type === 'laptop' || d.type === 'mobile' || (d.type === 'phone' && !deskHost(d))

  // Offices: one cubicle per desk device, in rows facing the door (+z), deeper rows behind.
  const cubicles: Cubicle[] = []
  for (const office of rooms.filter((r) => r.kind === 'office')) {
    const here = topo.devices.filter((d) => inCubicle(d) && roomOf(d, topo) === office.id)
    const cols = Math.min(CUBE.perRow, here.length)
    here.forEach((d, k) => {
      const col = k % CUBE.perRow
      const row = Math.floor(k / CUBE.perRow)
      const x = office.x0 + 0.8 + CUBE.w / 2 + col * CUBE.w
      const open = -ENTRY.office - row * (CUBE.d + CUBE.aisle)
      const back = open - CUBE.d
      // The desk sits against the back wall; z is its front edge.
      const z = back + CUBE.wallT + DESK.d
      const p = PANEL[d.type]
      // A PC tower stands on the left of the desk next to its monitor; laptops and APs sit in the middle.
      const px = d.type === 'pc' ? x - DESK.w / 2 + 0.2 : x
      const pz = d.type === 'laptop' || d.type === 'mobile' ? z - 0.2 : z - 0.12
      placements.push({ deviceId: d.id, station: 'desk', x, z, panel: { x: px, y: DESK.h + p.h / 2, z: pz, ...p }, ports: portSpots(d) })
      const last = col === cols - 1 || k === here.length - 1
      cubicles.push({ deviceId: d.id, x, back, rightWall: last })
      const half = CUBE.w / 2
      const t = CUBE.wallT
      obstacles.push({ minX: x - DESK.w / 2, maxX: x + DESK.w / 2, minZ: z - DESK.d, maxZ: z })
      obstacles.push({ minX: x - half, maxX: x + half, minZ: back, maxZ: back + t })
      obstacles.push({ minX: x - half - t / 2, maxX: x - half + t / 2, minZ: back, maxZ: back + CUBE.d })
      if (last) obstacles.push({ minX: x + half - t / 2, maxX: x + half + t / 2, minZ: back, maxZ: back + CUBE.d })
      depth = Math.max(depth, -back + 1 + wallSpace(office.id))
    })
    // Ceiling APs: a row of pucks over the entrance aisle, ports on their front edge.
    const aps = topo.devices.filter((d) => d.type === 'ap' && roomOf(d, topo) === office.id)
    aps.forEach((d, k) => {
      const x = (office.x0 + office.x1) / 2 + (k - (aps.length - 1) / 2) * 1.8
      const z = -1.3
      const p = PANEL.ap
      placements.push({ deviceId: d.id, station: 'ceiling', x, z, panel: { x, y: BUILDING.height - 0.1 - p.h / 2, z, ...p }, ports: portSpots(d) })
    })
    // Printers stand on low cabinets just inside the room, right of the door, facing the door.
    topo.devices
      .filter((d) => d.type === 'printer' && roomOf(d, topo) === office.id)
      .forEach((d, k) => {
        const x = office.x1 - 0.8 - k * (PRINTER.w + 0.3)
        const z = -1.1
        const p = PANEL.printer
        placements.push({ deviceId: d.id, station: 'printer', x, z, panel: { x, y: PRINTER.h + p.h / 2, z: z - 0.06, ...p }, ports: portSpots(d) })
        obstacles.push({ minX: x - PRINTER.w / 2, maxX: x + PRINTER.w / 2, minZ: z - PRINTER.d, maxZ: z })
      })
  }

  // Balconies: out from the corridor's outer wall, side by side from the first office.
  const C = BUILDING.corridor
  const seats: RoomLayout['seats'] = []
  let bx = (rooms.find((r) => r.kind === 'office')?.x0 ?? 0) + 0.6
  for (const r of roomsOf(topo).filter((r) => r.kind === 'balcony')) {
    const w = ROOM_W.balcony
    const b: Room = { id: r.id, label: roomLabel(topo, r.id), kind: 'balcony', x0: bx, x1: bx + w, z0: C, z1: C + BALCONY.d, doorX: bx + w / 2 }
    rooms.push(b)
    bx += w + 0.6
    // Railing on three sides.
    const t = 0.05
    obstacles.push({ minX: b.x0, maxX: b.x1, minZ: b.z1 - t, maxZ: b.z1 + t })
    obstacles.push({ minX: b.x0 - t, maxX: b.x0 + t, minZ: b.z0, maxZ: b.z1 })
    obstacles.push({ minX: b.x1 - t, maxX: b.x1 + t, minZ: b.z0, maxZ: b.z1 })
    // APs on the building's outside wall, beside the balcony door, facing the balcony.
    topo.devices
      .filter((d) => d.type === 'ap' && roomOf(d, topo) === r.id)
      .forEach((d, k) => {
        const x = b.doorX - BALCONY.door / 2 - 0.7 - k * 0.8
        const z = C + BUILDING.wallT / 2 + 0.2
        const p = PANEL.ap
        placements.push({ deviceId: d.id, station: 'wall', x, z, panel: { x, y: 2.35, z, ...p }, ports: portSpots(d) })
      })
    // Lounge chairs (a row by the railing and a staggered row behind it) and, between
    // the front chairs, places at the railing.
    const spots: RoomLayout['seats'] = []
    for (let sx = b.x0 + 1.1; sx < b.x1 - 0.8; sx += 2.1) {
      spots.push({ x: sx, z: b.z1 - 1.0, pose: 'sit' })
      obstacles.push({ minX: sx - 0.35, maxX: sx + 0.35, minZ: b.z1 - 1.4, maxZ: b.z1 - 0.6 })
      const back = sx + 1.05
      if (back < b.x1 - 0.8) {
        spots.push({ x: back, z: b.z1 - 2.5, pose: 'sit' })
        obstacles.push({ minX: back - 0.35, maxX: back + 0.35, minZ: b.z1 - 2.9, maxZ: b.z1 - 2.1 })
      }
      if (back < b.x1 - 0.6) spots.push({ x: back, z: b.z1 - 0.3, pose: 'stand' })
    }
    // People using the balcony's laptops and smartphones: laptops on lounge chairs,
    // smartphones at the railing (then on any free spot). The rest go on tables.
    const users = topo.devices.filter((d) => (d.type === 'laptop' || d.type === 'mobile') && !deskHost(d) && roomOf(d, topo) === r.id)
    const free = (pose: 'sit' | 'stand') => spots.find((s) => !s.deviceId && s.pose === pose)
    const onTable: Device[] = []
    for (const d of users) {
      const spot = d.type === 'laptop' ? free('sit') : (free('stand') ?? free('sit'))
      if (!spot) {
        onTable.push(d)
        continue
      }
      spot.deviceId = d.id
      const p = PANEL[d.type]
      // Panel: the laptop on the person's lap, or the phone held in front of them.
      const panel =
        spot.pose === 'sit'
          ? { x: spot.x, y: 0.6, z: spot.z + 0.32, ...p }
          : { x: spot.x + 0.17, y: 1.2, z: spot.z + 0.12, ...p }
      placements.push({ deviceId: d.id, station: 'held', x: spot.x, z: spot.z, panel, ports: portSpots(d) })
    }
    for (const s of spots) if (s.pose === 'stand' && s.deviceId) obstacles.push({ minX: s.x - 0.25, maxX: s.x + 0.25, minZ: s.z - 0.2, maxZ: s.z + 0.2 })
    seats.push(...spots)
    // Anything else (and laptops beyond the chairs) on small tables by the wall.
    const T = BALCONY.table
    topo.devices
      .filter((d) => onDesk(d) && d.type !== 'ap' && !deskHost(d) && roomOf(d, topo) === r.id && !users.includes(d) || onTable.includes(d))
      .forEach((d, k) => {
        const tx = b.x0 + 0.9 + k * 1.5
        const tz = b.z0 + 0.4 + T.d
        const p = PANEL[d.type]
        const pz = d.type === 'laptop' || d.type === 'mobile' ? tz - 0.2 : tz - 0.12
        placements.push({ deviceId: d.id, station: 'lounge', x: tx, z: tz, panel: { x: tx, y: T.h + p.h / 2, z: pz, ...p }, ports: portSpots(d) })
        obstacles.push({ minX: tx - T.w / 2, maxX: tx + T.w / 2, minZ: tz - T.d, maxZ: tz })
      })
  }
  const balconies = rooms.filter((r) => r.kind === 'balcony')

  // Walls: the building outline, walls between rooms, and each room's front wall
  // with a doorway onto the corridor. The server room's front wall is glass. The
  // corridor's outer wall has a door onto each balcony.
  const total = Math.max(x, ...balconies.map((b) => b.x1 + 0.6))
  for (const r of rooms) if (r.kind !== 'balcony') r.z0 = -depth
  const walls: Wall[] = [
    { x0: 0, z0: -depth, x1: total, z1: -depth },
    { x0: 0, z0: -depth, x1: 0, z1: C },
    { x0: total, z0: -depth, x1: total, z1: C },
  ]
  let wx = 0
  for (const b of [...balconies].sort((a, c) => a.doorX - c.doorX)) {
    walls.push({ x0: wx, z0: C, x1: b.doorX - BALCONY.door / 2, z1: C })
    wx = b.doorX + BALCONY.door / 2
  }
  walls.push({ x0: wx, z0: C, x1: total, z1: C })
  if (total > x) walls.push({ x0: x, z0: -depth, x1: x, z1: 0 }) // end of the room row if balconies run past it
  for (const r of rooms.filter((r) => r.kind !== 'balcony')) {
    if (r.x0 > 0) walls.push({ x0: r.x0, z0: -depth, x1: r.x0, z1: 0 })
    const glass = r.kind === 'racks'
    walls.push({ x0: r.x0, z0: 0, x1: r.doorX - BUILDING.door / 2, z1: 0, glass })
    walls.push({ x0: r.doorX + BUILDING.door / 2, z0: 0, x1: r.x1, z1: 0, glass })
  }
  const t = BUILDING.wallT / 2
  for (const w of walls) obstacles.push({ minX: Math.min(w.x0, w.x1) - t, maxX: Math.max(w.x0, w.x1) + t, minZ: Math.min(w.z0, w.z1) - t, maxZ: Math.max(w.z0, w.z1) + t })

  // Wall racks hang on their office's back wall, left to right.
  for (const office of rooms.filter((r) => r.kind === 'office')) {
    wallRacks
      .filter((w) => w.room === office.id)
      .forEach((w, n) => {
        const x = office.x0 + 0.9 + WALL_RACK.w / 2 + n * (WALL_RACK.w + 0.35)
        const z = -depth + WALL_RACK.d
        racks.push({ index: w.id, kind: 'wall', room: office.id, name: w.name, x, z, deviceIds: [] })
        obstacles.push({ minX: x - WALL_RACK.w / 2, maxX: x + WALL_RACK.w / 2, minZ: -depth, maxZ: z })
      })
  }
  for (const { d, k, top } of mounts) {
    const rack = racks.find((r) => r.index === k)!
    const p = PANEL[d.type]
    placements.push({ deviceId: d.id, station: 'rack', rack: k, x: rack.x, z: rack.z, panel: { x: rack.x, y: top - p.h / 2, z: rack.z - 0.06, ...p }, ports: portSpots(d) })
    rack.deviceIds.push(d.id)
  }
  // Desk phones: on the right of their PC's desk (or the laptop's lounge table).
  for (const d of topo.devices.filter((x) => x.type === 'phone' && deskHost(x))) {
    const host = placements.find((p) => p.deviceId === deskHost(d)!.id)
    if (!host) continue
    const p = PANEL.phone
    const right = host.station === 'lounge' ? 0.22 : 0.45
    const top = host.station === 'lounge' ? BALCONY.table.h : (host.deskH ?? DESK.h)
    placements.push({ deviceId: d.id, station: 'phone', x: host.x + right, z: host.z, panel: { x: host.x + right, y: top + p.h / 2, z: host.z - 0.18, ...p }, ports: portSpots(d) })
  }

  const r0 = racks[0]
  const c0 = cubicles[0]
  // Aim at the middle of what is mounted in rack 1 (devices stack from the top).
  const mounted = r0 ? placements.filter((p) => p.rack === r0.index) : []
  const lookY = mounted.length ? mounted.reduce((s, p) => s + p.panel.y, 0) / mounted.length : 1.2
  const spawn = { x: 1.2, z: C / 2 }
  const home: RoomLayout['home'] = r0
    ? { x: r0.x - 0.15, z: r0.z + 1.0, look: [r0.x - 0.15, lookY, r0.z - 0.3], rack: r0.index }
    : c0
      ? { x: c0.x, z: c0.back + CUBE.d + 0.9, look: [c0.x, 0.9, c0.back + 0.3] }
      : { ...spawn, look: [spawn.x + 5, 1.4, spawn.z] }
  return {
    placements,
    racks,
    cubicles,
    rooms,
    walls,
    seats,
    corridor: { minX: 0, maxX: total, minZ: 0, maxZ: C },
    home,
    obstacles,
    bounds: { minX: -t, maxX: total + t, minZ: -depth - t, maxZ: Math.max(C, ...balconies.map((b) => b.z1)) + t },
    spawn,
  }
}

/** The room containing a floor point, if any (the corridor is not a room). */
export function roomAt(layout: RoomLayout, x: number, z: number): Room | undefined {
  return layout.rooms.find((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)
}

/**
 * Moves a rack-mounted device to position `index` (0 = top) of rack `rack`.
 * Pins every rack device to its rack and slot, so later additions can't reshuffle
 * them. Returns an error message, or null on success.
 */
export function moveDeviceInRack(topo: Topology, deviceId: string, rack: number, index: number): string | null {
  const byId = new Map(topo.devices.map((d) => [d.id, d]))
  if (!byId.has(deviceId) || onDesk(byId.get(deviceId)!)) return 'Only rack-mounted devices can be moved between racks'
  const lists: string[][] = []
  for (const r of roomLayout(topo).racks) lists[r.index] = r.deviceIds.filter((id) => id !== deviceId)
  const target = (lists[rack] ??= [])
  const name = roomLayout(topo).racks.find((r) => r.index === rack)?.name ?? `Rack ${rack + 1}`
  if (!rackHasRoom([...target, deviceId].map((id) => panelHeight(byId.get(id)!.type)), rack)) return `${name} is full`
  target.splice(Math.max(0, Math.min(index, target.length)), 0, deviceId)
  lists.forEach((ids, k) =>
    ids?.forEach((id, slot) => {
      const d = byId.get(id)!
      d.rack = k
      d.slot = slot
    }),
  )
  return null
}

/**
 * Deletes a rack. Its devices are re-mounted in the server room's floor racks
 * (a new rack opens if those are full). Floor racks after it move up one place,
 * so rack numbers stay 1, 2, 3… Returns the rack's name, or null if it doesn't exist.
 */
export function deleteRack(topo: Topology, index: number): string | null {
  const rack = roomLayout(topo).racks.find((r) => r.index === index)
  if (!rack) return null
  for (const d of topo.devices.filter((d) => rack.deviceIds.includes(d.id))) {
    delete d.rack
    delete d.slot
  }
  if (topo.rackPos) delete topo.rackPos[index]
  if (rack.kind === 'wall') {
    topo.wallRacks = (topo.wallRacks ?? []).filter((w) => w.id !== index)
    return rack.name
  }
  const floors = roomLayout(topo).racks.filter((r) => r.kind === 'floor').length
  for (const d of topo.devices) if (d.rack !== undefined && d.rack > index && d.rack < WALL_RACK_BASE) d.rack--
  if (topo.rackPos) {
    const moved: typeof topo.rackPos = {}
    for (const [k, v] of Object.entries(topo.rackPos)) {
      const n = Number(k)
      moved[n > index && n < WALL_RACK_BASE ? n - 1 : n] = v
    }
    topo.rackPos = moved
  }
  topo.serverRacks = Math.max(0, floors - 1)
  return rack.name
}

/** Moves a circle of radius r from (x, z) by (dx, dz), sliding along walls and furniture. */
/** Whether a player of radius `r` standing at (x, z) is inside a wall, railing or piece of furniture. */
export function isBlocked(layout: RoomLayout, x: number, z: number, r = 0.3): boolean {
  const b = layout.bounds
  if (x - r < b.minX || x + r > b.maxX || z - r < b.minZ || z + r > b.maxZ) return true
  return layout.obstacles.some((o) => x + r > o.minX && x - r < o.maxX && z + r > o.minZ && z - r < o.maxZ)
}

/**
 * The free spot nearest (x, z) where the player can stand: (x, z) itself when it's clear,
 * otherwise the closest clear point on growing rings around it. If `near` is given, ties
 * go to the point closest to it (e.g. the device you want to look at).
 */
export function freeSpot(layout: RoomLayout, x: number, z: number, near?: { x: number; z: number }): { x: number; z: number } {
  if (!isBlocked(layout, x, z)) return { x, z }
  for (let ring = 0.15; ring <= 4; ring += 0.15) {
    let best: { x: number; z: number; d: number } | null = null
    const steps = Math.ceil((ring * Math.PI * 2) / 0.15)
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2
      const px = x + Math.cos(a) * ring
      const pz = z + Math.sin(a) * ring
      if (isBlocked(layout, px, pz)) continue
      const d = near ? Math.hypot(px - near.x, pz - near.z) : 0
      if (!best || d < best.d) best = { x: px, z: pz, d }
    }
    if (best) return { x: best.x, z: best.z }
  }
  return { ...layout.spawn }
}

export function collide(layout: RoomLayout, x: number, z: number, dx: number, dz: number, r = 0.3): { x: number; z: number } {
  const blocked = (px: number, pz: number) => isBlocked(layout, px, pz, r)
  let nx = x
  let nz = z
  if (!blocked(x + dx, z)) nx = x + dx
  if (!blocked(nx, z + dz)) nz = z + dz
  return { x: nx, z: nz }
}
