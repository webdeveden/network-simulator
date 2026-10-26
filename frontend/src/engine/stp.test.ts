import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from './forwarding'
import { buildTopology, connectPorts, type DeviceSpec } from './network'
import { newSession, runLine } from './shell'
import { spanningTree } from './stp'

/** Three switches in a triangle (a loop), PC1 on SW1 and PC3 on SW3. */
function triangle() {
  const devices: DeviceSpec[] = [
    { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.0.0.1/24' } },
    { type: 'pc', name: 'PC3', x: 0, y: 0, ifaces: { eth0: '10.0.0.3/24' } },
    { type: 'switch', name: 'SW1', x: 0, y: 0 },
    { type: 'switch', name: 'SW2', x: 0, y: 0 },
    { type: 'switch', name: 'SW3', x: 0, y: 0 },
  ]
  const t = buildTopology({ devices }, false)
  const dev = (n: string) => t.devices.find((d) => d.name === n)!
  // Fixed MACs so the election is predictable: SW1 has the lowest.
  dev('SW1').ifaces[0].mac = '00:00:00:00:00:01'
  dev('SW2').ifaces[0].mac = '00:00:00:00:00:02'
  dev('SW3').ifaces[0].mac = '00:00:00:00:00:03'
  for (const [a, ai, b, bi] of [['SW1', 'g0/3', 'SW2', 'g0/3'], ['SW2', 'g0/4', 'SW3', 'g0/4'], ['SW1', 'g0/5', 'SW3', 'g0/5'], ['PC1', 'eth0', 'SW1', 'fa0/1'], ['PC3', 'eth0', 'SW3', 'fa0/1']])
    connectPorts(t, dev(a).id, ai, dev(b).id, bi)
  const state = emptySimState()
  const on = (name: string, ...lines: string[]) => {
    const s = newSession(dev(name).id)
    return lines.flatMap((l) => runLine(t, state, s, l).lines.map((x) => x.text)).join('\n')
  }
  const cfg = (name: string, ...lines: string[]) => on(name, 'enable', 'configure terminal', ...lines, 'end')
  const blocked = () =>
    [...spanningTree(t, 1)!.switches.values()].flatMap((s) => s.ports.filter((p) => !p.forwarding).map((p) => `${s.name} ${p.port}`))
  return { t, state, dev, on, cfg, blocked }
}

describe('spanning tree', () => {
  it('elects the lowest bridge ID as root and blocks exactly one port of the loop', () => {
    const l = triangle()
    const tree = spanningTree(l.t, 1)!
    expect(tree.root.name).toBe('SW1')
    // SW2 and SW3 both reach the root directly; on their shared link, SW2 (lower ID) is designated.
    expect(l.blocked()).toEqual(['SW3 g0/4'])
    expect(l.on('SW1', 'show spanning-tree')).toMatch(/VLAN0001[\s\S]*This bridge is the root/)
    const sw3 = l.on('SW3', 'show spanning-tree')
    expect(sw3).toMatch(/Root ID\s+Priority\s+32769[\s\S]*Cost\s+4[\s\S]*Port\s+\d+ \(GigabitEthernet0\/5\)/)
    expect(sw3).toMatch(/Gi0\/4\s+Altn BLK 4/)
    expect(sw3).toMatch(/Gi0\/5\s+Root FWD 4/)
  })

  it('moves the root with priority, and traffic follows the tree', () => {
    const l = triangle()
    l.cfg('SW2', 'spanning-tree vlan 1 root primary')
    expect(spanningTree(l.t, 1)!.root.name).toBe('SW2')
    // Now SW1-SW3 is the redundant link and blocks: PC1 to PC3 goes through SW2.
    expect(l.blocked()).toEqual(['SW3 g0/5'])
    const r = ping(l.t, l.state, l.dev('PC1').id, '10.0.0.3')
    expect(r.success).toBe(true)
    expect(r.hops.filter((h) => !h.reply && h.action === 'switch').map((h) => h.deviceName)).toEqual(['SW1', 'SW2', 'SW3'])
  })

  it('reconverges when a forwarding link fails: the blocked port takes over', () => {
    const l = triangle()
    l.cfg('SW2', 'spanning-tree vlan 1 root primary')
    l.cfg('SW1', 'interface g0/3', 'shutdown')
    expect(l.blocked()).toEqual([])
    const r = ping(l.t, l.state, l.dev('PC1').id, '10.0.0.3')
    expect(r.success).toBe(true)
    expect(r.hops.filter((h) => !h.reply && h.action === 'switch').map((h) => h.deviceName)).toEqual(['SW1', 'SW3'])
  })

  it('checks priority steps of 4096 and shows the settings in the running-config', () => {
    const l = triangle()
    expect(l.cfg('SW3', 'spanning-tree vlan 1 priority 1000')).toMatch(/increments of 4096/)
    l.cfg('SW3', 'spanning-tree mode rapid-pvst', 'spanning-tree vlan 1 priority 4096', 'interface fa0/1', 'spanning-tree portfast', 'spanning-tree bpduguard enable')
    expect(spanningTree(l.t, 1)!.root.name).toBe('SW3')
    const cfgText = l.on('SW3', 'enable', 'show running-config')
    expect(cfgText).toMatch(/spanning-tree mode rapid-pvst\nspanning-tree vlan 1 priority 4096/)
    expect(cfgText).toMatch(/interface FastEthernet0\/1[\s\S]*spanning-tree portfast\n spanning-tree bpduguard enable/)
    expect(l.on('SW3', 'show spanning-tree')).toMatch(/protocol rstp[\s\S]*Fa0\/1\s+Desg FWD 19\s+128\.\d+\s+P2p Edge/)
  })

  it('BPDU guard err-disables a port when a switch is plugged in', () => {
    const l = triangle()
    l.cfg('SW1', 'interface fa0/2', 'spanning-tree portfast', 'spanning-tree bpduguard enable')
    connectPorts(l.t, l.dev('SW1').id, 'fa0/2', l.dev('SW2').id, 'fa0/2')
    expect(l.dev('SW1').ifaces.find((i) => i.name === 'fa0/2')!.errDisabled).toBe('bpduguard')
    // Turning it on with a switch already attached trips it right away.
    expect(l.cfg('SW1', 'interface g0/3', 'spanning-tree bpduguard enable')).toMatch(/%SPANTREE-2-BLOCK_BPDUGUARD/)
  })
})