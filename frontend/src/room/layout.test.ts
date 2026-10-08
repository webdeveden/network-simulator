import { describe, expect, it } from 'vitest'
import { addDevice, buildTopology, connectPorts, linkOn } from '../engine/network'
import { collide, portSpots, RACK, roomLayout } from './layout'

const topo = () =>
  buildTopology({
    devices: [
      { type: 'pc', name: 'PC1', x: 0, y: 0 },
      { type: 'pc', name: 'PC2', x: 0, y: 0 },
      { type: 'switch', name: 'SW1', x: 0, y: 0 },
      { type: 'router', name: 'R1', x: 0, y: 0 },
      { type: 'server', name: 'SRV', x: 0, y: 0 },
    ],
  })

const overlaps = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: typeof a) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ

describe('room layout', () => {
  it('racks network gear and servers, puts PCs on desks', () => {
    const t = topo()
    const l = roomLayout(t)
    const station = (n: string) => l.placements.find((p) => p.deviceId === t.devices.find((d) => d.name === n)!.id)!.station
    expect(['SW1', 'R1', 'SRV'].map(station)).toEqual(['rack', 'rack', 'rack'])
    expect(['PC1', 'PC2'].map(station)).toEqual(['desk', 'desk'])
  })

  it('never overlaps furniture and keeps it inside the room', () => {
    const t = buildTopology({ devices: Array.from({ length: 20 }, (_, k) => ({ type: k % 3 ? 'router' : 'pc', name: `D${k}`, x: 0, y: 0 }) as const) })
    const l = roomLayout(t)
    l.obstacles.forEach((a, i) => l.obstacles.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)))
    for (const o of l.obstacles) {
      expect(o.minX).toBeGreaterThan(l.bounds.minX)
      expect(o.maxX).toBeLessThan(l.bounds.maxX)
      expect(o.minZ).toBeGreaterThan(l.bounds.minZ)
      expect(o.maxZ).toBeLessThan(l.bounds.maxZ)
    }
    expect(new Set(l.racks.map((r) => r.z)).size).toBe(Math.ceil(l.racks.length / RACK.perRow))
  })

  it('stacks routers and switches in the same rack, top to bottom', () => {
    const t = topo()
    const l = roomLayout(t)
    const sw = l.placements.find((p) => p.deviceId === t.devices[2].id)!
    const r1 = l.placements.find((p) => p.deviceId === t.devices[3].id)!
    expect(sw.rack).toBe(0)
    expect(r1.rack).toBe(0)
    expect(sw.panel.y).toBeGreaterThan(r1.panel.y)
    expect(sw.panel.y - sw.panel.h / 2).toBeGreaterThan(r1.panel.y + r1.panel.h / 2)
    expect(l.racks).toHaveLength(1)
  })

  it('opens a new rack only when one is full', () => {
    const t = buildTopology({ devices: Array.from({ length: 12 }, (_, k) => ({ type: 'router', name: `R${k}`, x: 0, y: 0 }) as const) })
    const l = roomLayout(t)
    expect(l.racks.length).toBeGreaterThan(1)
    for (const p of l.placements) expect(p.panel.y - p.panel.h / 2).toBeGreaterThanOrEqual(0.5)
  })

  it('honours a preferred rack', () => {
    const t = topo()
    t.devices[4].rack = 2
    const l = roomLayout(t)
    expect(l.placements.find((p) => p.deviceId === t.devices[4].id)!.rack).toBe(2)
  })

  it('adding a device never moves the existing ones', () => {
    const t = topo()
    const before = roomLayout(t).placements
    addDevice(t, 'router')
    addDevice(t, 'pc')
    const after = roomLayout(t).placements
    for (const p of before) expect(after.find((q) => q.deviceId === p.deviceId)).toEqual(p)
  })

  it('spawns the player in free space', () => {
    const l = roomLayout(topo())
    expect(collide(l, l.spawn.x, l.spawn.z, 0, 0)).toEqual(l.spawn)
  })

  it('stops the player at a rack and slides along it', () => {
    const l = roomLayout(topo())
    const rack = l.obstacles[0]
    const x = (rack.minX + rack.maxX) / 2
    const p = collide(l, x, rack.maxZ + 0.5, 0.1, -1)
    expect(p.z).toBeCloseTo(rack.maxZ + 0.5)
    expect(p.x).toBeCloseTo(x + 0.1)
  })

  it('lays switch ports out in two rows, inside the panel', () => {
    const t = topo()
    const sw = t.devices.find((d) => d.type === 'switch')!
    const spots = portSpots(sw)
    expect(new Set(spots.map((s) => s.y)).size).toBe(2)
    for (const s of spots) expect(Math.abs(s.x)).toBeLessThan(0.22)
  })
})

describe('connectPorts', () => {
  it('cables exactly the chosen ports and refuses busy ones', () => {
    const t = topo()
    const [pc1, pc2, sw] = t.devices
    const l = connectPorts(t, pc1.id, 'eth0', sw.id, 'fa0/5')
    expect(typeof l).not.toBe('string')
    expect(linkOn(t, sw.id, 'fa0/5')).toBeDefined()
    expect(connectPorts(t, pc2.id, 'eth0', sw.id, 'fa0/5')).toMatch(/already has a cable/)
    expect(connectPorts(t, pc2.id, 'eth0', sw.id, 'fa0/9')).toMatch(/Unknown port/)
  })
})
