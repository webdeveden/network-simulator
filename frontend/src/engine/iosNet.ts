/**
 * IOS commands for VLANs and trunks, router-on-a-stick, OSPF, EIGRP, RIP, BGP,
 * DHCP (server, relay, client) and NAT, with their running-config lines and
 * `show` output.
 */
import { activeLeases, dhcpOf, dhcpRequest, poolSize } from './dhcp'
import { inSubnet, isValidIp, networkOf, prefixToMask } from './ip'
import { DEFAULT_PORT, switchport, vlanExists, type SimState } from './l2'
import { getDevice, isRouterLike, isSubIface, isSvi, linkActive, linkOn, physPort } from './network'
import { bgpSessions, bgpTable, classfulNetwork, classfulPrefix, protocolNeighbors, routerId, configured, ospfCost } from './routing'
import { ciscoMac, conf, fail, L, longName, maskToPrefix, tip, type Ctx, type Mode, type Result, type Spec } from './iosBase'
import type { Device, Iface, NetworkStatement, Switchport } from './types'

const CFG: Mode[] = ['config']
const IF: Mode[] = ['if']
const RTR: Mode[] = ['router']
const EXEC: Mode[] = ['user', 'priv']
const PRIV: Mode[] = ['priv']
const SW: Device['type'][] = ['switch']
const L3: Device['type'][] = ['router', 'firewall', 'isp']

const ok = (lines: ReturnType<typeof L>[] = []): Result => ({ lines, mutated: true })
const cur = (c: Ctx): Iface => c.dev.ifaces.find((i) => i.name === c.f.iface)!
/** IOS table style: Fa0/1, Gi0/1. */
const portAbbr = (n: string) => n.replace(/^fa/, 'Fa').replace(/^g(?=\d)/, 'Gi')

const PROTO_NAME = { ospf: 'OSPF', eigrp: 'EIGRP', rip: 'RIP', bgp: 'BGP' } as const

// ---------- parsing ----------

/** `10,20,30-35` -> [10, 20, 30, 31, …]. */
export function parseVlanList(text: string): number[] | null {
  const out: number[] = []
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) return null
    const a = Number(m[1])
    const b = Number(m[2] ?? m[1])
    if (a < 1 || b > 4094 || b < a) return null
    for (let v = a; v <= b; v++) out.push(v)
  }
  return out
}

const vlanNum = (s: string | undefined) => {
  const n = Number(s)
  return Number.isInteger(n) && n >= 1 && n <= 4094 ? n : null
}

/** `0.0.0.255` wildcard -> prefix, for display. */
const wildcardPrefix = (w: string) => maskToPrefix(w.split('.').map((o) => String(255 - Number(o))).join('.'))

function compressVlans(list: number[]): string {
  const v = [...new Set(list)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let k = 0; k < v.length; k++) {
    let j = k
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++
    parts.push(j > k ? `${v[k]}-${v[j]}` : `${v[k]}`)
    k = j
  }
  return parts.join(',')
}

// ---------- switchports ----------

function portSettings(c: Ctx): Switchport | string {
  if (c.dev.type !== 'switch') return '% Switchport commands are for switch ports.'
  const i = cur(c)
  if (isSvi(i.name) || i.name === 'con0') return `% ${longName(i.name)} is not a switch port.`
  return (i.switchport ??= { ...DEFAULT_PORT })
}

function ensureVlan(dev: Device, v: number): string | null {
  if (vlanExists(dev, v)) return null
  ;(conf(dev).vlans ??= {})[v] = `VLAN${String(v).padStart(4, '0')}`
  return `% Access VLAN does not exist. Creating vlan ${v}`
}

// ---------- routing process helpers ----------

function proc(c: Ctx) {
  const p = c.f.proto!
  return { p, cfg: c.dev.ios![p]! }
}

function parseNetworkStatement(c: Ctx, rest: string[]): NetworkStatement | { network: string; prefix: number } | string {
  const { p } = proc(c)
  const [net, a, b, area] = rest
  if (!net || !isValidIp(net)) return '% Incomplete command.'
  if (p === 'ospf') {
    if (!a || !isValidIp(a) || b?.toLowerCase() !== 'area' || area === undefined)
      return '% Incomplete command. network <address> <wildcard> area <n>, e.g. network 10.0.0.0 0.0.0.255 area 0'
    const n = Number(area)
    if (!Number.isInteger(n) || n < 0) return `% Invalid area ${area}`
    if (wildcardPrefix(a) === null) return `% ${a} is not a wildcard mask (e.g. 0.0.0.255 for a /24)`
    return { network: net, wildcard: a, area: n }
  }
  if (p === 'eigrp') {
    if (a && !isValidIp(a)) return '% Invalid wildcard'
    if (a && wildcardPrefix(a) === null) return `% ${a} is not a wildcard mask (e.g. 0.0.0.255 for a /24)`
    return a ? { network: net, wildcard: a } : { network: classfulNetwork(net) }
  }
  if (p === 'rip') return { network: classfulNetwork(net) }
  // BGP: network A.B.C.D mask M (classful if no mask).
  if (a && a.toLowerCase() === 'mask') {
    const prefix = b ? maskToPrefix(b) : null
    if (prefix === null) return '% Invalid mask'
    return { network: networkOf(net, prefix), prefix }
  }
  const prefix = classfulNetwork(net) === net ? classfulPrefix(net) : 32
  return { network: net, prefix }
}

function routeTip(c: Ctx): string[] {
  const p = c.f.proto!
  if (p === 'bgp') return []
  return [`Check neighbors with: do show ip ${p === 'ospf' ? 'ospf neighbor' : p === 'eigrp' ? 'eigrp neighbors' : 'protocols'}`]
}

// ---------- show output ----------

function showVlan(c: Ctx): ReturnType<typeof L>[] {
  const d = c.dev
  const vlans = [1, ...Object.keys(d.ios?.vlans ?? {}).map(Number)].sort((a, b) => a - b)
  const lines = [L('VLAN Name                             Status    Ports', 'info'), L('---- -------------------------------- --------- -------------------------------', 'info')]
  const ports = d.ifaces.filter((i) => i.name.startsWith('fa') || i.name.startsWith('g'))
  for (const v of vlans) {
    const name = v === 1 ? 'default' : d.ios!.vlans![v]
    const members = ports.filter((i) => (i.switchport ?? DEFAULT_PORT).mode === 'access' && ((i.switchport?.vlan ?? 1) === v)).map((i) => portAbbr(i.name))
    lines.push(L(`${String(v).padEnd(5)}${name.padEnd(33)}active    ${members.join(', ')}`))
  }
  const orphans = ports.filter((i) => i.switchport?.mode === 'access' && !vlanExists(d, i.switchport.vlan ?? 1))
  for (const o of orphans) lines.push(tip(`${longName(o.name)} is in VLAN ${o.switchport!.vlan}, which no longer exists: the port is inactive`))
  const trunks = ports.filter((i) => i.switchport?.mode === 'trunk')
  if (trunks.length) lines.push(tip(`Trunk ports are not listed here: ${trunks.map((t) => t.name).join(', ')} (show interfaces trunk)`))
  return lines
}

function showTrunk(c: Ctx): ReturnType<typeof L>[] {
  const d = c.dev
  const trunks = d.ifaces.filter((i) => i.switchport?.mode === 'trunk')
  if (!trunks.length) return [tip('No trunks. On the uplink: switchport mode trunk')]
  const lines = [L('Port        Mode         Encapsulation  Status        Native vlan', 'info')]
  for (const t of trunks) {
    const l = linkOn(c.topo, d.id, t.name)
    const up = !!l && linkActive(c.topo, l) && !t.shutdown
    lines.push(L(`${portAbbr(t.name).padEnd(12)}on           802.1q         ${(up ? 'trunking' : 'not-connect').padEnd(14)}${t.switchport!.native ?? 1}`, up ? 'out' : 'muted'))
  }
  lines.push(L(''), L('Port        Vlans allowed on trunk', 'info'))
  for (const t of trunks) lines.push(L(`${portAbbr(t.name).padEnd(12)}${t.switchport!.allowed ? compressVlans(t.switchport!.allowed) : '1-4094'}`))
  lines.push(L(''), L('Port        Vlans allowed and active in management domain', 'info'))
  const known = [1, ...Object.keys(d.ios?.vlans ?? {}).map(Number)]
  for (const t of trunks) lines.push(L(`${portAbbr(t.name).padEnd(12)}${compressVlans(known.filter((v) => !t.switchport!.allowed || t.switchport!.allowed.includes(v)))}`))
  // The other end should be a trunk too (or a router subinterface).
  for (const t of trunks) {
    const l = linkOn(c.topo, d.id, t.name)
    if (!l) continue
    const peerEnd = l.a.device === d.id ? l.b : l.a
    const peer = getDevice(c.topo, peerEnd.device)
    if (peer?.type === 'switch' && switchport(peer, peerEnd.iface).mode !== 'trunk')
      lines.push(tip(`${peer.name} ${peerEnd.iface} is an access port: make it a trunk too, or only the native VLAN passes`))
    if (peer && isRouterLike(peer) && !peer.ifaces.some((i) => isSubIface(i.name) && physPort(i.name) === peerEnd.iface))
      lines.push(tip(`${peer.name} ${peerEnd.iface} has no subinterfaces: create ${peerEnd.iface}.10 with encapsulation dot1Q 10`))
  }
  return lines
}

function showOspfNeighbors(c: Ctx): ReturnType<typeof L>[] {
  if (!c.dev.ios?.ospf) return fail('% OSPF is not running', 'router ospf 1 → network <address> <wildcard> area 0')
  const lines = [L('Neighbor ID     Pri   State           Dead Time   Address         Interface', 'info')]
  const nbrs = protocolNeighbors(c.topo, c.dev, 'ospf')
  const myRid = routerId(c.dev, c.dev.ios.ospf.routerId) ?? '0.0.0.0'
  for (const n of nbrs.filter((x) => !x.problem)) {
    const rid = routerId(n.adj.peer, n.adj.peer.ios?.ospf?.routerId) ?? '?'
    // The higher router ID on a segment becomes DR.
    const role = rid > myRid ? 'DR' : 'BDR'
    lines.push(L(`${rid.padEnd(16)}1     ${`FULL/${role}`.padEnd(16)}00:00:3${(rid.length % 9) + 0}    ${n.adj.peerIface.ip.padEnd(16)}${longName(n.adj.iface.name)}`, 'ok'))
  }
  for (const n of nbrs.filter((x) => x.problem)) lines.push(tip(`No adjacency with ${n.adj.peer.name} on ${n.adj.iface.name}: ${n.problem}`))
  if (!nbrs.length) lines.push(tip('No OSPF router on any subnet with an OSPF-enabled interface. Check network statements on both routers.'))
  return lines
}

function showEigrpNeighbors(c: Ctx): ReturnType<typeof L>[] {
  const e = c.dev.ios?.eigrp
  if (!e) return fail('% EIGRP is not running', 'router eigrp 100 → network <address> [wildcard]')
  const lines = [L(`EIGRP-IPv4 Neighbors for AS(${e.as})`, 'info'), L('H   Address         Interface              Hold Uptime   SRTT   RTO  Q  Seq', 'info')]
  const nbrs = protocolNeighbors(c.topo, c.dev, 'eigrp')
  nbrs.filter((x) => !x.problem).forEach((n, k) => lines.push(L(`${String(k).padEnd(4)}${n.adj.peerIface.ip.padEnd(16)}${portAbbr(n.adj.iface.name).padEnd(23)}12   00:04:1${k} 1      100  0  ${10 + k}`, 'ok')))
  for (const n of nbrs.filter((x) => x.problem)) lines.push(tip(`No neighbor ${n.adj.peer.name} on ${n.adj.iface.name}: ${n.problem}`))
  if (!nbrs.length) lines.push(tip('No EIGRP router on any subnet with an EIGRP-enabled interface.'))
  return lines
}

function showProtocols(c: Ctx): ReturnType<typeof L>[] {
  const cfg = c.dev.ios ?? {}
  const lines: ReturnType<typeof L>[] = []
  const passive = (list?: string[]) => (list?.length ? [L('  Passive Interface(s):'), ...list.map((p) => L(`    ${longName(p)}`))] : [])
  if (cfg.ospf) {
    const o = cfg.ospf
    lines.push(L(`Routing Protocol is "ospf ${o.pid}"`, 'info'), L(`  Router ID ${routerId(c.dev, o.routerId) ?? '0.0.0.0'}`), L('  Routing for Networks:'))
    for (const n of o.networks) lines.push(L(`    ${n.network} ${n.wildcard} area ${n.area}`))
    lines.push(...passive(o.passive))
    if (o.defaultOriginate) lines.push(L('  Originating default route (default-information originate)'))
    lines.push(L('  Distance: (default is 110)'), L(''))
  }
  if (cfg.eigrp) {
    lines.push(L(`Routing Protocol is "eigrp ${cfg.eigrp.as}"`, 'info'), L('  Routing for Networks:'))
    for (const n of cfg.eigrp.networks) lines.push(L(`    ${n.network}${n.wildcard ? ' ' + n.wildcard : ''}`))
    lines.push(...passive(cfg.eigrp.passive), L('  Distance: internal 90 external 170'), L(''))
  }
  if (cfg.rip) {
    const v = cfg.rip.version ?? 1
    lines.push(L('Routing Protocol is "rip"', 'info'), L(`  Default version control: send version ${v}, receive ${v === 2 ? '2' : 'any version'}`), L(`  Automatic network summarization is ${cfg.rip.noAutoSummary ? 'not ' : ''}in effect`), L('  Routing for Networks:'))
    for (const n of cfg.rip.networks) lines.push(L(`    ${n}`))
    const nbrs = protocolNeighbors(c.topo, c.dev, 'rip')
    lines.push(...passive(cfg.rip.passive), L('  Routing Information Sources:'))
    for (const n of nbrs) lines.push(n.problem ? tip(`${n.adj.peer.name}: ${n.problem}`) : L(`    ${n.adj.peerIface.ip.padEnd(16)}120`))
    if (v === 1) lines.push(tip('RIP version 1 is classful (no subnet masks in updates). Use: version 2'))
    lines.push(L('  Distance: (default is 120)'), L(''))
  }
  if (cfg.bgp) {
    lines.push(L(`Routing Protocol is "bgp ${cfg.bgp.as}"`, 'info'), L('  Neighbor(s):'))
    for (const s of bgpSessions(c.topo, c.dev)) lines.push(L(`    ${s.neighbor.padEnd(16)}remote-as ${s.remoteAs}  ${s.state}`))
    lines.push(L('  Distance: external 20 internal 200 local 200'), L(''))
  }
  if (!lines.length) return [L('No dynamic routing protocol is running.'), tip('router ospf 1, router eigrp 100, router rip or router bgp 65001')]
  return lines
}

function showBgpSummary(c: Ctx): ReturnType<typeof L>[] {
  const b = c.dev.ios?.bgp
  if (!b) return fail('% BGP not active', 'router bgp <AS> → neighbor <ip> remote-as <AS>')
  const lines = [L(`BGP router identifier ${routerId(c.dev, b.routerId) ?? '0.0.0.0'}, local AS number ${b.as}`), L(''), L('Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd', 'info')]
  const table = bgpTable(c.topo, c.dev)
  for (const s of bgpSessions(c.topo, c.dev)) {
    const pfx = table.filter((p) => p.nextHop === s.neighbor && !p.local).length
    lines.push(L(`${s.neighbor.padEnd(16)}4 ${String(s.remoteAs).padStart(12)}      12      12        5    0    0 00:05:21 ${s.state === 'Established' ? pfx : s.state}`, s.state === 'Established' ? 'ok' : 'err'))
    if (s.problem) lines.push(tip(s.problem))
  }
  if (!b.neighbors.length) lines.push(tip('No neighbors: neighbor <ip> remote-as <AS>'))
  return lines
}

function showBgp(c: Ctx): ReturnType<typeof L>[] {
  const b = c.dev.ios?.bgp
  if (!b) return fail('% BGP not active')
  const lines = [L(`BGP table version is 5, local router ID is ${routerId(c.dev, b.routerId) ?? '0.0.0.0'}`), L('Status codes: * valid, > best, i - internal;  Origin codes: i - IGP', 'muted'), L(''), L('     Network          Next Hop            Metric LocPrf Weight Path', 'info')]
  for (const p of bgpTable(c.topo, c.dev).sort((x, y) => x.network.localeCompare(y.network)))
    lines.push(L(` *> ${`${p.network}/${p.prefix}`.padEnd(17)}${(p.local ? '0.0.0.0' : p.nextHop!).padEnd(20)}0      ${p.local ? '  ' : '  '}  ${p.local ? '32768' : '    0'} ${[...p.asPath].join(' ')}${p.asPath.length ? ' ' : ''}i`))
  if (lines.length === 4) lines.push(tip('Empty. Advertise a prefix this router has a route for: network <address> mask <mask>'))
  return lines
}

function showDhcpBinding(c: Ctx): ReturnType<typeof L>[] {
  const lines = [L('IP address       Client-ID/Hardware address  Lease expiration        Type       Client', 'info')]
  for (const l of activeLeases(c.topo, c.dev)) lines.push(L(`${l.ip.padEnd(17)}01${ciscoMac(l.mac).replace(/\./g, '.')}`.padEnd(45) + 'Infinite'.padEnd(24) + 'Automatic  ' + l.host))
  if (lines.length === 1) lines.push(tip('No leases yet. On a PC: dhcp (or tick DHCP in its panel)'))
  return lines
}

function showDhcpPool(c: Ctx): ReturnType<typeof L>[] {
  const s = c.dev.ios?.dhcp
  if (!s || !Object.keys(s.pools).length) return fail('% No DHCP pools', 'ip dhcp pool LAN → network 192.168.1.0 255.255.255.0 → default-router 192.168.1.1')
  const lines: ReturnType<typeof L>[] = []
  const leases = activeLeases(c.topo, c.dev)
  for (const [name, p] of Object.entries(s.pools)) {
    lines.push(L(`Pool ${name} :`, 'info'))
    lines.push(L(` Network            : ${p.network ? `${p.network} ${prefixToMask(p.prefix!)}` : '(not set)'}`))
    lines.push(L(` Default router     : ${p.router ?? '(not set)'}`))
    if (p.dns) lines.push(L(` DNS server         : ${p.dns}`))
    lines.push(L(` Total addresses    : ${poolSize(p)}`))
    lines.push(L(` Leased addresses   : ${leases.filter((l) => l.pool === name).length}`))
    if (!p.network) lines.push(tip('Give it a network: network 192.168.1.0 255.255.255.0'))
    if (!p.router) lines.push(tip('Clients need a gateway: default-router <router IP>'))
  }
  if (s.excluded.length) lines.push(L(`Excluded: ${s.excluded.map((e) => (e.from === e.to ? e.from : `${e.from} - ${e.to}`)).join(', ')}`))
  return lines
}

function showNat(c: Ctx, state: SimState): ReturnType<typeof L>[] {
  const lines = [L('Pro  Inside global         Inside local          Outside local         Outside global', 'info')]
  for (const s of c.dev.ios?.nat?.statics ?? []) lines.push(L(`---  ${s.global.padEnd(22)}${s.local.padEnd(22)}---                   ---`))
  for (const e of state.nat?.[c.dev.id] ?? []) {
    const port = e.port ? `:${e.port}` : ''
    lines.push(L(`${e.proto.slice(0, 4).padEnd(5)}${(e.insideGlobal + port).padEnd(22)}${(e.insideLocal + port).padEnd(22)}${e.outside.padEnd(22)}${e.outside}`))
  }
  if (lines.length === 1) {
    const nat = c.dev.ios?.nat
    const ins = c.dev.ifaces.filter((i) => i.nat === 'inside').length
    const outs = c.dev.ifaces.filter((i) => i.nat === 'outside').length
    if (!nat?.overload && !nat?.statics.length) lines.push(tip('No NAT rule: ip nat inside source list 1 interface g0/1 overload'))
    else if (!ins || !outs) lines.push(tip('Mark the interfaces: ip nat inside on the LAN side, ip nat outside toward the ISP'))
    else lines.push(tip('No translations yet: ping something outside from an inside host'))
  }
  return lines
}

// ---------- the commands ----------

/** `router ospf|eigrp|rip|bgp`. */
function startProcess(proto: 'ospf' | 'eigrp' | 'rip' | 'bgp'): Spec {
  const syntax = { ospf: ['<1-65535>  Process ID, e.g. router ospf 1'], eigrp: ['<1-65535>  Autonomous system number, e.g. router eigrp 100'], rip: ['<cr>'], bgp: ['<1-4294967295>  Autonomous system number, e.g. router bgp 65001'] }[proto]
  return {
    words: ['router', proto],
    modes: CFG,
    help: { ospf: 'Open Shortest Path First (OSPF)', eigrp: 'Enhanced Interior Gateway Routing Protocol (EIGRP)', rip: 'Routing Information Protocol (RIP)', bgp: 'Border Gateway Protocol (BGP)' }[proto],
    only: L3,
    syntax,
    run: (c, rest) => {
      const cfg = conf(c.dev)
      const n = Number(rest[0])
      if (proto !== 'rip' && (!Number.isInteger(n) || n < 1)) return fail('% Incomplete command.', syntax[0])
      if (proto === 'ospf') {
        if (cfg.ospf && cfg.ospf.pid !== n) return fail(`% NetSim runs one OSPF process per router (ospf ${cfg.ospf.pid} is running)`, `Use router ospf ${cfg.ospf.pid}, or no router ospf ${cfg.ospf.pid} first`)
        cfg.ospf ??= { pid: n, networks: [] }
      } else if (proto === 'eigrp') {
        if (cfg.eigrp && cfg.eigrp.as !== n) return fail(`% EIGRP AS ${cfg.eigrp.as} is already running`)
        cfg.eigrp ??= { as: n, networks: [] }
      } else if (proto === 'rip') cfg.rip ??= { networks: [] }
      else {
        if (cfg.bgp && cfg.bgp.as !== n) return fail(`% BGP is already running; AS is ${cfg.bgp.as}`)
        cfg.bgp ??= { as: n, neighbors: [], networks: [] }
      }
      c.f.mode = 'router'
      c.f.proto = proto
      return ok()
    },
  }
}

function stopProcess(proto: 'ospf' | 'eigrp' | 'rip' | 'bgp'): Spec {
  return {
    words: ['no', 'router', proto],
    modes: CFG,
    help: `Stop ${PROTO_NAME[proto]}`,
    only: L3,
    run: (c) => {
      if (!c.dev.ios?.[proto]) return fail(`% ${PROTO_NAME[proto]} is not running`)
      delete c.dev.ios[proto]
      return ok()
    },
  }
}

function passiveSpec(on: boolean): Spec {
  return {
    words: on ? ['passive-interface'] : ['no', 'passive-interface'],
    modes: RTR,
    help: on ? 'Advertise the subnet but send no updates/hellos out of this interface' : 'Send updates out of this interface again',
    syntax: ['WORD  Interface, e.g. g0/2'],
    run: (c, rest) => {
      if (c.f.proto === 'bgp') return fail('% Not used by BGP')
      const p = c.f.proto as 'ospf' | 'eigrp' | 'rip'
      const name = rest.join('').toLowerCase()
      const i = c.dev.ifaces.find((x) => x.name === name || longName(x.name).toLowerCase() === name || x.name === name.replace(/^gigabitethernet/, 'g').replace(/^fastethernet/, 'fa'))
      if (!i) return fail(`% Invalid interface. ${c.dev.name} has: ${c.dev.ifaces.map((x) => x.name).join(', ')}`)
      const cfg = c.dev.ios![p]!
      const list = new Set(cfg.passive ?? [])
      if (on) list.add(i.name)
      else list.delete(i.name)
      cfg.passive = [...list]
      return ok(on ? [tip('Passive: the subnet is still advertised, but no neighbor can form on it. Use it on LAN ports facing PCs.')] : [])
    },
  }
}

export const NET_SPECS: Spec[] = [
  // ----- VLANs (switch) -----
  {
    words: ['vlan'],
    modes: CFG,
    help: 'VLAN commands',
    only: SW,
    syntax: ['<1-4094>  VLAN ID, e.g. vlan 10 (or a list: vlan 10,20,30)'],
    run: (c, rest) => {
      const list = parseVlanList(rest.join(''))
      if (!list) return fail('% Invalid VLAN. vlan <1-4094>, e.g. vlan 10')
      const db = (conf(c.dev).vlans ??= {})
      for (const v of list) if (v !== 1 && db[v] === undefined) db[v] = `VLAN${String(v).padStart(4, '0')}`
      if (list.length === 1) {
        c.f.mode = 'vlan'
        c.f.vlan = list[0]
      }
      return ok()
    },
  },
  {
    words: ['no', 'vlan'],
    modes: CFG,
    help: 'Delete a VLAN',
    only: SW,
    run: (c, rest) => {
      const list = parseVlanList(rest.join(''))
      if (!list) return fail('% Invalid VLAN')
      if (list.includes(1)) return fail('% Default VLAN 1 may not be deleted.')
      for (const v of list) delete c.dev.ios?.vlans?.[v]
      const orphans = c.dev.ifaces.filter((i) => i.switchport?.mode === 'access' && list.includes(i.switchport.vlan ?? 1))
      return ok(orphans.length ? [tip(`${orphans.map((o) => o.name).join(', ')} are still assigned to it and are now inactive.`)] : [])
    },
  },
  {
    words: ['name'],
    modes: ['vlan'],
    help: 'Ascii name of the VLAN',
    syntax: ['WORD  The name, e.g. SALES'],
    run: (c, rest) => {
      if (!rest[0]) return fail('% Incomplete command.')
      conf(c.dev).vlans![c.f.vlan!] = rest.join('_').slice(0, 32)
      return ok()
    },
  },
  {
    words: ['switchport', 'mode'],
    modes: IF,
    help: 'Set trunking mode of the interface',
    only: SW,
    syntax: ['access  Set trunking mode to ACCESS unconditionally', 'trunk   Set trunking mode to TRUNK unconditionally'],
    run: (c, rest) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      const w = rest[0]?.toLowerCase() ?? ''
      if (w && 'access'.startsWith(w)) sp.mode = 'access'
      else if (w && 'trunk'.startsWith(w)) sp.mode = 'trunk'
      else if (w && 'dynamic'.startsWith(w)) return fail('% NetSim has no DTP: set the mode explicitly (access or trunk)')
      else return fail('% Incomplete command.')
      return ok(sp.mode === 'trunk' ? [L(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${longName(c.f.iface!)}, changed state to up`, 'info')] : [])
    },
  },
  {
    words: ['switchport', 'access', 'vlan'],
    modes: IF,
    help: 'Set VLAN when interface is in access mode',
    only: SW,
    syntax: ['<1-4094>  VLAN ID of the VLAN when this port is in access mode'],
    run: (c, rest) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      const v = vlanNum(rest[0])
      if (!v) return fail('% Invalid VLAN')
      sp.vlan = v
      const created = ensureVlan(c.dev, v)
      const lines = created ? [L(created, 'info')] : []
      if (sp.mode === 'trunk') lines.push(tip('This port is a trunk: the access VLAN applies only in access mode (switchport mode access)'))
      return ok(lines)
    },
  },
  {
    words: ['switchport', 'trunk', 'allowed', 'vlan'],
    modes: IF,
    help: 'Set allowed VLAN characteristics when interface is in trunking mode',
    only: SW,
    syntax: ['WORD    VLAN IDs, e.g. 10,20,30-35', 'add     add VLANs to the current list', 'remove  remove VLANs from the current list', 'all     all VLANs', 'none    no VLANs'],
    run: (c, rest) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      const [w, arg] = rest
      const word = w?.toLowerCase()
      if (word === 'all') delete sp.allowed
      else if (word === 'none') sp.allowed = []
      else if (word === 'add' || word === 'remove' || word === 'except') {
        const list = parseVlanList(arg ?? '')
        if (!list) return fail('% Invalid VLAN list')
        const now = new Set(sp.allowed ?? Array.from({ length: 4094 }, (_, k) => k + 1))
        if (word === 'add') list.forEach((v) => now.add(v))
        else if (word === 'remove') list.forEach((v) => now.delete(v))
        else {
          now.clear()
          for (let v = 1; v <= 4094; v++) if (!list.includes(v)) now.add(v)
        }
        sp.allowed = now.size === 4094 ? undefined : [...now].sort((a, b) => a - b)
        if (!sp.allowed) delete sp.allowed
      } else {
        const list = parseVlanList(w ?? '')
        if (!list) return fail('% Incomplete command.', 'switchport trunk allowed vlan 10,20')
        sp.allowed = list
      }
      const lines = sp.mode !== 'trunk' ? [tip('Only used once the port is a trunk: switchport mode trunk')] : []
      if (sp.allowed && !sp.allowed.includes(sp.native ?? 1)) lines.push(tip(`The native VLAN ${sp.native ?? 1} is not allowed: untagged frames are dropped`))
      return ok(lines)
    },
  },
  {
    words: ['switchport', 'trunk', 'native', 'vlan'],
    modes: IF,
    help: 'Set native VLAN when interface is in trunking mode',
    only: SW,
    syntax: ['<1-4094>  VLAN ID of the native VLAN'],
    run: (c, rest) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      const v = vlanNum(rest[0])
      if (!v) return fail('% Invalid VLAN')
      sp.native = v
      return ok([tip('The native VLAN must match on both ends of the trunk, or frames leak between VLANs.')])
    },
  },
  { words: ['switchport', 'trunk', 'encapsulation'], modes: IF, help: 'Set trunking encapsulation (NetSim: always dot1q)', only: SW, syntax: ['dot1q  Interface uses only 802.1q trunking encapsulation'], run: () => [] },
  { words: ['switchport', 'nonegotiate'], modes: IF, help: 'Device will not engage in negotiation protocol on this interface', only: SW, run: () => [] },
  {
    words: ['no', 'switchport', 'access', 'vlan'],
    modes: IF,
    help: 'Back to VLAN 1',
    only: SW,
    run: (c) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      delete sp.vlan
      return ok()
    },
  },
  {
    words: ['no', 'switchport', 'trunk', 'allowed', 'vlan'],
    modes: IF,
    help: 'Allow all VLANs',
    only: SW,
    run: (c) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      delete sp.allowed
      return ok()
    },
  },
  {
    words: ['no', 'switchport', 'trunk', 'native', 'vlan'],
    modes: IF,
    help: 'Native VLAN back to 1',
    only: SW,
    run: (c) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      delete sp.native
      return ok()
    },
  },
  {
    words: ['no', 'switchport', 'mode'],
    modes: IF,
    help: 'Back to an access port',
    only: SW,
    run: (c) => {
      const sp = portSettings(c)
      if (typeof sp === 'string') return fail(sp)
      sp.mode = 'access'
      return ok()
    },
  },
  {
    words: ['ip', 'default-gateway'],
    modes: CFG,
    help: 'Default gateway for the switch\'s own traffic (management)',
    only: SW,
    syntax: ['A.B.C.D  IP address of the default gateway'],
    run: (c, rest) => {
      if (!rest[0] || !isValidIp(rest[0])) return fail('% Incomplete command.')
      c.dev.gateway = rest[0]
      return ok()
    },
  },
  { words: ['no', 'ip', 'default-gateway'], modes: CFG, help: 'Remove the default gateway', only: SW, run: (c) => (delete c.dev.gateway, ok()) },
  {
    words: ['ip', 'routing'],
    modes: CFG,
    help: 'Enable IP routing',
    only: SW,
    run: () => fail('% This is a layer 2 switch (NS-2960): it cannot route.', 'Route between VLANs with a router on a stick: router g0/0.10 → encapsulation dot1Q 10 → ip address …'),
  },

  // ----- router-on-a-stick -----
  {
    words: ['encapsulation', 'dot1q'],
    modes: IF,
    help: 'IEEE 802.1Q Virtual LAN (subinterfaces)',
    only: L3,
    syntax: ['<1-4094>  VLAN ID, e.g. encapsulation dot1Q 10', '<1-4094> native  This VLAN is the trunk\'s native (untagged) VLAN'],
    run: (c, rest) => {
      const i = cur(c)
      if (!isSubIface(i.name)) return fail('% Configure encapsulation on a subinterface', `interface ${i.name}.10 → encapsulation dot1Q 10`)
      const v = vlanNum(rest[0])
      if (!v) return fail('% Invalid VLAN')
      const taken = c.dev.ifaces.find((o) => o !== i && isSubIface(o.name) && physPort(o.name) === physPort(i.name) && o.vlan === v)
      if (taken) return fail(`% VLAN ${v} is already used by ${longName(taken.name)}`)
      i.vlan = v
      if (rest[1]?.toLowerCase().startsWith('nat')) i.nativeVlan = true
      else delete i.nativeVlan
      return ok()
    },
  },

  // ----- routing protocols -----
  startProcess('ospf'),
  startProcess('eigrp'),
  startProcess('rip'),
  startProcess('bgp'),
  stopProcess('ospf'),
  stopProcess('eigrp'),
  stopProcess('rip'),
  stopProcess('bgp'),
  {
    words: ['network'],
    modes: RTR,
    help: 'Enable routing on the interfaces in this network',
    syntax: ['A.B.C.D  Network address', '  ospf:  network 10.0.0.0 0.0.0.255 area 0', '  eigrp: network 10.0.0.0 [0.0.0.255]', '  rip:   network 10.0.0.0', '  bgp:   network 10.1.0.0 mask 255.255.255.0'],
    run: (c, rest) => {
      const st = parseNetworkStatement(c, rest)
      if (typeof st === 'string') return fail(st)
      const { p, cfg } = proc(c)
      if (p === 'bgp') {
        const b = c.dev.ios!.bgp!
        const n = st as { network: string; prefix: number }
        if (!b.networks.some((x) => x.network === n.network && x.prefix === n.prefix)) b.networks.push(n)
        const has = configuredRoute(c, n.network, n.prefix)
        return ok(has ? [] : [tip(`BGP only advertises ${n.network}/${n.prefix} if this router has that exact route (connected, static or IGP).`)])
      }
      if (p === 'rip') {
        const r = c.dev.ios!.rip!
        const n = (st as NetworkStatement).network
        if (!r.networks.includes(n)) r.networks.push(n)
      } else {
        const list = (cfg as { networks: NetworkStatement[] }).networks
        const s = st as NetworkStatement
        if (!list.some((x) => x.network === s.network && x.wildcard === s.wildcard && x.area === s.area)) list.push(s)
      }
      const enabled = c.dev.ifaces.filter((i) => configured(c.dev, i) && matchesStatement(i.ip!, st as NetworkStatement))
      if (!enabled.length) return ok([tip(`No interface of ${c.dev.name} is in ${(st as NetworkStatement).network} yet, so nothing is enabled.`)])
      return ok([tip(`${PROTO_NAME[p]} now runs on ${enabled.map((i) => i.name).join(', ')}. ${routeTip(c).join('')}`)])
    },
  },
  {
    words: ['no', 'network'],
    modes: RTR,
    help: 'Remove a network statement',
    run: (c, rest) => {
      const st = parseNetworkStatement(c, rest)
      if (typeof st === 'string') return fail(st)
      const { p } = proc(c)
      const cfg = c.dev.ios!
      if (p === 'bgp') cfg.bgp!.networks = cfg.bgp!.networks.filter((x) => !(x.network === (st as { network: string }).network))
      else if (p === 'rip') cfg.rip!.networks = cfg.rip!.networks.filter((x) => x !== (st as NetworkStatement).network)
      else {
        const o = cfg[p]!
        o.networks = o.networks.filter((x) => !(x.network === (st as NetworkStatement).network && (x.wildcard ?? '') === ((st as NetworkStatement).wildcard ?? '')))
      }
      return ok()
    },
  },
  {
    words: ['router-id'],
    modes: RTR,
    help: 'Router ID for this OSPF process (else: highest loopback, then highest interface IP)',
    syntax: ['A.B.C.D  OSPF router ID in IP address format'],
    run: (c, rest) => {
      if (c.f.proto !== 'ospf') return fail(`% Use ${c.f.proto === 'bgp' ? 'bgp' : 'eigrp'} router-id`)
      if (!rest[0] || !isValidIp(rest[0])) return fail('% Incomplete command.')
      c.dev.ios!.ospf!.routerId = rest[0]
      return ok([L('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect', 'info')])
    },
  },
  ...(['eigrp', 'bgp'] as const).map(
    (p): Spec => ({
      words: [p, 'router-id'],
      modes: RTR,
      help: `Router ID for ${PROTO_NAME[p]}`,
      syntax: ['A.B.C.D  Router ID'],
      run: (c, rest) => {
        if (c.f.proto !== p) return fail(`% Not in router ${p} mode`)
        if (!rest[0] || !isValidIp(rest[0])) return fail('% Incomplete command.')
        c.dev.ios![p]!.routerId = rest[0]
        return ok()
      },
    }),
  ),
  passiveSpec(true),
  passiveSpec(false),
  {
    words: ['default-information', 'originate'],
    modes: RTR,
    help: 'Advertise this router\'s default route (ip route 0.0.0.0 0.0.0.0 …) to its neighbors',
    run: (c) => {
      if (c.f.proto !== 'ospf' && c.f.proto !== 'rip') return fail('% NetSim supports default-information originate for OSPF and RIP')
      c.dev.ios![c.f.proto]!.defaultOriginate = true
      const has = c.dev.routes.some((r) => r.prefix === 0) || c.dev.ifaces.some((i) => i.dhcpGateway)
      return ok(has ? [] : [tip('This router has no default route yet, so there is nothing to advertise: ip route 0.0.0.0 0.0.0.0 <ISP next hop>')])
    },
  },
  {
    words: ['no', 'default-information', 'originate'],
    modes: RTR,
    help: 'Stop advertising the default route',
    run: (c) => {
      if (c.f.proto === 'ospf' || c.f.proto === 'rip') delete c.dev.ios![c.f.proto]!.defaultOriginate
      return ok()
    },
  },
  {
    words: ['version'],
    modes: RTR,
    help: 'Set routing protocol version (RIP)',
    syntax: ['<1-2>  version'],
    run: (c, rest) => {
      if (c.f.proto !== 'rip') return fail('% version is a RIP command')
      if (rest[0] !== '1' && rest[0] !== '2') return fail('% Incomplete command.')
      c.dev.ios!.rip!.version = Number(rest[0]) as 1 | 2
      return ok(rest[0] === '1' ? [tip('RIPv1 is classful: it can\'t carry subnet masks. Use version 2.')] : [])
    },
  },
  {
    words: ['auto-summary'],
    modes: RTR,
    help: 'Summarize subnets to classful networks (NetSim keeps routes unsummarized)',
    run: (c) => {
      if (c.f.proto === 'rip') delete c.dev.ios!.rip!.noAutoSummary
      return [tip('NetSim does not summarize routes; no auto-summary is recommended anyway.')]
    },
  },
  {
    words: ['no', 'auto-summary'],
    modes: RTR,
    help: 'Advertise subnets as they are',
    run: (c) => {
      if (c.f.proto === 'rip') c.dev.ios!.rip!.noAutoSummary = true
      return ok()
    },
  },
  {
    words: ['neighbor'],
    modes: RTR,
    help: 'Specify a BGP neighbor',
    syntax: ['A.B.C.D remote-as <AS>  e.g. neighbor 203.0.113.1 remote-as 65000'],
    run: (c, rest) => {
      if (c.f.proto !== 'bgp') return fail('% neighbor is a BGP command (OSPF, EIGRP and RIP find neighbors by themselves)')
      const [ip, kw, as] = rest
      if (!ip || !isValidIp(ip) || !kw || !'remote-as'.startsWith(kw.toLowerCase()) || !as) return fail('% Incomplete command.', 'neighbor <ip> remote-as <AS>')
      const n = Number(as)
      if (!Number.isInteger(n) || n < 1) return fail('% Invalid AS')
      const b = c.dev.ios!.bgp!
      b.neighbors = b.neighbors.filter((x) => x.ip !== ip)
      b.neighbors.push({ ip, remoteAs: n })
      return ok([tip(n === b.as ? 'Same AS: an iBGP session.' : 'Different AS: an eBGP session.'), tip('Check it with: do show ip bgp summary')])
    },
  },
  {
    words: ['no', 'neighbor'],
    modes: RTR,
    help: 'Remove a BGP neighbor',
    run: (c, rest) => {
      if (c.f.proto !== 'bgp') return fail('% Not in router bgp mode')
      c.dev.ios!.bgp!.neighbors = c.dev.ios!.bgp!.neighbors.filter((x) => x.ip !== rest[0])
      return ok()
    },
  },
  {
    words: ['redistribute'],
    modes: RTR,
    help: 'Redistribute information from another routing protocol',
    run: () => fail('% NetSim does not redistribute between protocols yet.', 'Use network statements, or default-information originate for a default route.'),
  },
  {
    words: ['ip', 'ospf', 'cost'],
    modes: IF,
    help: 'Interface cost',
    only: L3,
    syntax: ['<1-65535>  Cost'],
    run: (c, rest) => {
      const n = Number(rest[0])
      if (!Number.isInteger(n) || n < 1 || n > 65535) return fail('% Invalid cost')
      cur(c).ospfCost = n
      return ok()
    },
  },
  { words: ['no', 'ip', 'ospf', 'cost'], modes: IF, help: 'Default cost', only: L3, run: (c) => (delete cur(c).ospfCost, ok()) },

  // ----- DHCP server and relay -----
  {
    words: ['ip', 'dhcp', 'pool'],
    modes: CFG,
    help: 'Configure a DHCP address pool',
    only: L3,
    syntax: ['WORD  Pool name, e.g. ip dhcp pool LAN'],
    run: (c, rest) => {
      if (!rest[0] || !/^[\w.-]+$/.test(rest[0])) return fail('% Incomplete command.')
      dhcpOf(c.dev).pools[rest[0]] ??= {}
      c.f.mode = 'dhcp'
      c.f.pool = rest[0]
      return ok()
    },
  },
  {
    words: ['no', 'ip', 'dhcp', 'pool'],
    modes: CFG,
    help: 'Delete a DHCP pool',
    only: L3,
    run: (c, rest) => {
      const s = c.dev.ios?.dhcp
      if (!rest[0] || !s?.pools[rest[0]]) return fail(`% Pool ${rest[0] ?? ''} does not exist`)
      delete s.pools[rest[0]]
      return ok()
    },
  },
  {
    words: ['ip', 'dhcp', 'excluded-address'],
    modes: CFG,
    help: 'Addresses the DHCP server must not hand out',
    only: L3,
    syntax: ['A.B.C.D [A.B.C.D]  First (and last) address, e.g. ip dhcp excluded-address 192.168.1.1 192.168.1.10'],
    run: (c, rest) => {
      const [a, b] = rest
      if (!a || !isValidIp(a) || (b && !isValidIp(b))) return fail('% Incomplete command.')
      dhcpOf(c.dev).excluded.push({ from: a, to: b ?? a })
      return ok()
    },
  },
  {
    words: ['no', 'ip', 'dhcp', 'excluded-address'],
    modes: CFG,
    help: 'Remove an excluded range',
    only: L3,
    run: (c, rest) => {
      const s = dhcpOf(c.dev)
      s.excluded = s.excluded.filter((e) => !(e.from === rest[0] && e.to === (rest[1] ?? rest[0])))
      return ok()
    },
  },
  {
    words: ['network'],
    modes: ['dhcp'],
    help: 'Network number and mask of the pool',
    syntax: ['A.B.C.D  Network, e.g. network 192.168.1.0 255.255.255.0 (or /24)'],
    run: (c, rest) => {
      const [net, m] = rest
      if (!net || !isValidIp(net)) return fail('% Incomplete command.')
      const prefix = m === undefined ? null : /^\/\d+$/.test(m) ? Number(m.slice(1)) : maskToPrefix(m)
      if (prefix === null || prefix > 30) return fail('% Bad mask', 'network 192.168.1.0 255.255.255.0')
      const p = dhcpOf(c.dev).pools[c.f.pool!]
      p.network = networkOf(net, prefix)
      p.prefix = prefix
      const local = c.dev.ifaces.some((i) => i.ip && inSubnet(i.ip, p.network!, prefix))
      return ok(local ? [] : [tip(`${c.dev.name} has no interface in ${p.network}/${prefix}: clients there reach this pool only through a relay (ip helper-address on their gateway).`)])
    },
  },
  {
    words: ['default-router'],
    modes: ['dhcp'],
    help: 'Default gateway handed to clients',
    syntax: ['A.B.C.D  The router\'s address in the pool network'],
    run: (c, rest) => {
      if (!rest[0] || !isValidIp(rest[0])) return fail('% Incomplete command.')
      const p = dhcpOf(c.dev).pools[c.f.pool!]
      p.router = rest[0]
      return ok(p.network && !inSubnet(rest[0], p.network, p.prefix!) ? [tip(`${rest[0]} is not in ${p.network}/${p.prefix}: clients can't use it as a gateway.`)] : [])
    },
  },
  {
    words: ['dns-server'],
    modes: ['dhcp'],
    help: 'DNS server handed to clients',
    syntax: ['A.B.C.D  e.g. dns-server 8.8.8.8'],
    run: (c, rest) => {
      if (!rest[0] || !isValidIp(rest[0])) return fail('% Incomplete command.')
      dhcpOf(c.dev).pools[c.f.pool!].dns = rest[0]
      return ok()
    },
  },
  {
    words: ['domain-name'],
    modes: ['dhcp'],
    help: 'Domain name handed to clients',
    syntax: ['WORD  e.g. lab.local'],
    run: (c, rest) => {
      if (!rest[0]) return fail('% Incomplete command.')
      dhcpOf(c.dev).pools[c.f.pool!].domain = rest[0]
      return ok()
    },
  },
  { words: ['lease'], modes: ['dhcp'], help: 'Lease time (NetSim leases do not expire)', syntax: ['<0-365>  Days'], run: () => [] },
  {
    words: ['ip', 'helper-address'],
    modes: IF,
    help: 'Relay DHCP broadcasts heard on this interface to a server',
    only: L3,
    syntax: ['A.B.C.D  DHCP server address'],
    run: (c, rest) => {
      if (!rest[0] || !isValidIp(rest[0])) return fail('% Incomplete command.')
      cur(c).helper = rest[0]
      return ok()
    },
  },
  { words: ['no', 'ip', 'helper-address'], modes: IF, help: 'Stop relaying DHCP', only: L3, run: (c) => (delete cur(c).helper, ok()) },
  {
    words: ['show', 'ip', 'dhcp', 'binding'],
    modes: EXEC,
    help: 'DHCP address bindings',
    only: L3,
    run: (c) => showDhcpBinding(c),
  },
  { words: ['show', 'ip', 'dhcp', 'pool'], modes: EXEC, help: 'DHCP pools', only: L3, run: (c) => showDhcpPool(c) },
  {
    words: ['clear', 'ip', 'dhcp', 'binding'],
    modes: PRIV,
    help: 'Forget all leases',
    only: L3,
    run: (c) => {
      dhcpOf(c.dev).leases = []
      return ok()
    },
  },

  // ----- access lists and NAT -----
  {
    words: ['access-list'],
    modes: CFG,
    help: 'Add a standard access list entry',
    only: L3,
    syntax: ['<1-99> permit|deny <source> [wildcard]  e.g. access-list 1 permit 192.168.1.0 0.0.0.255', '<1-99> permit any', '<1-99> permit host 192.168.1.10'],
    run: (c, rest) => {
      const [num, act, a, b] = rest
      const n = Number(num)
      if (!Number.isInteger(n) || n < 1 || n > 99) return fail('% NetSim supports standard access lists 1-99')
      const action = act && 'permit'.startsWith(act.toLowerCase()) ? 'permit' : act && 'deny'.startsWith(act.toLowerCase()) ? 'deny' : null
      if (!action) return fail('% Incomplete command.', 'access-list 1 permit 192.168.1.0 0.0.0.255')
      let entry
      if (a?.toLowerCase() === 'any') entry = { action, src: 'any' } as const
      else if (a?.toLowerCase() === 'host' && b && isValidIp(b)) entry = { action, src: b } as const
      else if (a && isValidIp(a)) {
        if (b && wildcardPrefix(b) === null) return fail(`% ${b} is not a wildcard mask (0.0.0.255 for a /24)`, ...(maskToPrefix(b) !== null ? [`That looks like a subnet mask. ACLs use wildcards: ${b.split('.').map((o) => 255 - Number(o)).join('.')}`] : []))
        entry = b ? ({ action, src: a, wildcard: b } as const) : ({ action, src: a } as const)
      } else return fail('% Incomplete command.')
      ;((conf(c.dev).acls ??= {})[n] ??= []).push(entry)
      return ok()
    },
  },
  {
    words: ['no', 'access-list'],
    modes: CFG,
    help: 'Delete an access list',
    only: L3,
    run: (c, rest) => {
      delete c.dev.ios?.acls?.[Number(rest[0])]
      return ok()
    },
  },
  {
    words: ['show', 'access-lists'],
    modes: EXEC,
    help: 'List access lists',
    only: L3,
    run: (c) => {
      const acls = Object.entries(c.dev.ios?.acls ?? {})
      if (!acls.length) return [tip('No access lists. access-list 1 permit 192.168.1.0 0.0.0.255')]
      return acls.flatMap(([n, list]) => [
        L(`Standard IP access list ${n}`, 'info'),
        ...list.map((e, k) => L(`    ${(k + 1) * 10} ${e.action} ${e.src === 'any' ? 'any' : e.wildcard ? `${e.src}, wildcard bits ${e.wildcard}` : e.src}`)),
      ])
    },
  },
  ...(['inside', 'outside'] as const).flatMap((side): Spec[] => [
    {
      words: ['ip', 'nat', side],
      modes: IF,
      help: side === 'inside' ? 'Inside interface for address translation (the LAN)' : 'Outside interface for address translation (toward the Internet)',
      only: L3,
      run: (c) => {
        cur(c).nat = side
        return ok()
      },
    },
    { words: ['no', 'ip', 'nat', side], modes: IF, help: 'Stop translating on this interface', only: L3, run: (c) => (delete cur(c).nat, ok()) },
  ]),
  {
    words: ['ip', 'nat', 'inside', 'source'],
    modes: CFG,
    help: 'Translate inside source addresses',
    only: L3,
    syntax: ['list <acl> interface <iface> overload  PAT: share the outside interface\'s address', 'static <local> <global>               One-to-one mapping'],
    run: (c, rest) => {
      const nat = (conf(c.dev).nat ??= { statics: [] })
      const w = rest[0]?.toLowerCase()
      if (w === 'static') {
        const [, local, global] = rest
        if (!local || !global || !isValidIp(local) || !isValidIp(global)) return fail('% Incomplete command.', 'ip nat inside source static 192.168.1.10 203.0.113.10')
        nat.statics = nat.statics.filter((s) => s.local !== local)
        nat.statics.push({ local, global })
        return ok()
      }
      if (w === 'list') {
        const acl = Number(rest[1])
        const kw = rest[2]?.toLowerCase()
        if (!Number.isInteger(acl) || !kw || !'interface'.startsWith(kw)) return fail('% Incomplete command.', 'ip nat inside source list 1 interface g0/1 overload')
        const tail = rest.slice(3)
        const over = tail.findIndex((t) => 'overload'.startsWith(t.toLowerCase()) && t.length > 1)
        const nameTokens = over >= 0 ? tail.slice(0, over) : tail
        const i = c.dev.ifaces.find((x) => x.name === nameTokens.join('').toLowerCase().replace(/^gigabitethernet/, 'g').replace(/^gi(?=\d)/, 'g').replace(/^fastethernet/, 'fa'))
        if (!i) return fail(`% Invalid interface. ${c.dev.name} has: ${c.dev.ifaces.map((x) => x.name).join(', ')}`)
        if (over < 0) return fail('% NetSim needs overload here (address pools are not supported)', `ip nat inside source list ${acl} interface ${i.name} overload`)
        nat.overload = { acl, iface: i.name }
        const lines = []
        if (!c.dev.ios?.acls?.[acl]) lines.push(tip(`Access list ${acl} doesn't exist yet: access-list ${acl} permit 192.168.1.0 0.0.0.255`))
        if (i.nat !== 'outside') lines.push(tip(`Mark ${i.name} as outside: interface ${i.name} → ip nat outside`))
        return ok(lines)
      }
      return fail('% Incomplete command.')
    },
  },
  {
    words: ['no', 'ip', 'nat', 'inside', 'source'],
    modes: CFG,
    help: 'Remove a NAT rule',
    only: L3,
    run: (c, rest) => {
      const nat = c.dev.ios?.nat
      if (!nat) return []
      if (rest[0]?.toLowerCase() === 'static') nat.statics = nat.statics.filter((s) => s.local !== rest[1])
      else delete nat.overload
      return ok()
    },
  },

  // ----- show -----
  { words: ['show', 'vlan'], modes: EXEC, help: 'VTP VLAN status', only: SW, syntax: ['brief  VTP all VLAN status in brief', '<cr>'], run: (c) => showVlan(c) },
  { words: ['show', 'interfaces', 'trunk'], modes: EXEC, help: 'Show interface trunk information', only: SW, run: (c) => showTrunk(c) },
  { words: ['show', 'ip', 'ospf', 'neighbor'], modes: EXEC, help: 'OSPF neighbor list', only: L3, run: (c) => showOspfNeighbors(c) },
  {
    words: ['show', 'ip', 'ospf', 'interface'],
    modes: EXEC,
    help: 'OSPF interface information',
    only: L3,
    syntax: ['brief  Brief summary of OSPF interfaces', '<cr>'],
    run: (c) => {
      const o = c.dev.ios?.ospf
      if (!o) return fail('% OSPF is not running')
      const lines = [L('Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C', 'info')]
      const nbrs = protocolNeighbors(c.topo, c.dev, 'ospf').filter((n) => !n.problem)
      for (const i of c.dev.ifaces) {
        if (!configured(c.dev, i)) continue
        const st = o.networks.find((n) => matchesStatement(i.ip!, n))
        if (!st) continue
        const count = nbrs.filter((n) => n.adj.iface.name === i.name).length
        const passive = o.passive?.includes(i.name)
        lines.push(L(`${portAbbr(i.name).padEnd(13)}${String(o.pid).padEnd(6)}${String(st.area ?? 0).padEnd(16)}${`${i.ip}/${i.prefix}`.padEnd(19)}${String(ospfCost(i)).padEnd(6)}${(i.name === 'lo0' ? 'LOOP' : passive ? 'DOWN' : count ? 'DR' : 'WAIT').padEnd(6)}${count}/${count}`))
      }
      return lines
    },
  },
  { words: ['show', 'ip', 'eigrp', 'neighbors'], modes: EXEC, help: 'EIGRP neighbors', only: L3, run: (c) => showEigrpNeighbors(c) },
  { words: ['show', 'ip', 'protocols'], modes: EXEC, help: 'IP routing protocol process parameters and statistics', only: L3, run: (c) => showProtocols(c) },
  { words: ['show', 'ip', 'bgp', 'summary'], modes: EXEC, help: 'Summary of BGP neighbor status', only: L3, run: (c) => showBgpSummary(c) },
  { words: ['show', 'ip', 'bgp'], modes: EXEC, help: 'BGP table', only: L3, run: (c) => showBgp(c) },
  { words: ['show', 'ip', 'nat', 'translations'], modes: EXEC, help: 'Translation entries', only: L3, run: (c) => showNat(c, c.state) },
  {
    words: ['clear', 'ip', 'nat', 'translation'],
    modes: PRIV,
    help: 'Clear dynamic translations',
    only: L3,
    syntax: ['*  Delete all dynamic translations'],
    run: (c) => (((c.state.nat ??= {})[c.dev.id] = []), []),
  },
]

/** Whether a network statement covers an address (OSPF/EIGRP wildcard, or classful). */
function matchesStatement(ip: string, st: NetworkStatement): boolean {
  if (st.wildcard) {
    const care = st.wildcard.split('.').map((o) => 255 - Number(o))
    const a = ip.split('.').map(Number)
    const b = st.network.split('.').map(Number)
    return a.every((o, k) => (o & care[k]) === (b[k] & care[k]))
  }
  return classfulNetwork(ip) === classfulNetwork(st.network)
}

function configuredRoute(c: Ctx, network: string, prefix: number) {
  return c.dev.ifaces.some((i) => configured(c.dev, i) && networkOf(i.ip!, i.prefix!) === network && i.prefix === prefix) || c.dev.routes.some((r) => r.network === network && r.prefix === prefix)
}

/** `ip address dhcp`: the interface asks a DHCP server for its address. */
export function ipAddressDhcp(c: Ctx): Result {
  const i = cur(c)
  const r = dhcpRequest(c.topo, c.state, c.dev, i.name)
  if (!r.ok) {
    // IOS keeps trying in the background: the interface stays set to DHCP.
    delete i.ip
    delete i.prefix
    i.dhcp = true
    return { lines: [...r.lines, tip('The interface stays on DHCP. Fix the problem, then: no ip address, ip address dhcp')], mutated: true }
  }
  return {
    lines: [L(`%DHCP-6-ADDRESS_ASSIGN: Interface ${longName(i.name)} assigned DHCP address ${r.ip}, mask ${prefixToMask(r.prefix!)}, hostname ${c.dev.name}`, 'info'), ...r.lines.filter((l) => l.kind === 'muted' && l.text.includes('↳'))],
    mutated: true,
  }
}

// ---------- running-config ----------

/** Lines before the interfaces: VLANs and DHCP. */
export function configHead(dev: Device): string[] {
  const out: string[] = []
  const c = dev.ios ?? {}
  for (const [v, name] of Object.entries(c.vlans ?? {})) out.push(`vlan ${v}`, ` name ${name}`, '!')
  for (const e of c.dhcp?.excluded ?? []) out.push(`ip dhcp excluded-address ${e.from}${e.to !== e.from ? ' ' + e.to : ''}`)
  if (c.dhcp?.excluded.length) out.push('!')
  for (const [name, p] of Object.entries(c.dhcp?.pools ?? {})) {
    out.push(`ip dhcp pool ${name}`)
    if (p.network) out.push(` network ${p.network} ${prefixToMask(p.prefix!)}`)
    if (p.router) out.push(` default-router ${p.router}`)
    if (p.dns) out.push(` dns-server ${p.dns}`)
    if (p.domain) out.push(` domain-name ${p.domain}`)
    out.push('!')
  }
  return out
}

/** Extra lines inside an interface block. */
export function configIface(dev: Device, i: Iface): string[] {
  const out: string[] = []
  if (isSubIface(i.name) && i.vlan !== undefined) out.push(` encapsulation dot1Q ${i.vlan}${i.nativeVlan ? ' native' : ''}`)
  const sp = i.switchport
  if (dev.type === 'switch' && sp && !isSvi(i.name)) {
    if (sp.mode === 'trunk') {
      if (sp.native && sp.native !== 1) out.push(` switchport trunk native vlan ${sp.native}`)
      if (sp.allowed) out.push(` switchport trunk allowed vlan ${sp.allowed.length ? compressVlans(sp.allowed) : 'none'}`)
      out.push(' switchport mode trunk')
    } else {
      if ((sp.vlan ?? 1) !== 1) out.push(` switchport access vlan ${sp.vlan}`)
      out.push(' switchport mode access')
    }
  }
  if (i.helper) out.push(` ip helper-address ${i.helper}`)
  if (i.nat) out.push(` ip nat ${i.nat}`)
  if (i.ospfCost) out.push(` ip ospf cost ${i.ospfCost}`)
  return out
}

/** Lines after the interfaces: routing processes, NAT, ACLs, default gateway. */
export function configTail(dev: Device): string[] {
  const out: string[] = []
  const c = dev.ios ?? {}
  const passive = (list?: string[]) => (list ?? []).map((p) => ` passive-interface ${longName(p)}`)
  if (c.eigrp) {
    out.push(`router eigrp ${c.eigrp.as}`)
    if (c.eigrp.routerId) out.push(` eigrp router-id ${c.eigrp.routerId}`)
    out.push(...passive(c.eigrp.passive), ...c.eigrp.networks.map((n) => ` network ${n.network}${n.wildcard ? ' ' + n.wildcard : ''}`), '!')
  }
  if (c.ospf) {
    out.push(`router ospf ${c.ospf.pid}`)
    if (c.ospf.routerId) out.push(` router-id ${c.ospf.routerId}`)
    out.push(...passive(c.ospf.passive), ...c.ospf.networks.map((n) => ` network ${n.network} ${n.wildcard} area ${n.area}`))
    if (c.ospf.defaultOriginate) out.push(' default-information originate')
    out.push('!')
  }
  if (c.rip) {
    out.push('router rip')
    if (c.rip.version) out.push(` version ${c.rip.version}`)
    out.push(...passive(c.rip.passive), ...c.rip.networks.map((n) => ` network ${n}`))
    if (c.rip.defaultOriginate) out.push(' default-information originate')
    if (c.rip.noAutoSummary) out.push(' no auto-summary')
    out.push('!')
  }
  if (c.bgp) {
    out.push(`router bgp ${c.bgp.as}`)
    if (c.bgp.routerId) out.push(` bgp router-id ${c.bgp.routerId}`)
    out.push(...c.bgp.neighbors.map((n) => ` neighbor ${n.ip} remote-as ${n.remoteAs}`), ...c.bgp.networks.map((n) => ` network ${n.network} mask ${prefixToMask(n.prefix)}`), '!')
  }
  if (c.nat?.overload) out.push(`ip nat inside source list ${c.nat.overload.acl} interface ${longName(c.nat.overload.iface)} overload`)
  for (const s of c.nat?.statics ?? []) out.push(`ip nat inside source static ${s.local} ${s.global}`)
  if (c.nat?.overload || c.nat?.statics.length) out.push('!')
  for (const [n, list] of Object.entries(c.acls ?? {}))
    for (const e of list) out.push(`access-list ${n} ${e.action} ${e.src === 'any' ? 'any' : e.wildcard ? `${e.src} ${e.wildcard}` : `host ${e.src}`}`)
  if (Object.keys(c.acls ?? {}).length) out.push('!')
  if (dev.type === 'switch' && dev.gateway) out.push(`ip default-gateway ${dev.gateway}`, '!')
  return out
}
