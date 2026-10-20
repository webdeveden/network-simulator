/**
 * The attacker box's terminal: a Kali-style prompt that runs the simulated layer-2
 * attacks from attacks.ts by name. It is a teaching surface, not a real tool — the
 * attacks only inspect the topology and report what your switch config would do.
 */
import { ATTACKS, attackerUplink, type AttackLine, type AttackName } from './attacks'
import type { CommandResult, Line, LineKind } from './commands'
import { switchport } from './l2'
import { getDevice, linkOn, peerOf } from './network'
import type { Device, Topology } from './types'

const L = (text: string, kind: LineKind = 'out'): Line => ({ text, kind })

/** Map the attack output's colours onto the terminal's. `cmd` lines look like typed commands. */
function render(line: AttackLine): Line {
  if (line.kind === 'cmd') return L(`┌──(kali)-[~]\n└─$ ${line.text}`.split('\n').join('\n'), 'info')
  const kind: LineKind = line.kind === 'ok' ? 'ok' : line.kind === 'err' ? 'err' : line.kind === 'info' ? 'muted' : 'out'
  return L(line.text, kind)
}

const HELP: [string, string][] = [
  ['scan', 'look at the switch and VLAN this box is plugged into'],
  ['mac-flood', 'CAM-table overflow — make the switch flood all traffic (sniffing)'],
  ['arp-spoof', 'ARP poisoning — become the gateway (man-in-the-middle)'],
  ['dhcp-starve', 'DHCP starvation — drain the address pool (denial of service)'],
  ['rogue-dhcp', 'rogue DHCP server — hand out yourself as the gateway'],
  ['rogue-switch', 'STP root takeover — pretend to be a switch and reroute traffic'],
  ['vlan-hop', 'VLAN hopping — double-tag a frame into another VLAN'],
  ['whoami', 'the attacker box identity'],
  ['clear', 'clear the screen'],
]

/** A quick look at where the attacker sits: switch, port, VLAN, and what else is around. */
function scan(topo: Topology, dev: Device): Line[] {
  const u = attackerUplink(topo, dev)
  if (!u) return [L('eth0: no link to a switch. Cable this box into a switch access port, then try again.', 'err')]
  const sp = switchport(u.sw, u.port)
  const lines = [
    L(`Nmap-style recon from ${dev.name} (eth0 ${dev.ifaces[0]?.mac ?? ''})`, 'info'),
    L(`  uplink switch : ${u.sw.name} port ${u.port}`),
    L(`  access VLAN   : ${u.vlan}${sp.mode === 'trunk' ? ' (port is a TRUNK — unusual for a host)' : ''}`),
  ]
  // What defences are already on this port / switch, so the attacker (and learner) can see the lay of the land.
  const port = u.sw.ifaces.find((i) => i.name === u.port)!
  const def: string[] = []
  if (port.switchport?.portSecurity) def.push('port-security')
  if (port.stp?.bpduguard) def.push('bpdu-guard')
  if (u.sw.ios?.dhcpSnoop?.vlans.includes(u.vlan)) def.push('dhcp-snooping')
  if (u.sw.ios?.arpInspect?.vlans.includes(u.vlan)) def.push('arp-inspection(DAI)')
  lines.push(L(`  defences seen : ${def.length ? def.join(', ') : 'NONE — this port is wide open'}`, def.length ? 'ok' : 'err'))
  // Neighbours on the same switch.
  const peers = u.sw.ifaces
    .filter((i) => i.name !== u.port && linkOn(topo, u.sw.id, i.name))
    .map((i) => getDevice(topo, peerOf(linkOn(topo, u.sw.id, i.name)!, u.sw.id, i.name).device)?.name)
    .filter(Boolean)
  if (peers.length) lines.push(L(`  also on ${u.sw.name}: ${[...new Set(peers)].join(', ')}`))
  lines.push(L('Pick an attack (type help). Each one tells you if your switch stops it.', 'info'))
  return lines
}

export function runKali(topo: Topology, dev: Device, input: string): CommandResult {
  const cmd = input.trim().split(/\s+/)[0]
  const c = cmd?.toLowerCase() ?? ''
  if (!c) return { lines: [] }
  if (c === 'clear' || c === 'cls') return { lines: [], clear: true }
  if (c === 'help' || c === '?' || c === 'ls')
    return { lines: [L('Attacks (simulated — defensive training only):', 'info'), ...HELP.map(([k, d]) => L(`  ${k.padEnd(14)}${d}`))] }
  if (c === 'whoami')
    return { lines: [L('root'), L(`${dev.name} — Kali-style attacker box. eth0 ${dev.ifaces[0]?.mac ?? ''}. Simulated lab tooling only.`, 'muted')] }
  if (c === 'scan' || c === 'nmap' || c === 'recon') return { lines: scan(topo, dev) }
  if (c === 'ifconfig' || c === 'ip')
    return { lines: dev.ifaces.map((i) => L(`${i.name}: ${i.ip ? `${i.ip}/${i.prefix}` : 'no address'}  ether ${i.mac}`)) }

  const attack = ATTACKS[c as AttackName]
  if (attack) {
    const r = attack.run(topo, dev)
    return { lines: [L(`── ${attack.title} ──`, 'info'), ...r.lines.map(render), L('')], mutated: true }
  }
  return { lines: [L(`${cmd}: command not found. Type help for the attack list.`, 'err')] }
}

/** Banner shown when the attacker terminal opens. */
export function kaliBanner(dev: Device): Line[] {
  return [
    L('┌──────────────────────────────────────────────┐', 'err'),
    L('│  NetSim Security Lab · simulated attacker box  │', 'err'),
    L('└──────────────────────────────────────────────┘', 'err'),
    L(`${dev.name}: a rogue host for defensive training. No real traffic leaves the lab.`, 'muted'),
    L('Type help for the attack list, or scan to see where you are plugged in.', 'info'),
    L(''),
  ]
}
