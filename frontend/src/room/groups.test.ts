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
