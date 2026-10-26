import { describe, expect, it } from 'vitest'
import { emptySimState, ping, sendPacket } from './forwarding'
import { buildTopology, connectPorts, type DeviceSpec } from './network'
import { newSession, runLine } from './shell'

/** PC1 - R1 - R2 - R3 - PC3 with OSPF everywhere, so only ACLs decide what passes. */
function lab() {
  const devices: DeviceSpec[] = [
    { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.1.0.10/24' }, gateway: '10.1.0.1' },
    { type: 'pc', name: 'PC3', x: 0, y: 0, ifaces: { eth0: '10.3.0.10/24' }, gateway: '10.3.0.1' },
    { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.1.0.1/24', 'g0/1': '10.12.0.1/30' } },
    { type: 'router', name: 'R2', x: 0, y: 0, ifaces: { 'g0/0': '10.12.0.2/30', 'g0/1': '10.23.0.1/30' } },
    { type: 'router', name: 'R3', x: 0, y: 0, ifaces: { 'g0/0': '10.23.0.2/30', 'g0/1': '10.3.0.1/24' } },
  ]
  const t = buildTopology({ devices }, false)
  const id = (n: string) => t.devices.find((d) => d.name === n)!.id
  for (const [a, ai, b, bi] of [['PC1', 'eth0', 'R1', 'g0/0'], ['R1', 'g0/1', 'R2', 'g0/0'], ['R2', 'g0/1', 'R3', 'g0/0'], ['R3', 'g0/1', 'PC3', 'eth0']])
    connectPorts(t, id(a), ai, id(b), bi)
  const state = emptySimState()
  const on = (name: string, ...lines: string[]) => {
    const s = newSession(id(name))
    return lines.flatMap((l) => runLine(t, state, s, l).lines.map((x) => x.text)).join('\n')
  }
  const cfg = (name: string, ...lines: string[]) => on(name, 'enable', 'configure terminal', ...lines, 'end')
  for (const r of ['R1', 'R2', 'R3']) cfg(r, 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0')
  return { t, state, id, on, cfg }
}

describe('extended access lists', () => {
  it('block one service (SSH) and let everything else through, with match counters', () => {
    const t = lab()
    t.cfg('R1', 'access-list 110 deny tcp any host 10.3.0.10 eq 22', 'access-list 110 permit ip any any', 'interface g0/0', 'ip access-group 110 in')
    const ssh = sendPacket(t.t, t.state, t.id('PC1'), '10.3.0.10', 'tcp', 22)
    expect(ssh.success).toBe(false)
    expect(ssh.message).toMatch(/Denied by R1 access list 110 in on g0\/0 \(line 10: deny tcp any host 10\.3\.0\.10 eq ssh\)/)
    expect(sendPacket(t.t, t.state, t.id('PC1'), '10.3.0.10', 'tcp', 80).success).toBe(true)
    expect(ping(t.t, t.state, t.id('PC1'), '10.3.0.10').success).toBe(true)
    const show = t.on('R1', 'show access-lists 110')
    expect(show).toMatch(/Extended IP access list 110/)
    expect(show).toMatch(/10 deny tcp any host 10\.3\.0\.10 eq ssh \(1 match\)/)
    expect(show).toMatch(/20 permit ip any any \(2 matches\)/)
    expect(show).toMatch(/Applied: GigabitEthernet0\/0 in/)
    expect(t.on('R1', 'enable', 'show running-config')).toMatch(/interface GigabitEthernet0\/0[\s\S]*ip access-group 110 in[\s\S]*access-list 110 deny tcp any host 10\.3\.0\.10 eq ssh/)
  })

  it('ends with an implicit deny, and warns when a list has only denies', () => {
    const t = lab()
    expect(t.cfg('R1', 'access-list 120 deny icmp host 10.1.0.10 any')).toMatch(/implicit deny/)
    t.cfg('R1', 'interface g0/0', 'ip access-group 120 in')
    const r = sendPacket(t.t, t.state, t.id('PC1'), '10.3.0.10', 'tcp', 80)
    expect(r.message).toMatch(/the implicit deny at the end/)
  })

  it('are stateless: replies are checked too, which "established" allows for TCP', () => {
    const t = lab()
    // Toward PC1, only replies to sessions PC1 opened.
    t.cfg('R1', 'ip access-list extended REPLIES-ONLY', 'permit tcp any any established', 'exit', 'interface g0/0', 'ip access-group REPLIES-ONLY out')
    expect(sendPacket(t.t, t.state, t.id('PC1'), '10.3.0.10', 'tcp', 80).success).toBe(true)
    // An echo reply isn't a TCP reply: the ping's answer is dropped on the way back.
    const p = ping(t.t, t.state, t.id('PC1'), '10.3.0.10')
    expect(p.message).toMatch(/reply from 10\.3\.0\.10 was lost — Denied by R1 access list REPLIES-ONLY out/)
    // A new connection from PC3 to PC1 is blocked.
    expect(sendPacket(t.t, t.state, t.id('PC3'), '10.1.0.10', 'tcp', 80).success).toBe(false)
  })

  it('named lists take sequence numbers, insertions and deletions', () => {
    const t = lab()
    const out = t.cfg('R1', 'ip access-list extended EDGE', 'permit ip any any', '5 deny udp any any eq domain', 'remark block DNS first', 'no 10')
    expect(out).not.toMatch(/Invalid|Incomplete/)
    const cfgText = t.on('R1', 'enable', 'show running-config')
    expect(cfgText).toMatch(/ip access-list extended EDGE\n 5 deny udp any any eq domain\n \d+ remark block DNS first/)
    expect(cfgText).not.toMatch(/permit ip any any/)
  })

  it('reject a subnet mask where a wildcard belongs, and ports on non-TCP/UDP lines', () => {
    const t = lab()
    expect(t.cfg('R1', 'access-list 110 permit ip 10.1.0.0 255.255.255.0 any')).toMatch(/subnet mask; ACLs use wildcards: 0\.0\.0\.255/)
    expect(t.cfg('R1', 'access-list 110 permit icmp any any eq 80')).toMatch(/only go with tcp or udp/)
    expect(t.cfg('R1', 'access-list 10 permit 10.1.0.0 0.0.0.255 10.3.0.0 0.0.0.255')).toMatch(/Standard lists match the source only/)
  })
})

describe('access-class on vty lines', () => {
  it('lets only permitted hosts SSH in', () => {
    const t = lab()
    t.cfg('R1', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'username admin secret Str0ng!', 'access-list 10 permit host 10.1.0.10', 'line vty 0 4', 'login local', 'transport input ssh', 'access-class 10 in')
    expect(t.on('PC3', 'ssh admin@10.1.0.1')).toMatch(/only accept hosts permitted by access list 10 \(access-class 10 in\), and 10\.3\.0\.10 isn't one/)
    expect(t.on('PC1', 'ssh admin@10.1.0.1')).not.toMatch(/access-class/)
    expect(t.on('R1', 'enable', 'show running-config')).toMatch(/line vty 0 4[\s\S]*access-class 10 in/)
  })
})