/** Shared by the cable dialogs: cable choices, port kinds and what a cable between two ports would be. */
import { CABLES, cableFor, copperFor, getDevice, isRadio, isVirtual, linkOn, peerOf, portKind, type PortKind } from '../../engine/network'
import type { CableChoice, CableType, Device, Topology } from '../../engine/types'

export const CABLE_CHOICES: { id: CableChoice; label: string; color: string }[] = [
  { id: 'auto', label: 'Auto', color: '#c9d6e8' },
  ...(Object.entries(CABLES) as [Exclude<CableChoice, 'auto'>, (typeof CABLES)['straight']][]).map(([id, c]) => ({ id, label: c.label, color: c.color })),
]

export const PORT_KIND: Record<PortKind, { label: string; color: string }> = {
  copper: { label: 'copper RJ45', color: '#22d3ee' },
  fiber: { label: 'fiber SFP', color: CABLES.fiber.color },
  console: { label: 'console', color: CABLES.console.color },
  radio: { label: 'radio', color: '#8892a6' },
  virtual: { label: 'virtual', color: '#8892a6' },
}

export interface Port {
  name: string
  kind: PortKind
  /** What it's plugged into, or null when free. */
  used: string | null
}

/** A device's cable ports, grouped for display (patch panels: front and rear). */
export function portGroups(topo: Topology, d: Device | undefined): { group: string; ports: Port[] }[] {
  if (!d) return []
  const list: Port[] = d.ifaces
    .filter((i) => !isVirtual(i.name) && !isRadio(i.name))
    .map((i) => {
      const l = linkOn(topo, d.id, i.name)
      const peer = l && peerOf(l, d.id, i.name)
      return { name: i.name, kind: portKind(d, i.name), used: peer ? `${getDevice(topo, peer.device)?.name ?? '?'} ${peer.iface}` : null }
    })
  if (d.type === 'patch')
    return [
      { group: 'front (patch cords to switches)', ports: list.filter((p) => !p.name.endsWith('r')) },
      { group: 'rear (cable runs from the offices)', ports: list.filter((p) => p.name.endsWith('r')) },
    ]
  const order: PortKind[] = ['copper', 'fiber', 'console']
  return order.map((k) => ({ group: PORT_KIND[k].label, ports: list.filter((p) => p.kind === k) })).filter((g) => g.ports.length)
}

/** What cable would be laid between two ports, or why it can't; with a warning for the wrong copper cable. */
export function cableVerdict(choice: CableChoice, a: Device, ai: string | undefined, b: Device, bi: string | undefined): { ok: boolean; text: string; warn?: string } {
  if (!ai || !bi) return { ok: false, text: `Pick a free port on ${!ai ? a.name : b.name}.` }
  const got = cableFor(choice, a, ai, b, bi)
  // cableFor returns a cable type, or why the cable can't go there.
  if (!(got in CABLES)) return { ok: false, text: got }
  const r = got as CableType
  const text = `${CABLES[r].label} cable, $${CABLES[r].cost}: ${a.name} ${ai} ↔ ${b.name} ${bi}`
  const copper = r === 'straight' || r === 'crossover'
  const needs = copper ? copperFor(a, b, ai, bi) : r
  const warn = copper && needs !== r ? `These two ports need a ${CABLES[needs].label.toLowerCase()} cable: with ${CABLES[r].label.toLowerCase()} the link stays down.` : undefined
  return { ok: true, text, warn }
}
