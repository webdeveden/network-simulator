import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from './forwarding'
import { buildTopology, connectPorts, type DeviceSpec } from './network'
import { newSession, runLine } from './shell'
import type { Topology } from './types'

function lab(devices: DeviceSpec[], cables: [string, string, string, string][]) {
  const topo: Topology = buildTopology({ devices }, false)
  for (const [a, ai, b, bi] of cables) {
    const da = topo.devices.find((d) => d.name === a)!
    const db = topo.devices.find((d) => d.name === b)!
    const l = connectPorts(topo, da.id, ai, db.id, bi)
    if (typeof l === 'string') throw new Error(l)
  }
  const state = emptySimState()
  const dev = (n: string) => topo.devices.find((d) => d.name === n)!
  /** Runs commands on a device (IOS ones start from enable + conf t if `cfg`). */
  const on = (name: string, ...lines: string[]) => {
    const s = newSession(dev(name).id)
    return lines.flatMap((l) => runLine(topo, state, s, l).lines.map((x) => x.text)).join('\n')
  }
  const cfg = (name: string, ...lines: string[]) => on(name, 'enable', 'configure terminal', ...lines, 'end')
  const reach = (from: string, ip: string) => ping(topo, state, dev(from).id, ip)
  return { topo, state, dev, on, cfg, reach }
}

const pc = (name: string, cidr?: string, gateway?: string): DeviceSpec => ({ type: 'pc', name, x: 0, y: 0, ...(cidr ? { ifaces: { eth0: cidr } } : {}), ...(gateway ? { gateway } : {}) })

describe('VLANs and trunks', () => {
  function vlanLab() {
    return lab(
      [pc('PC1', '192.168.10.10/24'), pc('PC2', '192.168.10.11/24'), { type: 'switch', name: 'SW1', x: 0, y: 0 }],
      [
        ['PC1', 'eth0', 'SW1', 'fa0/1'],
        ['PC2', 'eth0', 'SW1', 'fa0/2'],
      ],
    )
  }

  it('separates access ports in different VLANs', () => {
    const t = vlanLab()
    expect(t.reach('PC1', '192.168.10.11').success).toBe(true)
    const out = t.cfg('SW1', 'vlan 10', 'name SALES', 'vlan 20', 'int fa0/1', 'switchport mode access', 'switchport access vlan 10', 'int fa0/2', 'switchport access vlan 20')
    expect(out).not.toMatch(/Invalid/)
    expect(t.reach('PC1', '192.168.10.11').success).toBe(false)
    t.cfg('SW1', 'int fa0/2', 'switchport access vlan 10')
    expect(t.reach('PC1', '192.168.10.11').success).toBe(true)
    expect(t.on('SW1', 'show vlan brief')).toMatch(/10\s+SALES\s+active\s+Fa0\/1, Fa0\/2/)
  })

  it('creates a missing access VLAN like IOS', () => {
    const t = vlanLab()
    expect(t.cfg('SW1', 'int fa0/1', 'switchport access vlan 30')).toMatch(/Creating vlan 30/)
    expect(t.dev('SW1').ios?.vlans?.[30]).toBe('VLAN0030')
  })

  it('applies a command to an interface range', () => {
    const t = vlanLab()
    t.cfg('SW1', 'vlan 10', 'interface range fa0/1 - 2', 'switchport mode access', 'switchport access vlan 10')
    expect(t.dev('SW1').ifaces.filter((i) => i.switchport?.vlan === 10).map((i) => i.name)).toEqual(['fa0/1', 'fa0/2'])
  })

  it('routes between VLANs with a router on a stick, across a trunk between two switches', () => {
    const t = lab(
      [
        pc('PC1', '192.168.10.10/24', '192.168.10.1'),
        pc('PC2', '192.168.20.10/24', '192.168.20.1'),
        { type: 'switch', name: 'SW1', x: 0, y: 0 },
        { type: 'switch', name: 'SW2', x: 0, y: 0 },
        { type: 'router', name: 'R1', x: 0, y: 0 },
      ],
      [
        ['PC1', 'eth0', 'SW1', 'fa0/1'],
        ['PC2', 'eth0', 'SW2', 'fa0/1'],
        ['SW1', 'fa0/8', 'SW2', 'fa0/8'],
        ['R1', 'g0/0', 'SW1', 'fa0/7'],
      ],
    )
    t.cfg('SW1', 'vlan 10', 'vlan 20', 'int fa0/1', 'switchport access vlan 10', 'int fa0/7', 'switchport mode trunk', 'int fa0/8', 'switchport mode trunk')
    t.cfg('SW2', 'vlan 20', 'int fa0/1', 'switchport access vlan 20', 'int fa0/8', 'switchport mode trunk')
    t.cfg('R1', 'int g0/0', 'no shutdown', 'int g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0')
    const r = t.reach('PC1', '192.168.20.10')
    expect(r.message).toMatch(/Reply/)
    expect(r.hops.some((h) => /VLAN 20/.test(h.detail))).toBe(true)
    expect(t.on('R1', 'show ip route')).toMatch(/C\s+192\.168\.20\.0\/24 is directly connected, GigabitEthernet0\/0\.20/)
    expect(t.on('SW1', 'show interfaces trunk')).toMatch(/Fa0\/7\s+on\s+802\.1q\s+trunking\s+1/)
    // A transit switch must know the VLAN: without vlan 10 on SW2 nothing changes here,
    // but removing VLAN 20 from SW2 cuts PC2 off.
    t.cfg('SW2', 'no vlan 20')
    expect(t.reach('PC1', '192.168.20.10').success).toBe(false)
  })

  it('drops VLANs a trunk does not allow', () => {
    const t = lab(
      [pc('PC1', '10.0.0.1/24'), pc('PC2', '10.0.0.2/24'), { type: 'switch', name: 'SW1', x: 0, y: 0 }, { type: 'switch', name: 'SW2', x: 0, y: 0 }],
      [
        ['PC1', 'eth0', 'SW1', 'fa0/1'],
        ['PC2', 'eth0', 'SW2', 'fa0/1'],
        ['SW1', 'g0/1', 'SW2', 'g0/1'],
      ],
    )
    for (const sw of ['SW1', 'SW2']) t.cfg(sw, 'vlan 10', 'int fa0/1', 'switchport access vlan 10', 'int g0/1', 'switchport mode trunk')
    expect(t.reach('PC1', '10.0.0.2').success).toBe(true)
    t.cfg('SW1', 'int g0/1', 'switchport trunk allowed vlan 1,20')
    expect(t.reach('PC1', '10.0.0.2').success).toBe(false)
    t.cfg('SW1', 'int g0/1', 'switchport trunk allowed vlan add 10')
    expect(t.reach('PC1', '10.0.0.2').success).toBe(true)
  })

  it('gives a switch a management address on a VLAN interface', () => {
    const t = lab(
      [pc('PC1', '10.0.0.10/24', '10.0.0.1'), { type: 'switch', name: 'SW1', x: 0, y: 0 }],
      [['PC1', 'eth0', 'SW1', 'fa0/1']],
    )
    expect(t.cfg('SW1', 'int fa0/1', 'ip address 10.0.0.2 255.255.255.0')).toMatch(/Layer 2 switchport/)
    t.cfg('SW1', 'interface vlan 1', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 10.0.0.1')
    expect(t.reach('PC1', '10.0.0.2').success).toBe(true)
    expect(t.on('SW1', 'ping 10.0.0.10')).toMatch(/Success rate is 80 percent|!!!!!/)
    expect(t.on('SW1', 'enable', 'show running-config')).toMatch(/interface Vlan1\n ip address 10\.0\.0\.2 255\.255\.255\.0[\s\S]*ip default-gateway 10\.0\.0\.1/)
  })
})

/** PC1 - R1 - R2 - R3 - PC3, with /30 links between the routers. */
function chain() {
  return lab(
    [
      pc('PC1', '10.1.0.10/24', '10.1.0.1'),
      pc('PC3', '10.3.0.10/24', '10.3.0.1'),
      { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.1.0.1/24', 'g0/1': '10.12.0.1/30' } },
      { type: 'router', name: 'R2', x: 0, y: 0, ifaces: { 'g0/0': '10.12.0.2/30', 'g0/1': '10.23.0.1/30' } },
      { type: 'router', name: 'R3', x: 0, y: 0, ifaces: { 'g0/0': '10.23.0.2/30', 'g0/1': '10.3.0.1/24' } },
    ],
    [
      ['PC1', 'eth0', 'R1', 'g0/0'],
      ['R1', 'g0/1', 'R2', 'g0/0'],
      ['R2', 'g0/1', 'R3', 'g0/0'],
      ['R3', 'g0/1', 'PC3', 'eth0'],
    ],
  )
}

describe('dynamic routing', () => {
  it('OSPF: neighbors form and routes are learned end to end', () => {
    const t = chain()
    expect(t.reach('PC1', '10.3.0.10').success).toBe(false)
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
    expect(t.reach('PC1', '10.3.0.10').message).toMatch(/Reply/)
    expect(t.on('R1', 'show ip route')).toMatch(/O\s+10\.3\.0\.0\/24 \[110\/3\] via 10\.12\.0\.2/)
    expect(t.on('R2', 'show ip ospf neighbor')).toMatch(/FULL/)
    expect(t.on('R1', 'enable', 'show running-config')).toMatch(/router ospf 1\n network 10\.0\.0\.0 0\.255\.255\.255 area 0/)
  })

  it('OSPF: an area mismatch is explained and blocks the adjacency', () => {
    const t = chain()
    t.cfg('R1', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
    t.cfg('R2', 'router ospf 1', 'network 10.12.0.0 0.0.0.3 area 1', 'network 10.23.0.0 0.0.0.3 area 0')
    expect(t.on('R1', 'show ip ospf neighbor')).toMatch(/area mismatch/)
    expect(t.on('R1', 'show ip route')).not.toMatch(/^O/m)
  })

  it('OSPF: passive interfaces advertise but form no neighbors; default-information originate', () => {
    const t = chain()
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
    t.cfg('R1', 'router ospf 1', 'passive-interface g0/0')
    expect(t.reach('PC1', '10.3.0.10').success).toBe(true)
    t.cfg('R3', 'ip route 0.0.0.0 0.0.0.0 10.3.0.10', 'router ospf 1', 'default-information originate')
    expect(t.on('R1', 'show ip route')).toMatch(/O E2\*\s+0\.0\.0\.0\/0 \[110\/20\] via 10\.12\.0\.2/)
    expect(t.on('R1', 'show ip route')).toMatch(/Gateway of last resort is 10\.12\.0\.2/)
  })

  it('EIGRP: learns routes, AS must match', () => {
    const t = chain()
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router eigrp 100', 'network 10.0.0.0')
    expect(t.reach('PC1', '10.3.0.10').success).toBe(true)
    expect(t.on('R1', 'show ip route')).toMatch(/D\s+10\.3\.0\.0\/24 \[90\/\d+\] via 10\.12\.0\.2/)
    t.cfg('R3', 'no router eigrp 100', 'router eigrp 200', 'network 10.0.0.0')
    expect(t.reach('PC1', '10.3.0.10').success).toBe(false)
    expect(t.on('R2', 'show ip eigrp neighbors')).toMatch(/AS mismatch: 100 vs 200/)
  })

  it('RIP: hop counts', () => {
    const t = chain()
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0')
    expect(t.reach('PC1', '10.3.0.10').success).toBe(true)
    expect(t.on('R1', 'show ip route')).toMatch(/R\s+10\.3\.0\.0\/24 \[120\/2\] via 10\.12\.0\.2/)
  })

  it('prefers the lower administrative distance: static over OSPF', () => {
    const t = chain()
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
    t.cfg('R1', 'ip route 10.3.0.0 255.255.255.0 10.12.0.2')
    const table = t.on('R1', 'show ip route')
    expect(table).toMatch(/S\s+10\.3\.0\.0\/24 \[1\/0\] via 10\.12\.0\.2/)
    expect(table).not.toMatch(/O\s+10\.3\.0\.0/)
  })

  it('BGP: eBGP with the ISP, advertising the office network and learning the Internet', () => {
    const t = lab(
      [
        pc('PC1', '192.168.1.10/24', '192.168.1.1'),
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '192.168.1.1/24', 'g0/1': '203.0.113.2/30' } },
        { type: 'isp', name: 'ISP1', x: 0, y: 0, ifaces: { 'g0/0': '203.0.113.1/30' } },
      ],
      [
        ['PC1', 'eth0', 'R1', 'g0/0'],
        ['R1', 'g0/1', 'ISP1', 'g0/0'],
      ],
    )
    expect(t.reach('PC1', '8.8.8.8').success).toBe(false)
    t.cfg('R1', 'router bgp 65001', 'neighbor 203.0.113.1 remote-as 65000', 'network 192.168.1.0 mask 255.255.255.0')
    expect(t.on('R1', 'show ip bgp summary')).toMatch(/203\.0\.113\.1\s+4\s+65000.*Active/)
    t.cfg('ISP1', 'router bgp 65000', 'neighbor 203.0.113.2 remote-as 65001', 'network 8.8.8.8 mask 255.255.255.255')
    expect(t.on('R1', 'show ip bgp summary')).toMatch(/203\.0\.113\.1\s+4\s+65000.*\s1$/m)
    expect(t.on('R1', 'show ip route')).toMatch(/B\s+8\.8\.8\.8\/32 \[20\/0\] via 203\.0\.113\.1/)
    expect(t.on('ISP1', 'show ip bgp')).toMatch(/192\.168\.1\.0\/24\s+203\.0\.113\.2.*65001 i/)
    expect(t.reach('PC1', '8.8.8.8').message).toMatch(/Reply/)
  })
})

describe('DHCP', () => {
  it('a router pool hands out address and gateway, skipping excluded addresses', () => {
    const t = lab(
      [pc('PC1'), pc('PC2'), { type: 'switch', name: 'SW1', x: 0, y: 0 }, { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '192.168.1.1/24' } }],
      [
        ['PC1', 'eth0', 'SW1', 'fa0/1'],
        ['PC2', 'eth0', 'SW1', 'fa0/2'],
        ['R1', 'g0/0', 'SW1', 'fa0/8'],
      ],
    )
    expect(t.on('PC1', 'dhcp')).toMatch(/No DHCPOFFERS received[\s\S]*no DHCP pool/)
    t.cfg('R1', 'ip dhcp excluded-address 192.168.1.1 192.168.1.10', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 8.8.8.8')
    expect(t.on('PC1', 'dhcp')).toMatch(/DHCPACK: eth0 bound to 192\.168\.1\.11\/24, gateway 192\.168\.1\.1/)
    expect(t.on('PC2', 'ipconfig /renew')).toMatch(/192\.168\.1\.12/)
    expect(t.dev('PC1').gateway).toBe('192.168.1.1')
    expect(t.reach('PC1', '192.168.1.12').success).toBe(true)
    expect(t.on('R1', 'show ip dhcp binding')).toMatch(/192\.168\.1\.11[\s\S]*PC1/)
    // Renewing keeps the same address.
    expect(t.on('PC1', 'dhcp')).toMatch(/192\.168\.1\.11/)
    expect(t.on('PC1', 'dhcp release')).toMatch(/DHCPRELEASE of 192\.168\.1\.11/)
    expect(t.dev('PC1').ifaces[0].ip).toBeUndefined()
  })

  it('relays with ip helper-address to a server on another subnet', () => {
    const t = lab(
      [
        pc('PC1'),
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.0.1/30' } },
        { type: 'router', name: 'R2', x: 0, y: 0, ifaces: { 'g0/0': '10.0.0.2/30', 'g0/1': '172.16.5.1/24' } },
      ],
      [
        ['R1', 'g0/0', 'R2', 'g0/0'],
        ['R2', 'g0/1', 'PC1', 'eth0'],
      ],
    )
    t.cfg('R1', 'ip route 172.16.5.0 255.255.255.0 10.0.0.2', 'ip dhcp pool BRANCH', 'network 172.16.5.0 255.255.255.0', 'default-router 172.16.5.1')
    expect(t.on('PC1', 'dhcp')).toMatch(/no ip helper-address/)
    t.cfg('R2', 'int g0/1', 'ip helper-address 10.0.0.1')
    const out = t.on('PC1', 'dhcp')
    expect(out).toMatch(/relayed by R2 g0\/1 \(giaddr 172\.16\.5\.1\) to 10\.0\.0\.1/)
    expect(out).toMatch(/bound to 172\.16\.5\.2\/24, gateway 172\.16\.5\.1/)
    expect(t.reach('PC1', '10.0.0.1').success).toBe(true)
  })

  it('a router interface can be a DHCP client and installs the default route', () => {
    const t = lab(
      [
        { type: 'router', name: 'R1', x: 0, y: 0 },
        { type: 'isp', name: 'ISP1', x: 0, y: 0, ifaces: { 'g0/0': '203.0.113.1/24' } },
      ],
      [['R1', 'g0/1', 'ISP1', 'g0/0']],
    )
    t.cfg('ISP1', 'ip dhcp pool CUSTOMERS', 'network 203.0.113.0 255.255.255.0', 'default-router 203.0.113.1')
    expect(t.cfg('R1', 'int g0/1', 'ip address dhcp')).toMatch(/%DHCP-6-ADDRESS_ASSIGN: Interface GigabitEthernet0\/1 assigned DHCP address 203\.0\.113\.2/)
    expect(t.on('R1', 'show ip route')).toMatch(/S\*\s+0\.0\.0\.0\/0 \[254\/0\] via 203\.0\.113\.1/)
    expect(t.reach('R1', '8.8.8.8').success).toBe(true)
    expect(t.on('R1', 'show ip int brief')).toMatch(/GigabitEthernet0\/1\s+203\.0\.113\.2\s+YES DHCP/)
  })
})

describe('NAT', () => {
  function natLab() {
    return lab(
      [
        pc('PC1', '192.168.1.10/24', '192.168.1.1'),
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '192.168.1.1/24', 'g0/1': '203.0.113.2/30' } },
        { type: 'isp', name: 'ISP1', x: 0, y: 0, ifaces: { 'g0/0': '203.0.113.1/30' } },
      ],
      [
        ['PC1', 'eth0', 'R1', 'g0/0'],
        ['R1', 'g0/1', 'ISP1', 'g0/0'],
      ],
    )
  }

  it('PAT lets private hosts reach the Internet, and replies find their way back', () => {
    const t = natLab()
    t.cfg('R1', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1')
    // The ISP has no route back to 192.168.1.0/24.
    expect(t.reach('PC1', '8.8.8.8').message).toMatch(/No route to 192\.168\.1\.10 on ISP1/)
    t.cfg('R1', 'access-list 1 permit 192.168.1.0 0.0.0.255', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'exit', 'ip nat inside source list 1 interface g0/1 overload')
    const r = t.reach('PC1', '8.8.8.8')
    expect(r.message).toMatch(/Reply/)
    expect(r.hops.some((h) => /NAT: source 192\.168\.1\.10 → 203\.0\.113\.2/.test(h.detail))).toBe(true)
    expect(r.hops.some((h) => /NAT: destination 203\.0\.113\.2 → 192\.168\.1\.10/.test(h.detail))).toBe(true)
    expect(t.on('R1', 'show ip nat translations')).toMatch(/icmp 203\.0\.113\.2:1024\s+192\.168\.1\.10:1024\s+8\.8\.8\.8/)
    expect(t.on('R1', 'enable', 'show running-config')).toMatch(/ip nat inside source list 1 interface GigabitEthernet0\/1 overload[\s\S]*access-list 1 permit 192\.168\.1\.0 0\.0\.0\.255/)
  })

  it('static NAT publishes an inside server to the outside', () => {
    const t = natLab()
    t.cfg('R1', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'int g0/0', 'ip nat inside', 'int g0/1', 'ip nat outside', 'exit', 'ip nat inside source static 192.168.1.10 203.0.113.3')
    t.cfg('ISP1', 'ip route 203.0.113.3 255.255.255.255 203.0.113.2')
    const r = t.reach('ISP1', '203.0.113.3')
    expect(r.message).toMatch(/Reply/)
    expect(r.hops.some((h) => /NAT: destination 203\.0\.113\.3 → 192\.168\.1\.10/.test(h.detail))).toBe(true)
  })

  it('suggests a wildcard when an ACL is given a subnet mask', () => {
    const t = natLab()
    expect(t.cfg('R1', 'access-list 1 permit 192.168.1.0 255.255.255.0')).toMatch(/ACLs use wildcards: 0\.0\.0\.255/)
  })
})

describe('routing console details', () => {
  it('elects the DR by numeric router ID (10.0.0.10 beats 10.0.0.9)', () => {
    const t = chain()
    t.cfg('R1', 'router ospf 1', 'router-id 10.0.0.9', 'network 10.0.0.0 0.255.255.255 area 0')
    t.cfg('R2', 'router ospf 1', 'router-id 10.0.0.10', 'network 10.0.0.0 0.255.255.255 area 0')
    expect(t.on('R1', 'show ip ospf neighbor')).toMatch(/10\.0\.0\.10\s+1\s+FULL\/DR/)
    expect(t.on('R2', 'show ip ospf neighbor')).toMatch(/10\.0\.0\.9\s+1\s+FULL\/BDR/)
  })

  it('accepts any interface spelling in passive-interface', () => {
    const t = chain()
    for (const name of ['gi0/0', 'GigabitEthernet0/0', 'GigabitEthernet 0/0']) {
      expect(t.cfg('R1', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', `passive-interface ${name}`)).not.toMatch(/Invalid interface/)
      expect(t.dev('R1').ios?.ospf?.passive).toEqual(['g0/0'])
    }
  })

  it('BGP network does not warn about a prefix the router learned from OSPF', () => {
    const t = chain()
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
    // R1 learns 10.3.0.0/24 (R3's LAN) through OSPF.
    expect(t.cfg('R1', 'router bgp 65001', 'network 10.3.0.0 mask 255.255.255.0')).not.toMatch(/only advertises/)
    expect(t.cfg('R1', 'router bgp 65001', 'network 10.99.0.0 mask 255.255.255.0')).toMatch(/only advertises/)
  })
})
describe('static routes like IOS', () => {
  it('routes through an exit interface with proxy ARP', () => {
    const t = chain()
    t.cfg('R1', 'ip route 10.3.0.0 255.255.255.0 g0/1', 'ip route 10.23.0.0 255.255.255.252 GigabitEthernet 0/1')
    t.cfg('R2', 'ip route 10.3.0.0 255.255.255.0 10.23.0.2', 'ip route 10.1.0.0 255.255.255.0 10.12.0.1')
    t.cfg('R3', 'ip route 10.1.0.0 255.255.255.0 10.23.0.1', 'ip route 10.12.0.0 255.255.255.252 10.23.0.1')
    expect(t.on('R1', 'show ip route')).toMatch(/S\s+10\.3\.0\.0\/24 is directly connected, GigabitEthernet0\/1/)
    const r = t.reach('PC1', '10.3.0.10')
    expect(r.message).toMatch(/Reply/)
    expect(r.hops.some((h) => /proxy ARP/.test(h.detail))).toBe(true)
    expect(t.on('R1', 'enable', 'show running-config')).toMatch(/ip route 10\.3\.0\.0 255\.255\.255\.0 GigabitEthernet0\/1/)
  })

  it('a floating static route (distance 200) backs up OSPF and takes over when OSPF goes away', () => {
    const t = chain()
    for (const r of ['R1', 'R2', 'R3']) t.cfg(r, 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
    expect(t.cfg('R1', 'ip route 10.3.0.0 255.255.255.0 10.12.0.2 200')).toMatch(/floating static route/)
    let table = t.on('R1', 'show ip route')
    expect(table).toMatch(/O\s+10\.3\.0\.0\/24 \[110\/3\]/)
    expect(table).toMatch(/is a backup \(distance 200\)/)
    t.cfg('R1', 'no router ospf 1')
    table = t.on('R1', 'show ip route')
    expect(table).toMatch(/S\s+10\.3\.0\.0\/24 \[200\/0\] via 10\.12\.0\.2/)
    expect(t.on('R1', 'enable', 'show running-config')).toMatch(/ip route 10\.3\.0\.0 255\.255\.255\.0 10\.12\.0\.2 200/)
    t.cfg('R1', 'no ip route 10.3.0.0 255.255.255.0 10.12.0.2')
    expect(t.dev('R1').routes).toHaveLength(0)
  })

  it('rejects a bad exit interface or distance', () => {
    const t = chain()
    expect(t.cfg('R1', 'ip route 10.3.0.0 255.255.255.0 g9/9')).toMatch(/Invalid next hop or interface/)
    expect(t.cfg('R1', 'ip route 10.3.0.0 255.255.255.0 10.12.0.2 300')).toMatch(/Invalid distance 300/)
  })
})