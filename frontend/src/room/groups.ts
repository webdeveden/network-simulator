/**
 * Rooms on the 2D map: a labelled box around the devices in each room of the 3D
 * building, plus "tidy by room", which lays devices out in room blocks. Pure, so
 * it can be tested; positions are 2D canvas pixels.
 */
import { isOutside } from '../engine/network'
import type { Topology } from '../engine/types'
import { onDesk, roomColor, roomLabel, roomLayout, roomOf, roomsOf, type RoomId, type RoomKind } from './layout'

/** Size of a device box on the 2D map (DeviceNode is w-24, about 90px tall). */
export const NODE = { w: 96, h: 90 }
const PAD = 22
const HEADER = 26

export interface RoomGroup {
  id: RoomId
  label: string
  color: string
  kind: RoomKind
  deviceIds: string[]
  x: number
  y: number
  w: number
  h: number
}

/** Empty racks have no devices to draw a box around: they get their own spot. */
export interface EmptyRack {
  index: number
  name: string
  room: RoomId
  x: number
  y: number
}

/**
 * Where each empty rack sits on the 2D map: its saved spot, or (older networks)
 * just right of whatever is already in its room.
 */
export function emptyRacks(topo: Topology): EmptyRack[] {
  const racks = roomLayout(topo).racks.filter((r) => !r.deviceIds.length)
  let fallbackX = Math.max(40, ...topo.devices.filter((d) => !isOutside(d)).map((d) => d.x + NODE.w + 80))
  return racks.map((r) => {
    const saved = topo.rackPos?.[r.index]
    const spot = saved ?? { x: fallbackX, y: 80 }
    if (!saved) fallbackX += NODE.w + 60
    return { index: r.index, name: r.name, room: r.room, ...spot }
  })
}

/** One box per room that has devices or racks, around them, in building order. */
export function roomGroups(topo: Topology, exclude?: string): RoomGroup[] {
  const empties = emptyRacks(topo)
  return roomsOf(topo).flatMap((r) => {
    const members = topo.devices.filter((d) => d.id !== exclude && !isOutside(d) && roomOf(d, topo) === r.id)
    // Empty racks count as one device-sized spot each.
    const spots = [...members, ...empties.filter((e) => e.room === r.id)]
    if (!spots.length) return []
    const x0 = Math.min(...spots.map((d) => d.x)) - PAD
    const y0 = Math.min(...spots.map((d) => d.y)) - PAD - HEADER
    const x1 = Math.max(...spots.map((d) => d.x + NODE.w)) + PAD
    const y1 = Math.max(...spots.map((d) => d.y + NODE.h)) + PAD
    // Wide enough for the header (name, count, edit button) even around a single device.
    const w = Math.max(x1 - x0, 200)
    return [{ id: r.id, label: roomLabel(topo, r.id), color: roomColor(topo, r.id), kind: r.kind, deviceIds: members.map((d) => d.id), x: x0, y: y0, w, h: y1 - y0 }]
  })
}

/** The room box a point falls in (ignoring `exclude`, the device being dragged). */
export function groupAt(topo: Topology, x: number, y: number, exclude?: string): RoomGroup | undefined {
  return roomGroups(topo, exclude).find((g) => x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h)
}

/** A rack inside a room box: which devices share it, in rack order. */
export interface RackGroup {
  index: number
  name: string
  room: RoomId
  deviceIds: string[]
  x: number
  y: number
  w: number
  h: number
  empty?: boolean
}

/** One small box per rack, around its devices on the 2D map (empty racks at their own spot). */
export function rackGroups(topo: Topology): RackGroup[] {
  const pos = new Map(topo.devices.map((d) => [d.id, d]))
  return roomLayout(topo).racks.flatMap((r) => {
    const members = r.deviceIds.map((id) => pos.get(id)!).filter(Boolean)
    if (!members.length) return []
    const x0 = Math.min(...members.map((d) => d.x)) - 10
    const y0 = Math.min(...members.map((d) => d.y)) - 22
    const x1 = Math.max(...members.map((d) => d.x + NODE.w)) + 10
    const y1 = Math.max(...members.map((d) => d.y + NODE.h)) + 10
    return [{ index: r.index, name: r.name, room: r.room, deviceIds: r.deviceIds, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }]
  }).concat(
    emptyRacks(topo).map((e) => ({ index: e.index, name: e.name, room: e.room, deviceIds: [], x: e.x - 10, y: e.y - 22, w: NODE.w + 20, h: NODE.h + 32, empty: true })),
  )
}

/** The rack box a point falls in, if any. */
export function rackAt2d(topo: Topology, x: number, y: number): RackGroup | undefined {
  return rackGroups(topo).find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/** A free 2D spot for a new rack: right of what's in its room, or right of everything. */
export function newRackSpot(topo: Topology, room: RoomId): { x: number; y: number } {
  const g = roomGroups(topo).find((x) => x.id === room)
  if (g) return { x: g.x + g.w + 20 - 22, y: g.y + 26 + 22 }
  const all = roomGroups(topo)
  return { x: Math.max(40, ...all.map((x) => x.x + x.w + 90 - 22)), y: 80 }
}

/**
 * Lays devices out in room blocks, left to right in building order, so boxes never
 * overlap. Inside a room each rack is a column, top to bottom in rack order (like
 * the real rack); desk devices follow in a grid.
 */
export function tidyByRoom(topo: Topology) {
  const COLS = 3
  const GAP = { x: 130, y: 120, room: 90 }
  const racks = roomLayout(topo).racks
  let x = 40
  for (const r of roomsOf(topo)) {
    const start = x
    for (const rack of racks.filter((k) => k.room === r.id)) {
      rack.deviceIds.forEach((id, k) => {
        const d = topo.devices.find((x) => x.id === id)!
        d.x = x
        d.y = 80 + k * GAP.y
      })
      if (!rack.deviceIds.length) topo.rackPos = { ...topo.rackPos, [rack.index]: { x, y: 80 } }
      x += GAP.x
    }
    const desks = topo.devices.filter((d) => onDesk(d) && !isOutside(d) && roomOf(d, topo) === r.id)
    desks.forEach((d, k) => {
      d.x = x + (k % COLS) * GAP.x
      d.y = 80 + Math.floor(k / COLS) * GAP.y
    })
    if (desks.length) x += Math.min(COLS, desks.length) * GAP.x
    if (x > start) x += GAP.room
  }
  // The ISP floats above the building, top-left.
  for (const d of topo.devices.filter(isOutside)) {
    d.x = 40
    d.y = -160
  }
}

/**
 * Where a newly added device should go on the 2D map, so it lands inside its own
 * room box instead of stretching it: under the other devices of its rack, next to
 * its PC (desk phones), or in the first free cell of its room's grid. A room with
 * nothing in it yet starts to the right of everything else.
 */
export function spotFor(topo: Topology, deviceId: string): { x: number; y: number } | null {
  const d = topo.devices.find((x) => x.id === deviceId)
  if (!d || isOutside(d)) return null
  const others = topo.devices.filter((x) => x.id !== d.id && !isOutside(x))
  const taken = (x: number, y: number) => others.some((o) => Math.abs(o.x - x) < 70 && Math.abs(o.y - y) < 60)

  const rack = roomLayout(topo).racks.find((r) => r.deviceIds.includes(d.id))
  if (rack) {
    const mates = rack.deviceIds.filter((id) => id !== d.id).map((id) => others.find((o) => o.id === id)!).filter(Boolean)
    if (!mates.length) return topo.rackPos?.[rack.index] ?? rightOfEverything(topo, d.id)
    const x = mates[0].x
    let y = Math.max(...mates.map((m) => m.y)) + 120
    while (taken(x, y)) y += 120
    return { x, y }
  }

  const host = d.deskOf ? others.find((o) => o.id === d.deskOf) : undefined
  if (host && !taken(host.x + 120, host.y)) return { x: host.x + 120, y: host.y }

  const room = roomOf(d, topo)
  const mates = others.filter((o) => roomOf(o, topo) === room)
  if (!mates.length) return rightOfEverything(topo, d.id)
  const x0 = Math.min(...mates.map((m) => m.x))
  const y0 = Math.min(...mates.map((m) => m.y))
  for (let k = 0; k < 90; k++) {
    const x = x0 + (k % 3) * 130
    const y = y0 + Math.floor(k / 3) * 120
    if (!taken(x, y)) return { x, y }
  }
  return { x: x0, y: y0 }
}

function rightOfEverything(topo: Topology, exclude: string): { x: number; y: number } {
  const boxes = roomGroups(topo, exclude)
  return { x: Math.max(40, ...boxes.map((g) => g.x + g.w + 90 - 22)), y: 80 }
}
