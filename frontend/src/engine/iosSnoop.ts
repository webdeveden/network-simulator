/**
 * Two switch defences against layer-2 attacks, both CCNA security topics:
 *
 *  - DHCP snooping (`ip dhcp snooping`): the switch only believes DHCP server
 *    replies (OFFER/ACK) on ports you mark `trust` (the uplink to the real server).
 *    On every other port it drops rogue server replies and rate-limits DISCOVER
 *    floods, and it builds a binding table of IP↔MAC↔port from the real leases.
 *  - Dynamic ARP Inspection (`ip arp inspection vlan N`): on untrusted ports it
 *    checks each ARP against that snooping table and drops forged ones, which stops
 *    ARP spoofing / man-in-the-middle.
 *
 * The commands and `show` output live here; the attack engine (attacks.ts) reads
 * this config to decide whether a layer-2 attack is stopped.
 */
import { fail, L, longName, tip, type Ctx, type Mode, type Result, type Spec } from './iosBase'
import type { Device, Iface } from './types'

const CFG: Mode[] = ['config']
const IF: Mode[] = ['if']
const EXEC: Mode[] = ['user', 'priv']
const SW: Device['type'][] = ['switch']

const ok = (lines: ReturnType<typeof L>[] = []): Result => ({ lines, mutated: true })
const cur = (c: Ctx): Iface => c.dev.ifaces.find((i) => i.name === c.f.iface)!
const portAbbr = (n: string) => n.replace(/^fa/, 'Fa').replace(/^g(?=\d)/, 'Gi')

/** `1`, `1,10,20` or `10-12` -> VLAN ids, or null. */
function vlanList(text: string | undefined): number[] | null {
  if (!text) return null
  const out: number[] = []
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return null
    for (let v = Number(m[1]); v <= Number(m[2] ?? m[1]); v++) if (v >= 1 && v <= 4094) out.push(v)
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null
}

/** Access ports that carry a snooped VLAN but aren't trusted: where rogue servers would be caught. */
function untrustedAccess(d: Device): Iface[] {
  return d.ifaces.filter((i) => (i.name.startsWith('fa') || i.name.startsWith('g')) && !i.snoopTrust)
}

export const SNOOP_SPECS: Spec[] = [
  {
    words: ['ip', 'dhcp', 'snooping'],
    modes: CFG,
    help: 'Trust DHCP only on the uplink; drop rogue servers elsewhere (global switch on)',
    only: SW,
    run: (c) => {
      const s = ((c.dev.ios ??= {}).dhcpSnoop ??= { vlans: [] })
      const lines = [tip('Now say which VLANs to watch: ip dhcp snooping vlan <list>, then trust the uplink: interface <uplink> → ip dhcp snooping trust')]
      if (!untrustedAccess(c.dev).some((i) => i.snoopTrust)) lines.push(tip('Until a port is trusted, every port is untrusted: the real server on an untrusted port would be blocked too.'))
      return { ...ok(lines), mutated: !!s }
    },
  },
  {
    words: ['ip', 'dhcp', 'snooping', 'vlan'],
    modes: CFG,
    help: 'VLANs where DHCP snooping is active',
    only: SW,
    syntax: ['WORD  VLAN list, e.g. 1,10,20'],
    run: (c, rest) => {
      const vlans = vlanList(rest[0])
      if (!vlans) return fail('% Incomplete command. ip dhcp snooping vlan <list>')
      const s = ((c.dev.ios ??= {}).dhcpSnoop ??= { vlans: [] })
      s.vlans = [...new Set([...s.vlans, ...vlans])].sort((a, b) => a - b)
      return ok()
    },
  },
  {
    words: ['ip', 'dhcp', 'snooping', 'trust'],
    modes: IF,
    help: 'Allow DHCP server replies in on this port (the uplink to the real server)',
    only: SW,
    run: (c) => {
      cur(c).snoopTrust = true
      return ok([tip('Trusted: DHCP offers are allowed in here. Leave the ports facing users untrusted.')])
    },
  },
  { words: ['ip', 'dhcp', 'snooping', 'limit', 'rate'], modes: IF, help: 'Cap DHCP packets/sec (NetSim drops floods on untrusted ports already)', only: SW, syntax: ['<1-2048>  Packets per second'], run: () => [] },
  {
    words: ['ip', 'arp', 'inspection', 'vlan'],
    modes: CFG,
    help: 'Check ARP against the DHCP snooping table; drop forged ARP (stops ARP spoofing)',
    only: SW,
    syntax: ['WORD  VLAN list, e.g. 1,10'],
    run: (c, rest) => {
      const vlans = vlanList(rest[0])
      if (!vlans) return fail('% Incomplete command. ip arp inspection vlan <list>')
      const a = ((c.dev.ios ??= {}).arpInspect ??= { vlans: [] })
      a.vlans = [...new Set([...a.vlans, ...vlans])].sort((x, y) => x - y)
      const lines = []
      if (!c.dev.ios.dhcpSnoop) lines.push(tip('DAI validates ARP against the DHCP snooping table: turn on ip dhcp snooping too, or add a static ARP ACL.'))
      if (!c.dev.ifaces.some((i) => i.daiTrust)) lines.push(tip('Trust the uplink and any router port: interface <uplink> → ip arp inspection trust, or legitimate ARP there is dropped.'))
      return ok(lines)
    },
  },
  {
    words: ['ip', 'arp', 'inspection', 'trust'],
    modes: IF,
    help: 'Do not inspect ARP on this port (the uplink, or a router)',
    only: SW,
    run: (c) => {
      cur(c).daiTrust = true
      return ok()
    },
  },
  {
    words: ['no', 'ip', 'dhcp', 'snooping'],
    modes: CFG,
    help: 'Turn DHCP snooping off',
    only: SW,
    run: (c) => (delete c.dev.ios?.dhcpSnoop, ok()),
  },
  { words: ['no', 'ip', 'dhcp', 'snooping', 'trust'], modes: IF, help: 'Untrust this port', only: SW, run: (c) => (delete cur(c).snoopTrust, ok()) },
  { words: ['no', 'ip', 'arp', 'inspection', 'vlan'], modes: CFG, help: 'Stop inspecting ARP', only: SW, run: (c) => (delete c.dev.ios?.arpInspect, ok()) },
  { words: ['no', 'ip', 'arp', 'inspection', 'trust'], modes: IF, help: 'Inspect ARP on this port again', only: SW, run: (c) => (delete cur(c).daiTrust, ok()) },
  {
    words: ['show', 'ip', 'dhcp', 'snooping'],
    modes: EXEC,
    help: 'DHCP snooping status and trusted ports',
    only: SW,
    run: (c) => {
      const s = c.dev.ios?.dhcpSnoop
      if (!s) return [L('Switch DHCP snooping is disabled'), tip('Turn it on: ip dhcp snooping, then ip dhcp snooping vlan <list>')]
      const trusted = c.dev.ifaces.filter((i) => i.snoopTrust).map((i) => portAbbr(i.name))
      return [
        L('Switch DHCP snooping is enabled', 'ok'),
        L(`DHCP snooping is configured on the following VLANs: ${s.vlans.join(',') || '(none yet)'}`),
        L(''),
        L('Interface          Trusted  Rate limit (pps)', 'info'),
        L('-----------------  -------  ----------------'),
        ...c.dev.ifaces.filter((i) => i.name.startsWith('fa') || i.name.startsWith('g')).map((i) => L(`${longName(i.name).padEnd(19)}${(i.snoopTrust ? 'yes' : 'no').padEnd(9)}${i.snoopTrust ? 'unlimited' : '15'}`)),
        ...(trusted.length ? [] : [tip('No trusted port: the real DHCP server would be blocked. Trust the uplink.')]),
      ]
    },
  },
  {
    words: ['show', 'ip', 'arp', 'inspection'],
    modes: EXEC,
    help: 'Dynamic ARP Inspection status',
    only: SW,
    run: (c) => {
      const a = c.dev.ios?.arpInspect
      if (!a) return [L('Source Mac Validation      : Disabled'), tip('Turn it on: ip arp inspection vlan <list> (with ip dhcp snooping)')]
      return [
        L(`Dynamic ARP Inspection is enabled on VLANs: ${a.vlans.join(',')}`, 'ok'),
        L(''),
        L('Interface          Trusted', 'info'),
        L('-----------------  -------'),
        ...c.dev.ifaces.filter((i) => i.name.startsWith('fa') || i.name.startsWith('g')).map((i) => L(`${longName(i.name).padEnd(19)}${i.daiTrust ? 'Trusted' : 'Untrusted'}`)),
        ...(c.dev.ios?.dhcpSnoop ? [] : [tip('DHCP snooping is off, so there is no binding table to check ARP against.')]),
      ]
    },
  },
]

/** Global DHCP-snooping / DAI lines for the running-config. */
export function snoopConfig(dev: Device): string[] {
  const c = dev.ios ?? {}
  const out: string[] = []
  if (c.dhcpSnoop) {
    out.push('ip dhcp snooping')
    if (c.dhcpSnoop.vlans.length) out.push(`ip dhcp snooping vlan ${c.dhcpSnoop.vlans.join(',')}`)
  }
  if (c.arpInspect?.vlans.length) out.push(`ip arp inspection vlan ${c.arpInspect.vlans.join(',')}`)
  if (out.length) out.push('!')
  return out
}

/** Per-interface trust lines. */
export function snoopIface(i: Iface): string[] {
  return [...(i.snoopTrust ? [' ip dhcp snooping trust'] : []), ...(i.daiTrust ? [' ip arp inspection trust'] : [])]
}
