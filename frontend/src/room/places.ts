/**
 * Where a cable can go, by location: each room's racks (devices in rack order), office
 * desks (a PC with the IP phone on its desk), printers and APs, and the ISP outside.
 * Used by the "choose where to connect" dialog in the 3D room.
 */
import { isOutside, isRadio, isVirtual, isWifiClient, linkOn } from '../engine/network'
import type { Device, DeviceType, Topology } from '../engine/types'
import { onDesk, roomColor, roomLabel, roomLayout, roomOf } from './layout'

export interface PlaceItem {
  deviceId: string
  name: string
  type: DeviceType
  /** Free cable ports / all cable ports. */
  free: number
  total: number
}

export interface Place {
  id: string
  label: string
  kind: 'rack' | 'desk' | 'printer' | 'ap' | 'outside'
  items: PlaceItem[]
}

export interface PlaceGroup {
  id: string
  label: string
  color: string
  places: Place[]
}

/** Natural order for names like PC2, PC10. */
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true })

function item(topo: Topology, d: Device): PlaceItem {
  const ports = d.ifaces.filter((i) => !isVirtual(i.name) && !isRadio(i.name))
  return { deviceId: d.id, name: d.name, type: d.type, total: ports.length, free: ports.filter((i) => !linkOn(topo, d.id, i.name)).length }
}

/** Every place a cable could be plugged in, grouped by room. `exclude`: the device the cable starts from. */
export function cablePlaces(topo: Topology, exclude?: string): PlaceGroup[] {
  const layout = roomLayout(topo)
  const usable = (d: Device | undefined): d is Device => !!d && d.id !== exclude && !isWifiClient(d)
  const dev = (id: string) => topo.devices.find((d) => d.id === id)
  const groups: PlaceGroup[] = []

  for (const room of layout.rooms) {
    const places: Place[] = []
    for (const rack of layout.racks.filter((r) => r.room === room.id)) {
      const items = rack.deviceIds.map(dev).filter(usable).map((d) => item(topo, d))
      if (items.length) places.push({ id: `rack:${rack.index}`, label: rack.kind === 'wall' ? `${rack.name} (wall rack)` : rack.name, kind: 'rack', items })
    }
    const here = topo.devices.filter((d) => usable(d) && onDesk(d) && roomOf(d, topo) === room.id)
    // Desks: a PC with the phones on its desk; a phone without a PC has a desk of its own.
    const deskPhones = (pc: Device) => here.filter((p) => p.type === 'phone' && p.deskOf === pc.id)
    for (const pc of here.filter((d) => d.type === 'pc').sort(byName))
      places.push({ id: `desk:${pc.id}`, label: `${pc.name}'s desk`, kind: 'desk', items: [pc, ...deskPhones(pc).sort(byName)].map((d) => item(topo, d)) })
    const placedPhones = new Set(here.filter((d) => d.type === 'pc').flatMap((pc) => deskPhones(pc).map((p) => p.id)))
    for (const ph of here.filter((d) => d.type === 'phone' && !placedPhones.has(d.id)).sort(byName))
      places.push({ id: `desk:${ph.id}`, label: `${ph.name}'s desk`, kind: 'desk', items: [item(topo, ph)] })
    for (const pr of here.filter((d) => d.type === 'printer').sort(byName)) places.push({ id: `printer:${pr.id}`, label: `Printer ${pr.name}`, kind: 'printer', items: [item(topo, pr)] })
    for (const ap of here.filter((d) => d.type === 'ap').sort(byName))
      places.push({ id: `ap:${ap.id}`, label: `${ap.name} (${room.kind === 'balcony' ? 'outside wall' : 'ceiling'} AP)`, kind: 'ap', items: [item(topo, ap)] })
    if (places.length) groups.push({ id: room.id, label: roomLabel(topo, room.id), color: roomColor(topo, room.id), places })
  }

  const outside = topo.devices.filter((d) => usable(d) && isOutside(d)).sort(byName)
  if (outside.length)
    groups.push({ id: 'outside', label: 'Outside the building', color: '#8892a6', places: outside.map((d) => ({ id: `out:${d.id}`, label: d.name, kind: 'outside' as const, items: [item(topo, d)] })) })
  return groups
}
