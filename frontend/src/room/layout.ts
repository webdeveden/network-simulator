/**
 * Where everything sits in the 3D server room. Pure data, no Three.js, so it
 * can be unit tested. Units are metres; every device faces +z, towards the
 * player's spawn point.
 */
import { isRadio } from '../engine/network'
import type { Device, DeviceType, Topology } from '../engine/types'

export type Station = 'rack' | 'desk'

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

/** Glass wall between the server room (behind) and the office, with a doorway. */
export interface Partition {
  z: number
  minX: number
  maxX: number
  doorX: number
}

export interface RoomLayout {
  placements: Placement[]
  racks: RackSpot[]
  cubicles: Cubicle[]
  partition?: Partition
  obstacles: Box2[]
  bounds: Box2
  spawn: { x: number; z: number }
  /** Starting view: close up in front of rack 1 (or the first cubicle). */
  home: { x: number; z: number; look: [number, number, number]; rack?: number }
}

export const RACK = { w: 0.6, h: 2.0, d: 0.9, gap: 0.12, perRow: 7, rowPitch: 2.8 }
export const DESK = { w: 1.2, h: 0.75, d: 0.7, gap: 0.3 }
export const CUBE = { w: 1.7, d: 1.75, wallH: 1.25, wallT: 0.05, perRow: 6, aisle: 1.4 }
export const PARTITION = { h: 2.25, t: 0.06, door: 1.4, /** gap between the rack fronts and the glass: room for open doors */ front: 1.5 }
/** Height of the overhead cable tray. */
export const TRAY_Y = 2.35
/** Mounting zone inside a rack: devices stack down from the top. */
export const MOUNT_TOP = 1.84
export const MOUNT_BOTTOM = 0.5
export const MOUNT_GAP = 0.035
const PORT_PITCH = 0.06

const PANEL: Record<DeviceType, { w: number; h: number }> = {
  router: { w: 0.44, h: 0.13 },
  firewall: { w: 0.44, h: 0.13 },
  switch: { w: 0.44, h: 0.1 },
  server: { w: 0.44, h: 0.18 },
  pc: { w: 0.2, h: 0.42 },
  laptop: { w: 0.34, h: 0.022 },
  ap: { w: 0.26, h: 0.05 },
}

export const panelHeight = (type: DeviceType) => PANEL[type].h

/** Whether devices of these heights fit in one rack. */
export function rackHasRoom(heights: number[]): boolean {
  return heights.reduce((s, h) => s + h + MOUNT_GAP, 0) - MOUNT_GAP <= MOUNT_TOP - MOUNT_BOTTOM + 1e-9
}

/** Devices that live on desks instead of in racks. */
export const onDesk = (d: Device) => d.type === 'pc' || d.type === 'laptop' || d.type === 'ap'

/** Port positions on the panel (radios have none). Switches use two rows, odd ports on top, like Cisco. */
export function portSpots(d: Device): PortSpot[] {
  const wired = d.ifaces.filter((i) => !isRadio(i.name))
  const n = wired.length
  if (d.type === 'pc') return wired.map((i) => ({ iface: i.name, x: 0, y: 0.06 }))
  if (d.type === 'ap') return wired.map((i) => ({ iface: i.name, x: 0.08, y: 0 }))
  if (d.type === 'switch') {
    const cols = Math.ceil(n / 2)
    const x0 = PANEL.switch.w / 2 - 0.03 - (cols - 1) * PORT_PITCH
    return wired.map((i, k) => ({ iface: i.name, x: x0 + Math.floor(k / 2) * PORT_PITCH, y: k % 2 === 0 ? 0.022 : -0.022 }))
  }
  const x0 = PANEL[d.type].w / 2 - 0.03 - (n - 1) * PORT_PITCH
  return wired.map((i, k) => ({ iface: i.name, x: x0 + k * PORT_PITCH, y: -0.01 }))
}

/** Where rack k stands. Fixed per index, so adding racks never moves the existing ones. */
function rackXZ(k: number) {
  return { x: (k % RACK.perRow) * (RACK.w + RACK.gap), z: -Math.floor(k / RACK.perRow) * RACK.rowPitch }
}

export function roomLayout(topo: Topology): RoomLayout {
  const racked = topo.devices.filter((d) => !onDesk(d))
  const desked = topo.devices.filter(onDesk)
  const placements: Placement[] = []
  const obstacles: Box2[] = []

  // Stack rack devices top-down. Devices with a chosen rack (d.rack, from a drop or a
  // rearrange) go first, in slot order; the rest follow in device order, each into the
  // first rack with room. Appending a device never moves the ones already placed.
  const fill: number[] = [] // used height per rack
  const racks: RackSpot[] = []
  const fits = (k: number, h: number) => MOUNT_TOP - (fill[k] ?? 0) - h >= MOUNT_BOTTOM - 1e-9
  const index = new Map(racked.map((d, k) => [d.id, k]))
  const chosen = racked
    .filter((d) => d.rack !== undefined && d.rack >= 0)
    .sort((a, b) => a.rack! - b.rack! || (a.slot ?? Infinity) - (b.slot ?? Infinity) || index.get(a.id)! - index.get(b.id)!)
  const order = [...chosen, ...racked.filter((d) => !chosen.includes(d))]
  for (const d of order) {
    const p = PANEL[d.type]
    let k = d.rack !== undefined && d.rack >= 0 && fits(d.rack, p.h) ? d.rack : 0
    while (!fits(k, p.h)) k++
    const top = MOUNT_TOP - (fill[k] ?? 0)
    fill[k] = (fill[k] ?? 0) + p.h + MOUNT_GAP
    const { x, z } = rackXZ(k)
    placements.push({ deviceId: d.id, station: 'rack', rack: k, x, z, panel: { x, y: top - p.h / 2, z: z - 0.06, ...p }, ports: portSpots(d) })
  }
  fill.forEach((_, k) => {
    const { x, z } = rackXZ(k)
    racks.push({ index: k, x, z, deviceIds: placements.filter((p) => p.rack === k).map((p) => p.deviceId) })
    obstacles.push({ minX: x - RACK.w / 2, maxX: x + RACK.w / 2, minZ: z - RACK.d, maxZ: z })
  })

  // Office: one cubicle per desk device, in rows facing the entrance (+z).
  const cubicles: Cubicle[] = []
  const officeStart = racks.length ? PARTITION.front + 1.1 : 0
  const cols = Math.min(CUBE.perRow, desked.length)
  desked.forEach((d, k) => {
    const col = k % CUBE.perRow
    const row = Math.floor(k / CUBE.perRow)
    const x = col * CUBE.w
    const back = officeStart + row * (CUBE.d + CUBE.aisle)
    // The desk sits against the back wall; z is its front edge.
    const z = back + CUBE.wallT + DESK.d
    const p = PANEL[d.type]
    // A PC tower stands on the left of the desk next to its monitor; laptops and APs sit in the middle.
    const px = d.type === 'pc' ? x - DESK.w / 2 + 0.2 : x
    const pz = d.type === 'laptop' ? z - 0.2 : z - 0.12
    placements.push({ deviceId: d.id, station: 'desk', x, z, panel: { x: px, y: DESK.h + p.h / 2, z: pz, ...p }, ports: portSpots(d) })
    const last = col === cols - 1 || k === desked.length - 1
    cubicles.push({ deviceId: d.id, x, back, rightWall: last })
    const half = CUBE.w / 2
    const t = CUBE.wallT
    obstacles.push({ minX: x - DESK.w / 2, maxX: x + DESK.w / 2, minZ: z - DESK.d, maxZ: z })
    obstacles.push({ minX: x - half, maxX: x + half, minZ: back, maxZ: back + t })
    obstacles.push({ minX: x - half - t / 2, maxX: x - half + t / 2, minZ: back, maxZ: back + CUBE.d })
    if (last) obstacles.push({ minX: x + half - t / 2, maxX: x + half + t / 2, minZ: back, maxZ: back + CUBE.d })
  })

  const xs = obstacles.flatMap((o) => [o.minX, o.maxX])
  const zs = obstacles.flatMap((o) => [o.minZ, o.maxZ])
  const minX = Math.min(-2, ...xs) - 2
  const maxX = Math.max(2, ...xs) + 2
  const front = Math.max(2, ...zs) + 3.5
  const back = Math.min(-2, ...zs) - 1.5
  const midX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0

  // Glass partition between the racks and the office, with a doorway in the middle.
  let partition: Partition | undefined
  if (racks.length && desked.length) {
    const z = PARTITION.front
    const doorX = racks.reduce((s, r) => s + r.x, 0) / racks.length
    partition = { z, minX, maxX, doorX }
    const t = PARTITION.t / 2
    obstacles.push({ minX, maxX: doorX - PARTITION.door / 2, minZ: z - t, maxZ: z + t })
    obstacles.push({ minX: doorX + PARTITION.door / 2, maxX, minZ: z - t, maxZ: z + t })
  }
  const r0 = racks[0]
  const c0 = cubicles[0]
  // Aim at the middle of what is mounted in rack 1 (devices stack from the top).
  const mounted = r0 ? placements.filter((p) => p.rack === r0.index) : []
  const lookY = mounted.length ? mounted.reduce((s, p) => s + p.panel.y, 0) / mounted.length : 1.2
  const home: RoomLayout['home'] = r0
    ? { x: r0.x, z: r0.z + 1.15, look: [r0.x, lookY, r0.z - 0.3], rack: r0.index }
    : c0
      ? { x: c0.x, z: c0.back + CUBE.d + 1.0, look: [c0.x, 0.9, c0.back + 0.3] }
      : { x: midX, z: front - 1.2, look: [midX, 1.2, front - 6] }
  return {
    placements,
    racks,
    cubicles,
    partition,
    home,
    obstacles,
    bounds: { minX, maxX, minZ: back, maxZ: front },
    spawn: { x: midX, z: front - 1.2 },
  }
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
  if (!rackHasRoom([...target, deviceId].map((id) => panelHeight(byId.get(id)!.type)))) return `Rack ${rack + 1} is full`
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

/** Moves a circle of radius r from (x, z) by (dx, dz), sliding along walls and furniture. */
export function collide(layout: RoomLayout, x: number, z: number, dx: number, dz: number, r = 0.3): { x: number; z: number } {
  const blocked = (px: number, pz: number) => {
    const b = layout.bounds
    if (px - r < b.minX || px + r > b.maxX || pz - r < b.minZ || pz + r > b.maxZ) return true
    return layout.obstacles.some((o) => px + r > o.minX && px - r < o.maxX && pz + r > o.minZ && pz - r < o.maxZ)
  }
  let nx = x
  let nz = z
  if (!blocked(x + dx, z)) nx = x + dx
  if (!blocked(nx, z + dz)) nz = z + dz
  return { x: nx, z: nz }
}
