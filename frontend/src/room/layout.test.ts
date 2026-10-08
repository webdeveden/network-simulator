import { describe, expect, it } from 'vitest'
import { addDevice, buildTopology, connectPorts, linkOn } from '../engine/network'
import { collide, CUBE, moveDeviceInRack, PARTITION, portSpots, RACK, roomLayout } from './layout'

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
    // Furniture never overlaps. (Thin wall panels meet at cubicle corners; that's fine.)
    const solid = l.obstacles.filter((o) => o.maxX - o.minX > 0.1 && o.maxZ - o.minZ > 0.1)
    solid.forEach((a, i) => solid.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)))
    for (const o of l.obstacles) {
      expect(o.minX).toBeGreaterThanOrEqual(l.bounds.minX)
      expect(o.maxX).toBeLessThanOrEqual(l.bounds.maxX)
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

  it('puts every desk in its own cubicle, in the office in front of the glass', () => {
    const t = topo()
    const l = roomLayout(t)
    expect(l.cubicles.map((c) => c.deviceId)).toEqual([t.devices[0].id, t.devices[1].id])
    expect(l.partition).toBeDefined()
    for (const c of l.cubicles) expect(c.back).toBeGreaterThan(l.partition!.z)
    for (const r of l.racks) expect(r.z).toBeLessThan(l.partition!.z)
    // Only the last cubicle in a row draws its right wall; neighbours share walls.
    expect(l.cubicles.map((c) => c.rightWall)).toEqual([false, true])
    expect(l.cubicles[1].x - l.cubicles[0].x).toBeCloseTo(CUBE.w)
  })

  it('lets you walk through the doorway but not the glass', () => {
    const l = roomLayout(topo())
    const pt = l.partition!
    const before = pt.z + 0.6
    // Walk in game-sized steps (at most 0.2 m per frame).
    const walk = (x: number) => {
      let p = { x, z: before }
      for (let k = 0; k < 12; k++) p = collide(l, p.x, p.z, 0, -0.1)
      return p
    }
    expect(walk(pt.doorX).z).toBeCloseTo(before - 1.2)
    expect(walk(pt.doorX + PARTITION.door / 2 + 0.8).z).toBeGreaterThan(pt.z)
  })

  it('rearranges devices inside a rack and between racks', () => {
    const t = topo()
    const [, , sw, r1, srv] = t.devices
    const order = (k: number) => roomLayout(t).racks.find((r) => r.index === k)?.deviceIds
    expect(order(0)).toEqual([sw.id, r1.id, srv.id])
    expect(moveDeviceInRack(t, srv.id, 0, 0)).toBeNull()
    expect(order(0)).toEqual([srv.id, sw.id, r1.id])
    expect(moveDeviceInRack(t, sw.id, 1, 0)).toBeNull()
    expect(order(0)).toEqual([srv.id, r1.id])
    expect(order(1)).toEqual([sw.id])
    // New devices still go into the first rack with room, without disturbing the order.
    const r2 = addDevice(t, 'router')
    expect(order(0)).toEqual([srv.id, r1.id, r2.id])
    expect(moveDeviceInRack(t, t.devices[0].id, 0, 0)).toMatch(/Only rack-mounted/)
  })

  it('refuses to overfill a rack', () => {
    const t = buildTopology({ devices: Array.from({ length: 12 }, (_, k) => ({ type: 'server', name: `S${k}`, x: 0, y: 0 }) as const) })
    const l = roomLayout(t)
    const inRack1 = l.racks[1].deviceIds[0]
    expect(moveDeviceInRack(t, inRack1, 0, 0)).toMatch(/Rack 1 is full/)
  })

  it('spawns the player in free space', () => {
    const l = roomLayout(topo())
    expect(collide(l, l.spawn.x, l.spawn.z, 0, 0)).toEqual(l.spawn)
  })

  it.each([
    ['racks', topo()],
    ['only desks', buildTopology({ devices: [{ type: 'pc', name: 'PC1', x: 0, y: 0 }] })],
    ['empty room', buildTopology({ devices: [] })],
  ])('starts close to the gear in free space (%s)', (_, t) => {
    const l = roomLayout(t)
    const free = (x: number, z: number) => collide(l, x - 0.01, z, 0.01, 0).x === x
    expect(free(l.home.x, l.home.z)).toBe(true)
    if (l.racks.length) {
      expect(l.home.rack).toBe(0)
      expect(l.home.z - l.racks[0].z).toBeLessThan(1.5)
      expect(l.home.z).toBeLessThan(l.partition?.z ?? Infinity)
      // Looks at the mounted devices, not the empty part of the rack.
      const ys = l.placements.filter((p) => p.rack === 0).map((p) => p.panel.y)
      expect(l.home.look[1]).toBeGreaterThanOrEqual(Math.min(...ys))
      expect(l.home.look[1]).toBeLessThanOrEqual(Math.max(...ys))
    }
  })

  it('stops the player at a rack and slides along it', () => {
    const l = roomLayout(topo())
    const rack = l.obstacles[0]
    const x = (rack.minX + rack.maxX) / 2
    const p = collide(l, x, rack.maxZ + 0.5, 0.1, -1)
    expect(p.z).toBeCloseTo(rack.maxZ + 0.5)
    expect(p.x).toBeCloseTo(x + 0.1)
  })

  it.each(['switch', 'router', 'firewall'] as const)('lays out %s ports inside the panel without overlaps', (type) => {
    const t = buildTopology({ devices: [{ type, name: 'X', x: 0, y: 0 }] })
    const d = t.devices[0]
    const spots = portSpots(d)
    // Every cabled port has a spot (radios have none).
    expect(spots.map((s) => s.iface).sort()).toEqual(d.ifaces.map((i) => i.name).filter((n) => n !== 'd0').sort())
    const p = roomLayout(t).placements[0].panel
    for (const s of spots) {
      expect(Math.abs(s.x) + 0.02).toBeLessThanOrEqual(p.w / 2)
      expect(Math.abs(s.y) + 0.014).toBeLessThanOrEqual(p.h / 2 + 0.005)
    }
    spots.forEach((a, i) =>
      spots.slice(i + 1).forEach((b) => expect(Math.abs(a.x - b.x) >= 0.035 || Math.abs(a.y - b.y) >= 0.03, `${a.iface}/${b.iface}`).toBe(true)),
    )
    if (type === 'switch') {
      const network = spots.filter((s) => s.iface !== 'con0')
      expect(new Set(network.map((s) => s.y)).size).toBe(2)
    }
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
