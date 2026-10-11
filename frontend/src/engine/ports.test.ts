import { describe, expect, it } from 'vitest'
import { emptySimState } from './forwarding'
import { addDevice, connectPorts, emptyTopology, suggestPorts, upgradeTopology } from './network'
import { newSession, runLine } from './shell'

describe('older saved devices', () => {
  it('get the ports added since, keeping existing ports, cables and subinterfaces', () => {
    const t = emptyTopology()
    const r = addDevice(t, 'router')
    const sw = addDevice(t, 'switch')
    // A router and switch saved before fiber uplinks existed.
    r.ifaces = r.ifaces.filter((i) => i.name !== 'g0/4')
    sw.ifaces = sw.ifaces.filter((i) => i.name !== 'g0/1' && i.name !== 'g0/2')
    r.ifaces.splice(1, 0, { name: 'g0/0.10', mac: r.ifaces[0].mac, vlan: 10, ip: '10.10.0.1', prefix: 24 })
    const mac = r.ifaces[0].mac
    connectPorts(t, r.id, 'g0/0', sw.id, 'fa0/1')
    upgradeTopology(t)
    expect(r.ifaces.map((i) => i.name)).toEqual(['g0/0', 'g0/0.10', 'g0/1', 'g0/2', 'g0/3', 'g0/4', 'g0/5', 'con0'])
    expect(r.ifaces[0].mac).toBe(mac)
    expect(sw.ifaces.map((i) => i.name).slice(48)).toEqual(['g0/1', 'g0/2', 'g0/3', 'g0/4', 'g0/5', 'g0/6', 'con0'])
    expect(t.links).toHaveLength(1)
  })
})

describe('port suggestions', () => {
  it('suggests copper by default, fiber for fiber cables, console ports for console', () => {
    const t = emptyTopology()
    const a = addDevice(t, 'switch')
    const b = addDevice(t, 'switch')
    const pc = addDevice(t, 'pc')
    expect(suggestPorts(t, a, b, 'auto')).toEqual(['fa0/1', 'fa0/1'])
    expect(suggestPorts(t, a, b, 'fiber')).toEqual(['g0/1', 'g0/1'])
    expect(suggestPorts(t, pc, a, 'console')).toEqual(['com1', 'con0'])
  })
})

describe('media type in the IOS console', () => {
  it('tells fiber (SFP) from copper (RJ45)', () => {
    const t = emptyTopology()
    const sw = addDevice(t, 'switch')
    const s = newSession(sw.id)
    const run = (l: string) => runLine(t, emptySimState(), s, l).lines.map((x) => x.text).join('\n')
    const status = run('show interfaces status')
    expect(status).toMatch(/Fa0\/1\s+notconnect\s+1\s+auto\s+auto\s+10\/100BaseTX/)
    expect(status).toMatch(/Gi0\/1\s+notconnect\s+1\s+auto\s+auto\s+1000BaseSX SFP \(fiber\)/)
    expect(run('show interfaces g0/1')).toMatch(/Hardware is Gigabit Ethernet SFP \(fiber\)[\s\S]*media type is 1000BaseSX/)
    expect(run('show interfaces fa0/1')).toMatch(/media type is RJ45/)
    // Copper gigabit ports next to the fiber uplinks.
    expect(status).toMatch(/Fa0\/48\s+notconnect\s+1\s+auto\s+auto\s+10\/100BaseTX/)
    expect(status).toMatch(/Gi0\/3\s+notconnect\s+1\s+auto\s+auto\s+10\/100\/1000BaseTX/)
  })
})
