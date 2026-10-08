import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from './forwarding'
import { buildTopology, connect, connectPorts, linkActive, topologyCost } from './network'
import { newSession, promptOf, runLine } from './shell'
import type { CableChoice, Link, Topology } from './types'

const dev = (t: Topology, name: string) => t.devices.find((d) => d.name === name)!

function lab() {
  return buildTopology(
    {
      devices: [
        { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.0.0.1/24' } },
        { type: 'pc', name: 'PC2', x: 0, y: 0, ifaces: { eth0: '10.0.0.2/24' } },
        { type: 'switch', name: 'SW1', x: 0, y: 0 },
        { type: 'switch', name: 'SW2', x: 0, y: 0 },
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.0.254/24' } },
      ],
    },
    false,
  )
}

const cable = (t: Topology, a: string, b: string, choice: CableChoice) => connect(t, dev(t, a).id, dev(t, b).id, choice)

describe('cable types', () => {
  it('auto picks straight between unlike devices and crossover between like ones', () => {
    const t = lab()
    expect((cable(t, 'PC1', 'SW1', 'auto') as Link).cable).toBe('straight')
    expect((cable(t, 'SW1', 'SW2', 'auto') as Link).cable).toBe('crossover')
    expect((cable(t, 'PC2', 'R1', 'auto') as Link).cable).toBe('crossover')
  })

  it('a wrong straight/crossover plugs in but the link stays down, with the reason', () => {
    const t = lab()
    const l = cable(t, 'PC1', 'PC2', 'straight') as Link
    expect(l.cable).toBe('straight')
    expect(linkActive(t, l)).toBe(false)
    const r = ping(t, emptySimState(), dev(t, 'PC1').id, '10.0.0.2')
    expect(r.message).toMatch(/needs a crossover cable/)
    t.links = []
    cable(t, 'PC1', 'PC2', 'crossover')
    expect(ping(t, emptySimState(), dev(t, 'PC1').id, '10.0.0.2').success).toBe(true)
  })

  it('a switch needs straight-through to a PC', () => {
    const t = lab()
    const l = cable(t, 'PC1', 'SW1', 'crossover') as Link
    expect(linkActive(t, l)).toBe(false)
    const out = runLine(t, emptySimState(), newSession(dev(t, 'PC1').id), 'ifconfig').lines.map((x) => x.text).join('\n')
    expect(out).toMatch(/wrong cable[\s\S]*straight-through/)
  })

  it('fiber only fits fiber ports', () => {
    const t = lab()
    const up = cable(t, 'SW1', 'SW2', 'fiber') as Link
    expect(up.a.iface).toBe('g0/1')
    expect(linkActive(t, up)).toBe(true)
    expect(cable(t, 'PC1', 'SW1', 'fiber')).toMatch(/PC1 has no free fiber ports/)
    expect(connectPorts(t, dev(t, 'PC1').id, 'eth0', dev(t, 'SW1').id, 'g0/2', 'auto')).toMatch(/copper RJ45 port but SW1 g0\/2 is a fiber/)
    expect(topologyCost(t)).toBeGreaterThan(0)
  })

  it('a console cable opens the CLI from the PC, with no IP and no traffic', () => {
    const t = lab()
    const l = cable(t, 'PC1', 'R1', 'console') as Link
    expect(l.a.iface).toBe('com1')
    expect(l.b.iface).toBe('con0')
    expect(linkActive(t, l)).toBe(false) // carries no packets
    expect(cable(t, 'SW1', 'R1', 'console')).toMatch(/COM1/)

    const state = emptySimState()
    const s = newSession(dev(t, 'PC1').id)
    runLine(t, state, s, 'console')
    expect(promptOf(t, s).text).toBe('R1>')
    runLine(t, state, s, 'enable')
    expect(promptOf(t, s).text).toBe('R1#') // console access, not vty: no enable secret needed
    const bye = runLine(t, state, s, 'exit').lines[0].text
    expect(bye).toMatch(/Console session on COM1 closed/)
    expect(promptOf(t, s).text).toBe('PC1:~$')
  })

  it('PCs keep the one-NIC ip set shortcut despite the COM port', () => {
    const t = buildTopology({ devices: [{ type: 'pc', name: 'PC', x: 0, y: 0 }] })
    const out = runLine(t, emptySimState(), newSession(t.devices[0].id), 'ip set 192.168.0.5/24').lines[0].text
    expect(out).toMatch(/eth0 configured/)
  })
})
