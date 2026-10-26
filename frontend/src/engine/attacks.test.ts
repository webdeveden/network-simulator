import { describe, expect, it } from 'vitest'
import { ATTACKS } from './attacks'
import { emptySimState } from './forwarding'
import { buildTopology, connectPorts, type DeviceSpec } from './network'
import { newSession, runLine } from './shell'

/** Attacker + victim on SW1 (fa0/1, fa0/2), router uplink on g0/1 (VLAN 1). */
function lab() {
  const devices: DeviceSpec[] = [
    { type: 'attacker', name: 'KALI1', x: 0, y: 0, room: 'seclab' },
    { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.0.0.10/24' }, gateway: '10.0.0.1' },
    { type: 'switch', name: 'SW1', x: 0, y: 0 },
    { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.0.1/24' } },
  ]
  const t = buildTopology({ devices }, false)
  const id = (n: string) => t.devices.find((d) => d.name === n)!.id
  connectPorts(t, id('KALI1'), 'eth0', id('SW1'), 'fa0/1')
  connectPorts(t, id('PC1'), 'eth0', id('SW1'), 'fa0/2')
  connectPorts(t, id('R1'), 'g0/0', id('SW1'), 'g0/1')
  const attacker = () => t.devices.find((d) => d.name === 'KALI1')!
  const kali = (line: string) => {
    const s = newSession(id('KALI1'))
    return runLine(t, emptySimState(), s, line).lines.map((x) => x.text).join('\n')
  }
  const sw = (...lines: string[]) => {
    const s = newSession(id('SW1'))
    return ['enable', 'configure terminal', ...lines, 'end'].flatMap((l) => runLine(t, emptySimState(), s, l).lines.map((x) => x.text)).join('\n')
  }
  const run = (name: keyof typeof ATTACKS) => ATTACKS[name].run(t, attacker())
  return { t, id, kali, sw, run }
}

describe('simulated layer-2 attacks', () => {
  it('MAC flood succeeds on an open port, blocked by port security', () => {
    const l = lab()
    expect(l.run('mac-flood').success).toBe(true)
    l.sw('interface fa0/1', 'switchport mode access', 'switchport port-security')
    const r = l.run('mac-flood')
    expect(r.success).toBe(false)
    expect(r.lines.map((x) => x.text).join('\n')).toMatch(/BLOCKED.*port security/i)
  })

  it('ARP spoof succeeds until DAI is enabled on the VLAN', () => {
    const l = lab()
    expect(l.run('arp-spoof').success).toBe(true)
    l.sw('ip dhcp snooping', 'ip dhcp snooping vlan 1', 'ip arp inspection vlan 1', 'interface g0/1', 'ip dhcp snooping trust', 'ip arp inspection trust')
    expect(l.run('arp-spoof').success).toBe(false)
  })

  it('DHCP starvation and rogue DHCP are stopped by DHCP snooping', () => {
    const l = lab()
    expect(l.run('dhcp-starve').success).toBe(true)
    expect(l.run('rogue-dhcp').success).toBe(true)
    l.sw('ip dhcp snooping', 'ip dhcp snooping vlan 1', 'interface g0/1', 'ip dhcp snooping trust')
    expect(l.run('dhcp-starve').success).toBe(false)
    expect(l.run('rogue-dhcp').success).toBe(false)
  })

  it('rogue switch is stopped by BPDU guard on the access port', () => {
    const l = lab()
    expect(l.run('rogue-switch').success).toBe(true)
    l.sw('interface fa0/1', 'spanning-tree portfast', 'spanning-tree bpduguard enable')
    expect(l.run('rogue-switch').success).toBe(false)
  })

  it('VLAN hop works when the attacker VLAN is the trunk native, blocked when moved', () => {
    const l = lab()
    // Make g0/1 a trunk with native VLAN 1 (= attacker access VLAN) → hop works.
    l.sw('interface g0/1', 'switchport mode trunk')
    expect(l.run('vlan-hop').success).toBe(true)
    l.sw('vlan 999', 'interface g0/1', 'switchport trunk native vlan 999')
    expect(l.run('vlan-hop').success).toBe(false)
  })

  it('the Kali shell scans, lists attacks, and refuses unknown commands', () => {
    const l = lab()
    expect(l.kali('scan')).toMatch(/uplink switch : SW1 port fa0\/1[\s\S]*access VLAN   : 1/)
    expect(l.kali('help')).toMatch(/mac-flood[\s\S]*arp-spoof/)
    expect(l.kali('mac-flood')).toMatch(/CAM-table overflow/)
    expect(l.kali('rm -rf /')).toMatch(/command not found/)
  })
})

describe('DHCP snooping and Dynamic ARP Inspection commands', () => {
  it('appear in the running-config and show output', () => {
    const l = lab()
    const out = l.sw('ip dhcp snooping', 'ip dhcp snooping vlan 1,10', 'ip arp inspection vlan 1', 'interface g0/1', 'ip dhcp snooping trust', 'ip arp inspection trust')
    expect(out).not.toMatch(/Invalid input|Incomplete/)
    const s = newSession(l.id('SW1'))
    const runp = (line: string) => ['enable', line].flatMap((x) => runLine(l.t, emptySimState(), s, x).lines.map((y) => y.text)).join('\n')
    expect(runp('show running-config')).toMatch(/ip dhcp snooping\nip dhcp snooping vlan 1,10\nip arp inspection vlan 1/)
    expect(runp('show running-config')).toMatch(/interface GigabitEthernet0\/1[\s\S]*ip dhcp snooping trust\n ip arp inspection trust/)
    expect(runp('show ip dhcp snooping')).toMatch(/Switch DHCP snooping is enabled[\s\S]*GigabitEthernet0\/1\s+yes/)
    expect(runp('show ip arp inspection')).toMatch(/enabled on VLANs: 1[\s\S]*GigabitEthernet0\/1\s+Trusted/)
  })
})
