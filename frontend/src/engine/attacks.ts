/**
 * Simulated layer-2 attacks for the cybersecurity lab. These are teaching
 * stand-ins, not real tools: each one reads the defender's actual switch
 * configuration and reports whether it would succeed or be stopped, and by which
 * Cisco feature. The attacker is a rogue host (a "Kali" box in attacks terms)
 * cabled to a switch access port, like an insider or a hijacked laptop.
 *
 * Nothing here sends traffic anywhere real; it inspects the topology only.
 */
import { switchport } from './l2'
import { getDevice, isHost, linkActive, linkOn, patchPartner, peerOf } from './network'
import type { Device, Iface, Topology } from './types'

export interface AttackLine {
  text: string
  kind: 'out' | 'ok' | 'err' | 'info' | 'cmd'
}
export interface AttackResult {
  lines: AttackLine[]
  /** True when the attack would work (the defence is missing). */
  success: boolean
}

const cmd = (text: string): AttackLine => ({ text, kind: 'cmd' })
const out = (text: string): AttackLine => ({ text, kind: 'out' })
/** The attack got through — bad for the defender, so shown as an alert (err colour). */
const hit = (text: string): AttackLine => ({ text, kind: 'err' })
/** The attack was stopped — good for the defender. */
const stop = (text: string): AttackLine => ({ text, kind: 'ok' })
const info = (text: string): AttackLine => ({ text, kind: 'info' })

/** Where the attacker's cable lands: the switch, the access port on it, and that port's VLAN. */
export interface Uplink {
  sw: Device
  port: string
  vlan: number
}

/** Follow the attacker's wired port through any patch panels to the switch access port. */
export function attackerUplink(topo: Topology, attacker: Device): Uplink | null {
  const nic = attacker.ifaces.find((i) => i.name === 'eth0') ?? attacker.ifaces[0]
  if (!nic) return null
  let from = { device: attacker.id, iface: nic.name }
  let l = linkOn(topo, from.device, from.iface)
  for (let hops = 0; l && hops < 8; hops++) {
    if (!linkActive(topo, l)) return null
    const peer = peerOf(l, from.device, from.iface)
    const d = getDevice(topo, peer.device)
    if (!d) return null
    if (d.type === 'patch') {
      from = { device: d.id, iface: patchPartner(peer.iface) }
      l = linkOn(topo, from.device, from.iface)
      continue
    }
    if (d.type !== 'switch') return null
    const sp = switchport(d, peer.iface)
    return { sw: d, port: peer.iface, vlan: sp.mode === 'access' ? (sp.vlan ?? 1) : (sp.native ?? 1) }
  }
  return null
}

/** The switch's trunk ports (where VLAN hopping and rogue switches aim). */
const trunkPorts = (sw: Device): Iface[] => sw.ifaces.filter((i) => i.switchport?.mode === 'trunk')
/** Other hosts sharing the attacker's VLAN: the victims. */
function victims(topo: Topology, u: Uplink): Device[] {
  return topo.devices.filter((d) => d.id !== undefined && isHost(d) && d.ifaces.some((i) => i.ip) && reachableVlan(topo, d) === u.vlan && !isAttacker(d))
}
const isAttacker = (d: Device) => d.type === 'attacker'
/** The VLAN a host sits in (its switch access port's VLAN), or 1. */
function reachableVlan(topo: Topology, host: Device): number | null {
  const nic = host.ifaces.find((i) => i.name === 'eth0' || i.name === 'wlan0' || i.name === 'pc') ?? host.ifaces[0]
  if (!nic) return null
  let from = { device: host.id, iface: nic.name }
  let l = linkOn(topo, from.device, from.iface)
  for (let hops = 0; l && hops < 8; hops++) {
    if (!linkActive(topo, l)) return null
    const peer = peerOf(l, from.device, from.iface)
    const d = getDevice(topo, peer.device)
    if (!d) return null
    if (d.type === 'patch') {
      from = { device: d.id, iface: patchPartner(peer.iface) }
      l = linkOn(topo, from.device, from.iface)
      continue
    }
    if (d.type === 'phone') {
      from = { device: d.id, iface: peer.iface === 'pc' ? 'eth0' : 'pc' }
      l = linkOn(topo, from.device, from.iface)
      continue
    }
    if (d.type !== 'switch') return null
    const sp = switchport(d, peer.iface)
    return sp.mode === 'access' ? (sp.vlan ?? 1) : (sp.native ?? 1)
  }
  return null
}

/** The gateway address hosts in the attacker's VLAN use (a router subinterface or SVI), if any. */
function gatewayIp(topo: Topology, u: Uplink): string | undefined {
  const vics = victims(topo, u)
  const gw = vics.map((v) => v.gateway).find(Boolean)
  if (gw) return gw
  // Else the SVI or router subinterface address for this VLAN.
  for (const d of topo.devices) for (const i of d.ifaces) if (i.ip && (i.name === `vlan${u.vlan}` || i.vlan === u.vlan)) return i.ip
  return undefined
}

const noUplink: AttackResult = {
  success: false,
  lines: [hit('No access to a switch. Cable the attacker\'s eth0 into a switch port first, then run the attack.')],
}

// ---------- the attacks ----------

/** CAM-table overflow: flood the switch with bogus source MACs so it fails open and floods all frames. */
export function macFlood(topo: Topology, attacker: Device): AttackResult {
  const u = attackerUplink(topo, attacker)
  if (!u) return noUplink
  const port = u.sw.ifaces.find((i) => i.name === u.port)!
  const ps = port.switchport?.portSecurity
  const l = [
    cmd(`macof -i eth0            # flood ${u.sw.name} with random source MACs`),
    out(`.. sending 155000 MAC entries toward ${u.sw.name} ${u.port} (VLAN ${u.vlan})`),
  ]
  if (ps) {
    const v = ps.violation ?? 'shutdown'
    l.push(stop(`BLOCKED. Port security on ${u.sw.name} ${u.port} allows only ${ps.max ?? 1} MAC(s).`))
    l.push(v === 'shutdown' ? stop(`The port err-disabled on the 2nd MAC: the flood never reaches the CAM table.`) : stop(`Extra MACs are dropped (${v}); the CAM table is never overflowed.`))
    l.push(info('Mitigation in place: switchport port-security.'))
    return { success: false, lines: l }
  }
  l.push(hit(`SUCCESS. ${u.sw.name}'s MAC table overflowed and it is now flooding every frame out every port — the attacker can sniff other VLAN ${u.vlan} traffic.`))
  l.push(info('Fix it: on the access port → switchport mode access → switchport port-security (set a maximum, violation shutdown).'))
  return { success: true, lines: l }
}

/** ARP poisoning: claim the gateway's IP so victims send their traffic through the attacker (MITM). */
export function arpSpoof(topo: Topology, attacker: Device): AttackResult {
  const u = attackerUplink(topo, attacker)
  if (!u) return noUplink
  const gw = gatewayIp(topo, u) ?? '(the gateway)'
  const vics = victims(topo, u)
  const port = u.sw.ifaces.find((i) => i.name === u.port)!
  const dai = u.sw.ios?.arpInspect?.vlans.includes(u.vlan)
  const l = [
    cmd(`arpspoof -i eth0 -t ${vics[0]?.ifaces.find((i) => i.ip)?.ip ?? '<victim>'} ${gw}`),
    out(`.. telling VLAN ${u.vlan} hosts that ${gw} is at ${(attacker.ifaces[0]?.mac ?? 'aa:bb:cc:00:00:01')}`),
  ]
  if (dai && !port.daiTrust) {
    l.push(stop(`BLOCKED. Dynamic ARP Inspection on ${u.sw.name} VLAN ${u.vlan} checked the ARP against the DHCP snooping table.`))
    l.push(stop(`The attacker doesn't own ${gw}, so the forged ARP is dropped on the untrusted port ${u.port}.`))
    l.push(info('Mitigation in place: ip arp inspection vlan ' + u.vlan + ' (with ip dhcp snooping).'))
    return { success: false, lines: l }
  }
  l.push(hit(`SUCCESS. ${vics.length || 'The'} host(s) in VLAN ${u.vlan} now send traffic for ${gw} to the attacker — a man-in-the-middle. Passwords and sessions can be read.`))
  l.push(info('Fix it: ip dhcp snooping + ip arp inspection vlan ' + u.vlan + ', and ip arp inspection trust on the uplink/router port.'))
  return { success: true, lines: l }
}

/** DHCP starvation: drain the server's pool with spoofed-MAC DISCOVERs. */
export function dhcpStarve(topo: Topology, attacker: Device): AttackResult {
  const u = attackerUplink(topo, attacker)
  if (!u) return noUplink
  const port = u.sw.ifaces.find((i) => i.name === u.port)!
  const snoop = u.sw.ios?.dhcpSnoop?.vlans.includes(u.vlan)
  const ps = port.switchport?.portSecurity
  const l = [
    cmd(`dhcpstarve -i eth0        # flood DHCP DISCOVER with spoofed MACs`),
    out(`.. requesting every address in the VLAN ${u.vlan} pool`),
  ]
  if (snoop && !port.snoopTrust) {
    l.push(stop(`BLOCKED. DHCP snooping on ${u.sw.name} rate-limits DHCP on untrusted port ${u.port} and drops the flood.`))
    l.push(info('Mitigation in place: ip dhcp snooping.'))
    return { success: false, lines: l }
  }
  if (ps) {
    l.push(stop(`BLOCKED. Each spoofed source MAC trips port security on ${u.port}; the port stops forwarding before the pool drains.`))
    l.push(info('Mitigation in place: switchport port-security (DHCP snooping is the purpose-built fix).'))
    return { success: false, lines: l }
  }
  l.push(hit(`SUCCESS. The DHCP pool is exhausted — real users can no longer get an address (denial of service), and the attacker can follow up with a rogue DHCP server.`))
  l.push(info('Fix it: ip dhcp snooping + ip dhcp snooping vlan ' + u.vlan + ', trust only the uplink.'))
  return { success: true, lines: l }
}

/** Rogue DHCP: answer DHCP as a fake server and hand out the attacker as the gateway (MITM). */
export function rogueDhcp(topo: Topology, attacker: Device): AttackResult {
  const u = attackerUplink(topo, attacker)
  if (!u) return noUplink
  const port = u.sw.ifaces.find((i) => i.name === u.port)!
  const snoop = u.sw.ios?.dhcpSnoop?.vlans.includes(u.vlan)
  const l = [
    cmd(`dnsmasq --dhcp-range=... # run a rogue DHCP server, gateway = attacker`),
    out(`.. answering DHCP on VLAN ${u.vlan}, offering the attacker as the default gateway`),
  ]
  if (snoop && !port.snoopTrust) {
    l.push(stop(`BLOCKED. DHCP snooping on ${u.sw.name} drops server messages (OFFER/ACK) arriving on untrusted port ${u.port}.`))
    l.push(stop('Only the trusted uplink may answer DHCP, so clients ignore the rogue server.'))
    l.push(info('Mitigation in place: ip dhcp snooping.'))
    return { success: false, lines: l }
  }
  l.push(hit(`SUCCESS. New clients in VLAN ${u.vlan} take the attacker as their gateway and DNS — a man-in-the-middle for everyone who renews their lease.`))
  l.push(info('Fix it: ip dhcp snooping, and ip dhcp snooping trust ONLY on the uplink to the real server.'))
  return { success: true, lines: l }
}

/** Rogue switch / STP attack: announce a superior BPDU to become root and reroute traffic. */
export function rogueSwitch(topo: Topology, attacker: Device): AttackResult {
  const u = attackerUplink(topo, attacker)
  if (!u) return noUplink
  const port = u.sw.ifaces.find((i) => i.name === u.port)!
  const l = [
    cmd(`yersinia stp -attack 4    # claim to be the root bridge (priority 0)`),
    out(`.. sending superior BPDUs into ${u.sw.name} ${u.port}`),
  ]
  if (port.stp?.bpduguard) {
    l.push(stop(`BLOCKED. BPDU guard on ${u.sw.name} ${u.port} saw a BPDU on an access port and err-disabled it instantly.`))
    l.push(info('Mitigation in place: spanning-tree bpduguard enable (with spanning-tree portfast).'))
    return { success: false, lines: l }
  }
  l.push(hit(`SUCCESS. The attacker became the spanning-tree root, so other switches now forward traffic toward it — it can intercept or disrupt the whole switched network.`))
  l.push(info('Fix it: on every access port → spanning-tree portfast + spanning-tree bpduguard enable (and consider root guard on trunks).'))
  return { success: true, lines: l }
}

/** VLAN hopping by double-tagging: reach a VLAN you shouldn't, via the trunk's native VLAN. */
export function vlanHop(topo: Topology, attacker: Device): AttackResult {
  const u = attackerUplink(topo, attacker)
  if (!u) return noUplink
  const trunks = trunkPorts(u.sw)
  const l = [cmd(`# double-tagged frame: outer tag ${u.vlan} (native), inner tag = target VLAN`)]
  if (!trunks.length) {
    l.push(stop(`BLOCKED. ${u.sw.name} has no trunk, so there is no native VLAN to abuse — the double tag goes nowhere.`))
    return { success: false, lines: l }
  }
  // Double-tagging works when the attacker's access VLAN equals a trunk's native VLAN:
  // the first switch strips the matching outer tag and forwards the inner-tagged frame.
  const bad = trunks.find((t) => (t.switchport!.native ?? 1) === u.vlan)
  if (bad) {
    const targets = [...new Set(topo.devices.flatMap((d) => d.ifaces.map((i) => i.vlan).filter((v): v is number => !!v && v !== u.vlan)))]
    l.push(out(`.. attacker VLAN ${u.vlan} matches the native VLAN on trunk ${bad.name}`))
    l.push(hit(`SUCCESS. The outer tag is stripped at ${u.sw.name} and the frame is delivered into VLAN ${targets[0] ?? 'the target'} across the trunk — a one-way jump past VLAN segmentation.`))
    l.push(info(`Fix it: set the trunk's native VLAN to an unused VLAN (switchport trunk native vlan 999) so it never matches a user's access VLAN, and prune it.`))
    return { success: true, lines: l }
  }
  l.push(stop(`BLOCKED. The attacker's VLAN ${u.vlan} doesn't match any trunk's native VLAN, so the outer tag is never stripped — the inner tag can't escape.`))
  l.push(info('Mitigation in place: the native VLAN differs from the access VLAN.'))
  return { success: false, lines: l }
}

export type AttackName = 'mac-flood' | 'arp-spoof' | 'dhcp-starve' | 'rogue-dhcp' | 'rogue-switch' | 'vlan-hop'

export const ATTACKS: Record<AttackName, { run: (t: Topology, a: Device) => AttackResult; title: string }> = {
  'mac-flood': { run: macFlood, title: 'CAM-table overflow (MAC flooding)' },
  'arp-spoof': { run: arpSpoof, title: 'ARP poisoning (man-in-the-middle)' },
  'dhcp-starve': { run: dhcpStarve, title: 'DHCP starvation (pool exhaustion)' },
  'rogue-dhcp': { run: rogueDhcp, title: 'Rogue DHCP server' },
  'rogue-switch': { run: rogueSwitch, title: 'Rogue switch / STP root takeover' },
  'vlan-hop': { run: vlanHop, title: 'VLAN hopping (double tagging)' },
}
