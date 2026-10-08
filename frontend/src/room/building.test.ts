import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from '../engine/forwarding'
import { buildTopology, connect } from '../engine/network'
import type { Link, Topology } from '../engine/types'
import { roomGroups } from './groups'
import { collide, deskRoomsFor, roomAt, roomLayout, roomOf } from './layout'

const dev = (t: Topology, n: string) => t.devices.find((d) => d.name === n)!

const office = () =>
  buildTopology(
    {
      devices: [
        { type: 'switch', name: 'SW1', x: 0, y: 0 },
        { type: 'pc', name: 'PC1', x: 0, y: 0 },
        { type: 'phone', name: 'TEL1', x: 0, y: 0 },
        { type: 'printer', name: 'PRN1', x: 0, y: 0 },
        { type: 'ap', name: 'AP-OUT', x: 0, y: 0 },
        { type: 'laptop', name: 'LT1', x: 0, y: 0 },
      ],
    },
    false,
  )

describe('office equipment', () => {
  it('puts the phone on its PC desk and the printer by the door', () => {
    const t = office()
    dev(t, 'TEL1').deskOf = dev(t, 'PC1').id
    const l = roomLayout(t)
    const pc = l.placements.find((p) => p.deviceId === dev(t, 'PC1').id)!
    const tel = l.placements.find((p) => p.deviceId === dev(t, 'TEL1').id)!
    const prn = l.placements.find((p) => p.deviceId === dev(t, 'PRN1').id)!
    expect(tel.station).toBe('phone')
    expect(tel.z).toBe(pc.z)
    expect(tel.x).toBeGreaterThan(pc.x)
    expect(l.cubicles.map((c) => c.deviceId)).not.toContain(dev(t, 'TEL1').id)
    expect(prn.station).toBe('printer')
    expect(roomAt(l, prn.x, prn.z - 0.1)?.id).toBe('it')
    expect(roomOf(dev(t, 'TEL1'), t)).toBe('it')
  })
})

describe('balcony and custom rooms', () => {
  it('adds a balcony off the corridor, with seats, an AP and a laptop out there', () => {
    const t = office()
    t.customRooms = [{ id: 'room-b', label: 'Terrace', kind: 'balcony' }]
    dev(t, 'AP-OUT').room = 'room-b'
    dev(t, 'LT1').room = 'room-b'
    const l = roomLayout(t)
    const b = l.rooms.find((r) => r.id === 'room-b')!
    expect(b.z0).toBeCloseTo(l.corridor.maxZ)
    expect(l.bounds.maxZ).toBeGreaterThan(b.z1 - 0.01)
    expect(l.seats.length).toBeGreaterThan(1)
    const lt = l.placements.find((x) => x.deviceId === dev(t, 'LT1').id)!
    expect(lt.station).toBe('lounge')
    expect(roomAt(l, lt.x, lt.z - 0.1)?.id).toBe('room-b')
    // The AP is on the building's outside wall, above head height, facing the balcony.
    const ap = l.placements.find((x) => x.deviceId === dev(t, 'AP-OUT').id)!
    expect(ap.station).toBe('wall')
    expect(ap.panel.y).toBeGreaterThan(2)
    expect(ap.z).toBeGreaterThan(l.corridor.maxZ)
    // Walk from the corridor out through the balcony door.
    let p = { x: b.doorX, z: l.corridor.maxZ - 0.8 }
    for (let k = 0; k < 20; k++) p = collide(l, p.x, p.z, 0, 0.1)
    expect(roomAt(l, p.x, p.z)?.id).toBe('room-b')
    expect(roomGroups(t).find((g) => g.id === 'room-b')?.deviceIds).toHaveLength(2)
  })

  it('only wireless gear goes on a balcony; PCs stay in offices', () => {
    const t = office()
    t.customRooms = [{ id: 'room-b', label: 'Terrace', kind: 'balcony' }]
    expect(deskRoomsFor(t, 'ap').map((r) => r.id)).toContain('room-b')
    expect(deskRoomsFor(t, 'pc').map((r) => r.id)).not.toContain('room-b')
    dev(t, 'PC1').room = 'room-b'
    expect(roomOf(dev(t, 'PC1'), t)).toBe('it')
  })

  it('adds a new office at the east end without moving the others', () => {
    const t = office()
    const before = roomLayout(t).rooms.map((r) => [r.id, r.x0])
    t.customRooms = [{ id: 'room-m', label: 'Marketing', kind: 'office' }]
    dev(t, 'PC1').room = 'room-m'
    const l = roomLayout(t)
    expect(l.rooms.slice(0, before.length).map((r) => [r.id, r.x0])).toEqual(before)
    const m = l.rooms.find((r) => r.id === 'room-m')!
    expect(m.x0).toBeCloseTo(l.rooms[before.length - 1].x1)
    const pc = l.placements.find((p) => p.deviceId === dev(t, 'PC1').id)!
    expect(roomAt(l, pc.x, pc.z - 0.1)?.id).toBe('room-m')
  })
})

describe('ONT / modem', () => {
  it('bridges the ISP fiber to the edge router, so 8.8.8.8 answers', () => {
    const t = buildTopology(
      {
        devices: [
          { type: 'isp', name: 'ISP', x: 0, y: 0, ifaces: { 'pon0': '203.0.113.1/30' } },
          { type: 'modem', name: 'ONT', x: 0, y: 0 },
          { type: 'router', name: 'EDGE', x: 0, y: 0, ifaces: { 'g0/0': '203.0.113.2/30' } },
        ],
      },
      false,
    )
    const fiber = connect(t, dev(t, 'ISP').id, dev(t, 'ONT').id) as Link
    expect(fiber.cable).toBe('fiber')
    expect([fiber.a.iface, fiber.b.iface].sort()).toEqual(['pon', 'pon0'])
    const lan = connect(t, dev(t, 'ONT').id, dev(t, 'EDGE').id) as Link
    expect(lan.cable).toBe('straight')
    expect(ping(t, emptySimState(), dev(t, 'EDGE').id, '8.8.8.8').success).toBe(false) // no route yet
    dev(t, 'EDGE').routes.push({ network: '0.0.0.0', prefix: 0, via: '203.0.113.1' })
    expect(ping(t, emptySimState(), dev(t, 'EDGE').id, '8.8.8.8').success).toBe(true)
  })
})

describe('IP phone built-in switch', () => {
  const desk = () =>
    buildTopology(
      {
        devices: [
          { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.0.0.10/24' } },
          { type: 'phone', name: 'TEL1', x: 0, y: 0, ifaces: { eth0: '10.0.0.20/24' } },
          { type: 'switch', name: 'SW1', x: 0, y: 0 },
          { type: 'server', name: 'SRV', x: 0, y: 0, ifaces: { eth0: '10.0.0.100/24' } },
        ],
      },
      false,
    )

  it('passes the PC through to the network, and both PC and phone are reachable', () => {
    const t = desk()
    const [pc, tel, sw, srv] = t.devices
    const a = connect(t, pc.id, tel.id) as Link // PC -> phone pc port
    const b = connect(t, tel.id, sw.id) as Link // phone eth0 -> switch
    connect(t, srv.id, sw.id)
    expect([a.a.iface, a.b.iface]).toContain('pc')
    expect(a.cable).toBe('straight')
    expect([b.a.iface, b.b.iface]).toContain('eth0')
    expect(b.cable).toBe('straight')
    const s = emptySimState()
    expect(ping(t, s, pc.id, '10.0.0.100').success).toBe(true)
    expect(ping(t, s, srv.id, '10.0.0.20').success).toBe(true)
    expect(ping(t, s, srv.id, '10.0.0.10').success).toBe(true)
    expect(ping(t, s, tel.id, '10.0.0.10').success).toBe(true) // phone to its own PC
  })

  it('refuses an IP on the pass-through port', async () => {
    const { setIfaceIp } = await import('../engine/network')
    const t = desk()
    expect(setIfaceIp(t.devices[1], 'pc', '10.0.0.5/24')).toMatch(/pass-through/)
  })
})

describe('ceiling APs and deleting rooms', () => {
  it('hangs office APs from the ceiling, not in a cubicle', () => {
    const t = office()
    const l = roomLayout(t)
    const ap = l.placements.find((x) => x.deviceId === dev(t, 'AP-OUT').id)!
    expect(ap.station).toBe('ceiling')
    expect(ap.panel.y).toBeGreaterThan(2.7)
    expect(l.cubicles.map((c) => c.deviceId)).not.toContain(dev(t, 'AP-OUT').id)
  })

  it('a deleted room disappears and its devices fall back to another office', () => {
    const t = office()
    t.removedRooms = ['it']
    const l = roomLayout(t)
    expect(l.rooms.map((r) => r.id)).not.toContain('it')
    expect(roomOf(dev(t, 'PC1'), t)).toBe('accounting')
  })
})
