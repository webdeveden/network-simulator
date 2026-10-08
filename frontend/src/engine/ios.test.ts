import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from './forwarding'
import { buildTopology } from './network'
import { evaluate, type Objective } from './objectives'
import { newSession, promptOf, runLine, type Session } from './shell'
import type { Topology } from './types'

const dev = (t: Topology, name: string) => t.devices.find((d) => d.name === name)!

function lab() {
  const topo = buildTopology({
    devices: [
      { type: 'pc', name: 'ADMIN-PC', x: 0, y: 0, ifaces: { eth0: '10.0.0.10/24' }, gateway: '10.0.0.1' },
      { type: 'switch', name: 'SW1', x: 0, y: 0 },
      { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.0.1/24' } },
    ],
    links: [['SW1', 'ADMIN-PC'], ['SW1', 'R1']],
  }, false)
  const state = emptySimState()
  /** Runs lines on a session and returns all output text. */
  const on = (s: Session, ...lines: string[]) =>
    lines.flatMap((l) => runLine(topo, state, s, l).lines.map((x) => x.text)).join('\n')
  const prompt = (s: Session) => promptOf(topo, s).text
  return { topo, state, on, prompt }
}

describe('ios console', () => {
  it('walks the modes with abbreviations', () => {
    const { topo, on, prompt } = lab()
    const s = newSession(dev(topo, 'R1').id)
    expect(prompt(s)).toBe('R1>')
    on(s, 'en')
    expect(prompt(s)).toBe('R1#')
    on(s, 'conf t')
    expect(prompt(s)).toBe('R1(config)#')
    on(s, 'int g0/1')
    expect(prompt(s)).toBe('R1(config-if)#')
    on(s, 'ip add 10.9.0.1 255.255.255.252')
    expect(dev(topo, 'R1').ifaces[1]).toMatchObject({ ip: '10.9.0.1', prefix: 30 })
    // A global command in interface mode drops back to config mode.
    on(s, 'hostname EDGE')
    expect(prompt(s)).toBe('EDGE(config)#')
    on(s, 'end')
    expect(prompt(s)).toBe('EDGE#')
    expect(on(s, 'sh ip int br')).toMatch(/GigabitEthernet0\/1\s+10\.9\.0\.1\s+YES manual down/)
  })

  it('reports ambiguous, incomplete and invalid input', () => {
    const { topo, on } = lab()
    const s = newSession(dev(topo, 'R1').id)
    on(s, 'enable')
    expect(on(s, 'e')).toMatch(/Ambiguous command/)
    expect(on(s, 'show')).toMatch(/Incomplete command/)
    expect(on(s, 'shwo run')).toMatch(/Invalid input/)
    expect(on(s, 'ip set g0/0 10.0.0.1/24')).toMatch(/ip address/)
    expect(on(s, 'sh ?')).toMatch(/running-config/)
  })

  it('shutdown takes a link down', () => {
    const { topo, state, on } = lab()
    const s = newSession(dev(topo, 'R1').id)
    on(s, 'enable', 'conf t', 'int g0/0', 'shutdown')
    expect(ping(topo, state, dev(topo, 'ADMIN-PC').id, '10.0.0.1').success).toBe(false)
    on(s, 'no shut')
    expect(ping(topo, state, dev(topo, 'ADMIN-PC').id, '10.0.0.1').success).toBe(true)
  })

  it('adds static routes with dotted masks', () => {
    const { topo, on } = lab()
    const s = newSession(dev(topo, 'R1').id)
    on(s, 'enable', 'conf t', 'ip route 10.3.0.0 255.255.255.0 10.0.0.2')
    expect(dev(topo, 'R1').routes).toEqual([{ network: '10.3.0.0', prefix: 24, via: '10.0.0.2' }])
    expect(on(s, 'do show ip route')).toMatch(/S\s+10\.3\.0\.0\/24 \[1\/0\] via 10\.0\.0\.2/)
    on(s, 'no ip route 10.3.0.0 255.255.255.0 10.0.0.2')
    expect(dev(topo, 'R1').routes).toEqual([])
  })

  it('remote enable needs an enable secret, console does not', () => {
    const { topo, on, prompt } = lab()
    const r1 = newSession(dev(topo, 'R1').id)
    on(r1, 'enable', 'conf t', 'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'username admin secret pw', 'line vty 0 4', 'login local', 'end')
    const pc = newSession(dev(topo, 'ADMIN-PC').id)
    on(pc, 'ssh admin@10.0.0.1', 'pw')
    expect(prompt(pc)).toBe('R1>')
    expect(on(pc, 'enable')).toMatch(/No password set/)
  })
})

describe('secure remote access mission', () => {
  const objectives: Objective[] = [
    { type: 'ios', label: 'secret', device: 'R1', check: 'enableSecret' },
    { type: 'ios', label: 'ssh only', device: 'R1', check: 'sshOnly' },
    { type: 'ssh', label: 'ssh', from: 'ADMIN-PC', to: 'R1', user: 'admin' },
    { type: 'ios', label: 'saved', device: 'R1', check: 'saved' },
  ]

  it('is solved by the hinted commands, and SSH login works', () => {
    const { topo, on, prompt } = lab()
    expect(evaluate(topo, objectives).every((o) => !o.done)).toBe(true)

    const pc = newSession(dev(topo, 'ADMIN-PC').id)
    expect(on(pc, 'ssh admin@10.0.0.1')).toMatch(/Connection refused/)

    const r1 = newSession(dev(topo, 'R1').id)
    expect(on(r1, 'enable', 'conf t', 'crypto key generate rsa')).toMatch(/define a domain-name/)
    on(
      r1,
      'enable secret Cl4ss',
      'username admin secret S3cret',
      'ip domain-name lab.local',
      'crypto key generate rsa',
    )
    expect(prompt(r1)).toMatch(/modulus/)
    expect(on(r1, '2048')).toMatch(/SSH 1.99 has been enabled/)
    on(r1, 'ip ssh version 2', 'line vty 0 4', 'login local', 'transport input ssh', 'end', 'wr')
    expect(evaluate(topo, objectives).map((o) => o.done)).toEqual([true, true, true, true])
    expect(on(r1, 'show run')).toMatch(/enable secret 5 \$1\$/)

    // Wrong password three times, then the right one.
    on(pc, 'ssh admin@10.0.0.1')
    expect(promptOf(topo, pc)).toEqual({ text: "admin@10.0.0.1's password: ", secret: true })
    expect(on(pc, 'nope', 'nope', 'nope')).toMatch(/Permission denied \(password\)/)
    on(pc, 'ssh -l admin R1', 'S3cret')
    expect(prompt(pc)).toBe('R1>')
    on(pc, 'enable', 'Cl4ss')
    expect(prompt(pc)).toBe('R1#')
    expect(on(pc, 'exit')).toMatch(/closed by foreign host/)
    expect(prompt(pc)).toBe('ADMIN-PC:~$')
  })

  it('a firewall blocking TCP 22 stops SSH', () => {
    const topo = buildTopology({
      devices: [
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '10.0.1.10/24' }, gateway: '10.0.1.1' },
        { type: 'firewall', name: 'FW', x: 0, y: 0, ifaces: { 'g0/0': '10.0.1.1/24', 'g0/1': '10.0.2.1/24' } },
        { type: 'router', name: 'R', x: 0, y: 0, ifaces: { 'g0/0': '10.0.2.2/24' } },
      ],
      links: [['A', 'FW'], ['FW', 'R']],
    })
    const state = emptySimState()
    const r = newSession(dev(topo, 'R').id)
    for (const l of ['enable', 'conf t', 'ip domain-name x.y', 'crypto key gen rsa mod 2048', 'username u secret p', 'line vty 0 4', 'login local'])
      runLine(topo, state, r, l)
    const fw = newSession(dev(topo, 'FW').id)
    for (const l of ['enable', 'conf t', 'fw rule add deny any any tcp/22']) runLine(topo, state, fw, l)
    const a = newSession(dev(topo, 'A').id)
    const out = runLine(topo, state, a, 'ssh u@10.0.2.2').lines.map((l) => l.text).join('\n')
    expect(out).toMatch(/timed out/)
    expect(out).toMatch(/Blocked by FW/)
  })
})
