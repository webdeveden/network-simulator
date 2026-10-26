import { describe, expect, it } from 'vitest'
import { addDevice, connectPorts, emptyTopology } from '../engine/network'
import { cablePlaces } from './places'

describe('cable places', () => {
  it('lists racks, desks with their PC and IP phone, printers and APs by room', () => {
    const t = emptyTopology()
    const sw = addDevice(t, 'switch')
    const r = addDevice(t, 'router')
    const pc = addDevice(t, 'pc')
    pc.room = 'sales'
    const tel = addDevice(t, 'phone')
    tel.deskOf = pc.id
    const pc2 = addDevice(t, 'pc')
    pc2.room = 'sales'
    const prn = addDevice(t, 'printer')
    prn.room = 'sales'
    const ap = addDevice(t, 'ap')
    ap.room = 'sales'
    const lt = addDevice(t, 'laptop')
    lt.room = 'sales'
    connectPorts(t, pc.id, 'eth0', tel.id, 'pc')

    const groups = cablePlaces(t, sw.id)
    const server = groups.find((g) => g.id === 'server')!
    expect(server.places[0]).toMatchObject({ kind: 'rack', label: 'Rack 1' })
    // The cable's own device is left out; the router is still there.
    expect(server.places[0].items.map((i) => i.name)).toEqual([r.name])
    const sales = groups.find((g) => g.id === 'sales')!
    expect(sales.places.map((p) => p.label)).toEqual([`${pc.name}'s desk`, `${pc2.name}'s desk`, `Printer ${prn.name}`, `${ap.name} (ceiling AP)`])
    const desk = sales.places[0]
    expect(desk.items.map((i) => i.name)).toEqual([pc.name, tel.name])
    // eth0 is cabled to the phone: one of the PC's two ports is free (com1).
    expect(desk.items[0]).toMatchObject({ free: 1, total: 2 })
    // Wireless-only laptops take no cable.
    expect(sales.places.flatMap((p) => p.items).some((i) => i.type === 'laptop')).toBe(false)
  })

  it('puts the ISP outside the building', () => {
    const t = emptyTopology()
    addDevice(t, 'isp')
    expect(cablePlaces(t).at(-1)).toMatchObject({ id: 'outside', places: [{ kind: 'outside' }] })
  })
})
