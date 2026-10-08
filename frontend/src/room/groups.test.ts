import { describe, expect, it } from 'vitest'
import { buildTopology } from '../engine/network'
import { groupAt, roomGroups, tidyByRoom } from './groups'
import { roomLabel } from './layout'

const topo = () =>
  buildTopology({
    devices: [
      { type: 'router', name: 'R1', x: 300, y: 40 },
      { type: 'switch', name: 'SW1', x: 300, y: 200 },
      { type: 'pc', name: 'PC1', x: 40, y: 200 },
      { type: 'pc', name: 'PC2', x: 600, y: 200, room: 'sales' },
    ],
  })

describe('room groups on the 2D map', () => {
  it('boxes each room around its devices, in building order', () => {
    const g = roomGroups(topo())
    expect(g.map((x) => [x.id, x.deviceIds.length])).toEqual([
      ['server', 2],
      ['it', 1],
      ['sales', 1],
    ])
    const server = g[0]
    expect(server.x).toBeLessThan(300)
    expect(server.y + server.h).toBeGreaterThan(290)
  })

  it('finds the room under a point, ignoring the dragged device', () => {
    const t = topo()
    expect(groupAt(t, 650, 240)?.id).toBe('sales')
    expect(groupAt(t, 650, 240, t.devices[3].id)).toBeUndefined()
  })

  it('uses custom room names everywhere', () => {
    const t = topo()
    t.rooms = { sales: { label: 'Sales – 2nd floor' } }
    expect(roomGroups(t).find((g) => g.id === 'sales')?.label).toBe('Sales – 2nd floor')
    expect(roomLabel(t, 'sales')).toBe('Sales – 2nd floor')
    t.rooms.sales.label = '  '
    expect(roomLabel(t, 'sales')).toBe('Sales')
  })

  it('tidies devices into non-overlapping room blocks', () => {
    const t = topo()
    tidyByRoom(t)
    const g = roomGroups(t)
    g.forEach((a, i) => g.slice(i + 1).forEach((b) => expect(a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true)))
  })
})

describe('placing new devices on the 2D map', () => {
  it('puts a new device inside its own room box, in a free cell', async () => {
    const { spotFor } = await import('./groups')
    const t = topo()
    tidyByRoom(t)
    const pc = { ...structuredClone(t.devices[2]), id: 'new', name: 'PC9', x: 9999, y: 9999 }
    t.devices.push(pc)
    const s = spotFor(t, 'new')!
    Object.assign(pc, s)
    const it = roomGroups(t).find((g) => g.id === 'it')!
    expect(s.x).toBeGreaterThanOrEqual(it.x)
    expect(s.x).toBeLessThan(it.x + it.w)
    expect(t.devices.filter((d) => d.id !== 'new').some((d) => Math.abs(d.x - s.x) < 70 && Math.abs(d.y - s.y) < 60)).toBe(false)
  })

  it('stacks new rack gear under its rack-mates', async () => {
    const { spotFor } = await import('./groups')
    const t = topo()
    tidyByRoom(t)
    const r1 = t.devices.find((d) => d.name === 'R1')!
    t.devices.push({ ...structuredClone(r1), id: 'r2', name: 'R2', x: 0, y: 0 })
    const s = spotFor(t, 'r2')!
    expect(s.x).toBe(t.devices.find((d) => d.name === 'SW1')!.x)
    expect(s.y).toBeGreaterThan(r1.y)
  })
})
