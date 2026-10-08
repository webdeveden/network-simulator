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

export interface RoomLayout {
  placements: Placement[]
  racks: RackSpot[]
  obstacles: Box2[]
  bounds: Box2
  spawn: { x: number; z: number }
}

export const RACK = { w: 0.6, h: 2.0, d: 0.9, gap: 0.12, perRow: 7, rowPitch: 2.8 }
export const DESK = { w: 1.2, h: 0.75, d: 0.7, gap: 0.3 }
/** Height of the overhead cable tray. */
export const TRAY_Y = 2.35
/** Mounting zone inside a rack: devices stack down from the top. */
const MOUNT_TOP = 1.84
const MOUNT_BOTTOM = 0.5
const MOUNT_GAP = 0.035
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

  // Stack rack devices top-down in device order. A device goes into its preferred
  // rack (d.rack, set when dropped onto one) if it fits, otherwise into the first
  // rack with room. Appending a device never moves the ones already placed.
  const fill: number[] = [] // used height per rack
  const racks: RackSpot[] = []
  const fits = (k: number, h: number) => MOUNT_TOP - (fill[k] ?? 0) - h >= MOUNT_BOTTOM
  for (const d of racked) {
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

  const deskZ = racks.length ? 2.4 : 0
  const deskPitch = DESK.w + DESK.gap
  const perRow = 6
  desked.forEach((d, k) => {
    const x = (k % perRow) * deskPitch
    const z = deskZ + Math.floor(k / perRow) * 2.2
    const p = PANEL[d.type]
    // A PC tower stands on the left of the desk next to its monitor; laptops and APs sit in the middle.
    const px = d.type === 'pc' ? x - DESK.w / 2 + 0.2 : x
    const pz = d.type === 'laptop' ? z - 0.2 : z - 0.12
    placements.push({ deviceId: d.id, station: 'desk', x, z, panel: { x: px, y: DESK.h + p.h / 2, z: pz, ...p }, ports: portSpots(d) })
    obstacles.push({ minX: x - DESK.w / 2, maxX: x + DESK.w / 2, minZ: z - DESK.d, maxZ: z })
  })

  const xs = obstacles.flatMap((o) => [o.minX, o.maxX])
  const zs = obstacles.flatMap((o) => [o.minZ, o.maxZ])
  const minX = Math.min(-2, ...xs) - 2
  const maxX = Math.max(2, ...xs) + 2
  const front = Math.max(2, ...zs) + 3.5
  const back = Math.min(-2, ...zs) - 1.5
  const midX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
  return {
    placements,
    racks,
    obstacles,
    bounds: { minX, maxX, minZ: back, maxZ: front },
    spawn: { x: midX, z: front - 1.2 },
  }
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
