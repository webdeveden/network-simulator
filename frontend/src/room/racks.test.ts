import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from '../engine/forwarding'
import { buildTopology, connect, connectPorts, linkOn } from '../engine/network'
import { newSession, runLine } from '../engine/shell'
import type { Link, Topology } from '../engine/types'
import { rackGroups, roomGroups, tidyByRoom } from './groups'
import { moveDeviceInRack, roomAt, roomLayout, roomOf, WALL_RACK, WALL_RACK_BASE } from './layout'

const dev = (t: Topology, n: string) => t.devices.find((d) => d.name === n)!

describe('patch panel', () => {
  const lab = () =>
    buildTopology(
      {
        devices: [
          { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.0.0.1/24' } },
          { type: 'pc', name: 'PC2', x: 0, y: 0, ifaces: { eth0: '10.0.0.2/24' } },
          { type: 'patch', name: 'PP1', x: 0, y: 0 },
          { type: 'switch', name: 'SW1', x: 0, y: 0 },
        ],
      },
      false,
    )

  it('passes traffic straight through front N <-> rear N, and only that pair', () => {
    const t = lab()
    const [pc1, pc2, pp, sw] = t.devices
    connectPorts(t, pc1.id, 'eth0', pp.id, 'p1r', 'straight')
    connectPorts(t, pp.id, 'p1', sw.id, 'fa0/1', 'straight')
    connectPorts(t, pc2.id, 'eth0', pp.id, 'p2r', 'straight')
    connectPorts(t, pp.id, 'p3', sw.id, 'fa0/2', 'straight') // wrong front port: p2 isn't patched
    expect(ping(t, emptySimState(), pc1.id, '10.0.0.2').success).toBe(false)
    t.links = t.links.filter((l) => !(l.a.device === pp.id && l.a.iface === 'p3'))
    connectPorts(t, pp.id, 'p2', sw.id, 'fa0/2', 'straight')
    expect(ping(t, emptySimState(), pc1.id, '10.0.0.2').success).toBe(true)
  })

  it('auto cabling puts office PCs on the rear and the switch on the front of the same port', () => {
    const t = lab()
    const [pc1, , pp, sw] = t.devices
    const a = connect(t, pc1.id, pp.id) as Link
    const b = connect(t, sw.id, pp.id) as Link
    expect(a.b.iface).toBe('p1r')
    expect(b.b.iface).toBe('p1')
    expect(linkOn(t, pp.id, 'p1')).toBeDefined()
  })

  it('has no console', () => {
    const t = lab()
    const out = runLine(t, emptySimState(), newSession(dev(t, 'PP1').id), 'show run').lines[0].text
    expect(out).toMatch(/passive/)
  })
})

describe('ISP', () => {
  it('stands for the Internet: 8.8.8.8 answers once routes exist, and it stays outside the building', () => {
    const t = buildTopology(
      {
        devices: [
          { type: 'pc', name: 'PC', x: 0, y: 0, ifaces: { eth0: '192.168.1.10/24' }, gateway: '192.168.1.1' },
          { type: 'router', name: 'EDGE', x: 0, y: 0, ifaces: { 'g0/0': '192.168.1.1/24', 'g0/1': '203.0.113.2/30' } },
          { type: 'isp', name: 'ISP', x: 0, y: 0, ifaces: { 'g0/0': '203.0.113.1/30' } },
        ],
        links: [['PC', 'EDGE'], ['EDGE', 'ISP']],
      },
      false,
    )
    const s = emptySimState()
    expect(ping(t, s, dev(t, 'PC').id, '8.8.8.8').success).toBe(false)
    dev(t, 'EDGE').routes.push({ network: '0.0.0.0', prefix: 0, via: '203.0.113.1' })
    dev(t, 'ISP').routes.push({ network: '192.168.1.0', prefix: 24, via: '203.0.113.2' })
    expect(ping(t, s, dev(t, 'PC').id, '8.8.8.8').success).toBe(true)
    expect(roomLayout(t).placements.some((p) => p.deviceId === dev(t, 'ISP').id)).toBe(false)
    expect(roomGroups(t).flatMap((g) => g.deviceIds)).not.toContain(dev(t, 'ISP').id)
  })
})

describe('racks', () => {
  const site = () => {
    const t = buildTopology(
      {
        devices: [
          { type: 'router', name: 'R1', x: 0, y: 0 },
          { type: 'switch', name: 'SW-ACC', x: 0, y: 0 },
          { type: 'patch', name: 'PP-ACC', x: 0, y: 0 },
          { type: 'pc', name: 'PC1', x: 0, y: 0, room: 'accounting' },
        ],
      },
      false,
    )
    t.wallRacks = [{ id: WALL_RACK_BASE, room: 'accounting', name: 'IDF-A' }]
    dev(t, 'SW-ACC').rack = WALL_RACK_BASE
    dev(t, 'PP-ACC').rack = WALL_RACK_BASE
    return t
  }

  it('hangs wall racks on their office wall at chest height', () => {
    const t = site()
    const l = roomLayout(t)
    const idf = l.racks.find((r) => r.index === WALL_RACK_BASE)!
    expect(idf.kind).toBe('wall')
    expect(roomAt(l, idf.x, idf.z - 0.1)?.id).toBe('accounting')
    expect(idf.deviceIds).toEqual([dev(t, 'SW-ACC').id, dev(t, 'PP-ACC').id])
    for (const p of l.placements.filter((x) => x.rack === WALL_RACK_BASE)) {
      expect(p.panel.y).toBeGreaterThan(WALL_RACK.bottom)
      expect(p.panel.y).toBeLessThan(WALL_RACK.bottom + WALL_RACK.h)
    }
    expect(roomOf(dev(t, 'SW-ACC'), t)).toBe('accounting')
    expect(roomGroups(t).find((g) => g.id === 'accounting')?.deviceIds).toHaveLength(3)
  })

  it('a wall rack fills up quickly; extra devices spill to the server room', () => {
    const t = site()
    for (let k = 0; k < 4; k++) {
      t.devices.push({ ...structuredClone(dev(t, 'R1')), id: `x${k}`, name: `RX${k}`, rack: WALL_RACK_BASE })
    }
    const l = roomLayout(t)
    const inWall = l.racks.find((r) => r.index === WALL_RACK_BASE)!.deviceIds.length
    expect(inWall).toBeLessThan(6)
    expect(l.racks.find((r) => r.index === 0)!.deviceIds.length).toBeGreaterThan(1)
    expect(moveDeviceInRack(t, 'x3', WALL_RACK_BASE, 0)).toMatch(/IDF-A is full/)
  })

  it('keeps empty floor racks you added', () => {
    const t = site()
    t.serverRacks = 3
    expect(roomLayout(t).racks.filter((r) => r.kind === 'floor')).toHaveLength(3)
  })

  it('tidies racks into columns in rack order, and shows them as boxes', () => {
    const t = site()
    tidyByRoom(t)
    const [sw, pp] = [dev(t, 'SW-ACC'), dev(t, 'PP-ACC')]
    expect(sw.x).toBe(pp.x)
    expect(pp.y).toBeGreaterThan(sw.y)
    expect(rackGroups(t).map((r) => r.name)).toEqual(['Rack 1', 'IDF-A'])
  })
})

describe('empty racks on the 2D map', () => {
  it('shows an empty wall rack in its room, even when the room has no devices yet', () => {
    const t = buildTopology({ devices: [{ type: 'pc', name: 'PC1', x: 40, y: 80 }] }, false)
    t.wallRacks = [{ id: WALL_RACK_BASE, room: 'sales', name: 'IDF-S' }]
    t.rackPos = { [WALL_RACK_BASE]: { x: 600, y: 80 } }
    const rack = rackGroups(t).find((r) => r.index === WALL_RACK_BASE)!
    expect(rack.empty).toBe(true)
    expect(rack.x).toBeLessThan(600)
    const sales = roomGroups(t).find((g) => g.id === 'sales')!
    expect(sales.x).toBeLessThan(600)
    expect(sales.x + sales.w).toBeGreaterThan(600)
  })

  it('places an empty rack without a saved spot right of the map', () => {
    const t = buildTopology({ devices: [{ type: 'pc', name: 'PC1', x: 40, y: 80 }] }, false)
    t.serverRacks = 2
    const racks = rackGroups(t).filter((r) => r.empty)
    expect(racks).toHaveLength(2)
    expect(racks[1].x).toBeGreaterThan(racks[0].x)
  })
})
