import { formatRule, routingTable, sendPacket, type SimState } from './forwarding'
import { isValidIp, parseCidr, prefixToMask } from './ip'
import { cableProblem, CABLES, DEVICE_CATALOG, getDevice, isHost, linkActive, linkOn, netIfaces, setIfaceIp, wifiProblem } from './network'
import type { Device, FwRule, PingResult, Proto, Topology } from './types'

export type LineKind = 'out' | 'ok' | 'err' | 'info' | 'muted'

export interface Line {
  text: string
  kind: LineKind
}

export interface CommandResult {
  lines: Line[]
  packet?: PingResult
  clear?: boolean
  mutated?: boolean
  /** Text to put back on the input line (after `?` help). */
  refill?: string
}

const out = (text: string, kind: LineKind = 'out'): Line => ({ text, kind })

export const HELP: [string, string][] = [
  ['help', 'show this help'],
  ['ifconfig', 'list interfaces, IPs and links'],
  ['ip set [iface] <ip/prefix>', 'assign an address (iface optional on single-NIC hosts)'],
  ['ip set <iface> none', 'remove an address'],
  ['gateway <ip|none>', 'set the default gateway (PC / server)'],
  ['hostname <name>', 'rename this device'],
  ['ping <ip|device>', 'send ICMP echo and wait for the reply'],
  ['traceroute <ip|device>', 'list the routers a packet crosses'],
  ['tcp <ip|device> <port>', 'test a TCP connection (useful through firewalls)'],
  ['arp -a', 'show the ARP cache'],
  ['console', 'open the CLI of the device on your console cable (COM1)'],
  ['wifi scan', 'list Wi-Fi networks in range (laptop)'],
  ['wifi connect <ssid> [password]', 'join a Wi-Fi network (laptop)'],
  ['wifi status | wifi disconnect', 'show or drop the Wi-Fi connection (laptop)'],
  ['show ip route', 'show the routing table'],
  ['route add <net/prefix|default> via <ip>', 'add a static route'],
  ['route del <n>', 'delete static route number n'],
  ['show mac', 'show the MAC address table (switch)'],
  ['fw rule add <allow|deny> <src> <dst> [proto[/port]]', 'append a firewall rule; src/dst: any, IP or CIDR'],
  ['fw rule del <n>', 'delete firewall rule number n'],
  ['fw default <allow|deny>', 'policy when no rule matches'],
  ['show fw', 'list firewall rules'],
  ['clear', 'clear the screen'],
]

function resolveTarget(topo: Topology, arg: string | undefined): string | null {
  if (!arg) return null
  if (isValidIp(arg)) return arg
  const d = getDevice(topo, arg)
  return d?.ifaces.find((i) => i.ip)?.ip ?? null
}

const isRouterLike = (d: Device) => d.type === 'router' || d.type === 'firewall'

export function execute(
  topo: Topology,
  state: SimState,
  deviceId: string,
  input: string,
): CommandResult {
  const dev = getDevice(topo, deviceId)
  if (!dev) return { lines: [out('No device selected', 'err')] }
  const args = input.trim().split(/\s+/).filter(Boolean)
  if (args.length === 0) return { lines: [] }
  const [cmd, ...rest] = args
  const err = (t: string): CommandResult => ({ lines: [out(t, 'err')] })
  const L2 = DEVICE_CATALOG[dev.type].layer === 2

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      return {
        lines: [
          out('Available commands:', 'info'),
          ...HELP.map(([c, d]) => out(`  ${c.padEnd(48)} ${d}`)),
        ],
      }

    case 'clear':
    case 'cls':
      return { lines: [], clear: true }

    case 'ifconfig':
    case 'ipconfig': {
      const lines: Line[] = []
      for (const i of dev.ifaces) {
        const l = linkOn(topo, dev.id, i.name)
        const peer = l && (l.a.device === dev.id && l.a.iface === i.name ? l.b : l.a)
        const peerDev = peer && getDevice(topo, peer.device)
        const status = l ? (l.up ? 'UP' : 'DOWN') : 'no cable'
        if (i.name === 'com1') {
          lines.push(out(l ? `com1: console cable to ${peerDev?.name} (type "console" to open it)` : 'com1: serial port, no console cable', l ? 'ok' : 'muted'))
          continue
        }
        const problem = l && cableProblem(topo, l)
        if (problem) {
          lines.push(out(`${i.name}: DOWN  -> ${peerDev?.name} ${peer!.iface}  (wrong cable)`, 'err'))
          lines.push(out(`    ${problem}`, 'muted'))
          if (i.ip) lines.push(out(`    inet ${i.ip}/${i.prefix}  netmask ${prefixToMask(i.prefix!)}`))
          continue
        }
        if (l?.wifi) {
          const up = linkActive(topo, l)
          lines.push(out(`${i.name}: ${up ? 'CONNECTED' : 'DISCONNECTED'}  ssid "${l.wifi.ssid}" via ${peerDev?.name ?? '?'}`, up ? 'ok' : 'err'))
        } else if (i.name === 'wlan0') lines.push(out(`${i.name}: not connected (wifi scan, wifi connect <ssid>)`, 'muted'))
        else lines.push(out(`${i.name}: ${i.shutdown ? 'ADMIN DOWN' : status}${peerDev ? `  -> ${peerDev.name} ${peer!.iface}  (${CABLES[l!.cable ?? 'straight'].label.toLowerCase()})` : ''}`, l ? 'ok' : 'muted'))
        lines.push(out(`    ether ${i.mac}`, 'muted'))
        if (i.ip) lines.push(out(`    inet ${i.ip}/${i.prefix}  netmask ${prefixToMask(i.prefix!)}`))
      }
      if (isHost(dev)) lines.push(out(`default gateway: ${dev.gateway ?? '(none)'}`, 'info'))
      return { lines }
    }

    case 'ip': {
      if (rest[0] !== 'set') return err('Usage: ip set [iface] <ip/prefix>')
      if (L2) return err(`${dev.name} is a layer 2 switch: its ports have no IP address`)
      let iface: string
      let cidr: string | undefined
      if (rest.length === 2) {
        const net = netIfaces(dev)
        if (net.length !== 1) return err(`${dev.name} has several interfaces: ip set <iface> <ip/prefix>`)
        iface = net[0].name
        cidr = rest[1]
      } else {
        iface = rest[1]
        cidr = rest[2]
      }
      if (!cidr) return err('Usage: ip set [iface] <ip/prefix>')
      const e = setIfaceIp(dev, iface, cidr)
      if (e) return err(e)
      return { lines: [out(cidr === 'none' ? `${iface} address removed` : `${iface} configured with ${cidr}`, 'ok')], mutated: true }
    }

    case 'gateway': {
      if (!isHost(dev)) return err('Only PCs, laptops and servers have a default gateway. Routers use: route add default via <ip>')
      const g = rest[0]
      if (g === 'none') {
        delete dev.gateway
        return { lines: [out('default gateway removed', 'ok')], mutated: true }
      }
      if (!g || !isValidIp(g)) return err('Usage: gateway <ip|none>')
      dev.gateway = g
      return { lines: [out(`default gateway set to ${g}`, 'ok')], mutated: true }
    }

    case 'hostname': {
      const name = rest[0]
      if (!name || !/^[\w-]{1,16}$/.test(name)) return err('Usage: hostname <name> (letters, digits, - and _)')
      if (dev.locked) return err(`${dev.name} is part of the mission and cannot be renamed`)
      if (topo.devices.some((d) => d !== dev && d.name.toLowerCase() === name.toLowerCase()))
        return err(`A device named ${name} already exists`)
      dev.name = name
      return { lines: [out(`hostname is now ${name}`, 'ok')], mutated: true }
    }

    case 'ping':
    case 'tcp': {
      if (L2) return err(`${dev.name} is a layer 2 switch and cannot send packets`)
      const target = resolveTarget(topo, rest[0])
      if (!target) return err(`Usage: ${cmd} <ip|device>${cmd === 'tcp' ? ' <port>' : ''} (device must have an IP)`)
      let proto: Proto = 'icmp'
      let port: number | undefined
      if (cmd === 'tcp') {
        port = Number(rest[1])
        if (!Number.isInteger(port) || port < 1 || port > 65535) return err('Usage: tcp <ip|device> <port>')
        proto = 'tcp'
      }
      const r = sendPacket(topo, state, dev.id, target, proto, port)
      const head = proto === 'icmp' ? `PING ${target}` : `TCP ${target}:${port}`
      const msg =
        proto === 'tcp' && r.success ? `Connected to ${target}:${port}` : r.message
      return { lines: [out(head, 'info'), out(msg, r.success ? 'ok' : 'err')], packet: r }
    }

    case 'traceroute':
    case 'tracert': {
      if (L2) return err(`${dev.name} is a layer 2 switch and cannot send packets`)
      const target = resolveTarget(topo, rest[0])
      if (!target) return err('Usage: traceroute <ip|device>')
      const r = sendPacket(topo, state, dev.id, target)
      const request = r.hops.filter((h) => !h.reply && h.action !== 'switch' && h.action !== 'send')
      const lines = [out(`traceroute to ${target}, ${32} hops max`, 'info')]
      request.forEach((h, n) => {
        const d = getDevice(topo, h.deviceId)
        const ip = d?.ifaces.find((i) => i.ip)?.ip ?? '?'
        lines.push(out(` ${n + 1}  ${h.deviceName} (${ip})${h.action === 'drop' ? '  * ' + h.detail : ''}`, h.action === 'drop' ? 'err' : 'out'))
      })
      if (request.length === 0) lines.push(out(` 1  * ${r.hops[0]?.detail ?? r.message}`, 'err'))
      return { lines, packet: r }
    }

    case 'arp': {
      const table = state.arp[dev.id] ?? {}
      const entries = Object.entries(table)
      if (entries.length === 0) return { lines: [out('ARP cache is empty (send some traffic first)', 'muted')] }
      return {
        lines: [
          out('Address           HWaddress', 'info'),
          ...entries.map(([ip, mac]) => out(`${ip.padEnd(18)}${mac}`)),
        ],
      }
    }

    case 'show': {
      const what = rest.join(' ')
      if (what === 'ip route' || what === 'route') return showRoutes(dev)
      if (what === 'mac' || what === 'mac-address-table') {
        if (!L2) return err('show mac is only available on switches')
        const entries = Object.entries(state.mac[dev.id] ?? {})
        if (entries.length === 0) return { lines: [out('MAC table is empty (send some traffic first)', 'muted')] }
        return {
          lines: [out('MAC Address         Port', 'info'), ...entries.map(([m, p]) => out(`${m}   ${p}`))],
        }
      }
      if (what === 'fw' || what === 'firewall') return showFw(dev)
      return err('Usage: show ip route | show mac | show fw')
    }

    case 'route': {
      if (rest[0] === undefined || rest[0] === 'print') return showRoutes(dev)
      if (!isRouterLike(dev)) return err('Only routers and firewalls have static routes. Hosts use: gateway <ip>')
      if (rest[0] === 'add') {
        const [netArg, via, gw] = rest.slice(1)
        if (via !== 'via' || !gw || !isValidIp(gw)) return err('Usage: route add <net/prefix|default> via <ip>')
        const net = netArg === 'default' ? { ip: '0.0.0.0', prefix: 0 } : parseCidr(netArg ?? '', -1)
        if (!net || net.prefix < 0) return err('Network must be in CIDR form, e.g. 10.0.2.0/24')
        dev.routes.push({ network: net.ip, prefix: net.prefix, via: gw })
        const reachable = routingTable(dev).some((r) => r.kind === 'static' && r.nextHop === gw)
        return {
          lines: [
            out(`route ${net.ip}/${net.prefix} via ${gw} added`, 'ok'),
            ...(reachable ? [] : [out(`warning: next hop ${gw} is not in any connected subnet — the route is inactive`, 'err')]),
          ],
          mutated: true,
        }
      }
      if (rest[0] === 'del') {
        const n = Number(rest[1])
        if (!Number.isInteger(n) || n < 1 || n > dev.routes.length) return err(`Usage: route del <1..${dev.routes.length}>`)
        dev.routes.splice(n - 1, 1)
        return { lines: [out(`route #${n} deleted`, 'ok')], mutated: true }
      }
      return err('Usage: route add <net/prefix|default> via <ip> | route del <n>')
    }

    case 'fw': {
      if (dev.type !== 'firewall') return err('fw commands are only available on firewalls')
      if (rest[0] === 'default') {
        const p = rest[1]
        if (p !== 'allow' && p !== 'deny') return err('Usage: fw default <allow|deny>')
        dev.fwDefault = p
        return { lines: [out(`default policy: ${p}`, 'ok')], mutated: true }
      }
      if (rest[0] !== 'rule') return err('Usage: fw rule add|del ... | fw default allow|deny')
      if (rest[1] === 'add') {
        const rule = parseRule(rest.slice(2))
        if (typeof rule === 'string') return err(rule)
        dev.fwRules.push(rule)
        return { lines: [out(`rule #${dev.fwRules.length} added: ${formatRule(rule)}`, 'ok')], mutated: true }
      }
      if (rest[1] === 'del') {
        const n = Number(rest[2])
        if (!Number.isInteger(n) || n < 1 || n > dev.fwRules.length) return err(`Usage: fw rule del <1..${dev.fwRules.length}>`)
        dev.fwRules.splice(n - 1, 1)
        return { lines: [out(`rule #${n} deleted`, 'ok')], mutated: true }
      }
      return err('Usage: fw rule add <allow|deny> <src> <dst> [proto[/port]]')
    }

    case 'wifi':
      return wifi(topo, dev, rest)

    default:
      return err(`${cmd}: command not found. Type "help".`)
  }
}

/** Networks a laptop can see: every AP radio that is up and serving an SSID. */
function networksInRange(topo: Topology) {
  return topo.devices.flatMap((ap) => {
    const w = ap.ios?.wlan
    const radio = ap.ifaces.find((i) => i.name === 'd0')
    if (ap.type !== 'ap' || !w?.radioSsid || !radio || radio.shutdown) return []
    const s = w.ssids[w.radioSsid]
    return s ? [{ ap, ssid: w.radioSsid, cfg: s, mac: radio.mac }] : []
  })
}

function wifi(topo: Topology, dev: Device, rest: string[]): CommandResult {
  const err = (t: string): CommandResult => ({ lines: [out(t, 'err')] })
  if (dev.type !== 'laptop') return err(`${dev.name} has no wireless adapter. Laptops join Wi-Fi; PCs and servers use cables.`)
  const current = linkOn(topo, dev.id, 'wlan0')
  const [sub, ssid, ...pw] = rest
  switch (sub) {
    case 'scan': {
      const nets = networksInRange(topo).filter((n) => n.cfg.broadcast)
      if (!nets.length)
        return { lines: [out('No networks found', 'muted'), out('  ↳ An AP shows up once its radio has an SSID (and guest-mode, to broadcast it)', 'muted')] }
      return {
        lines: [
          out('SSID                BSSID              SECURITY', 'info'),
          ...nets.map((n) => out(`${n.ssid.padEnd(20)}${n.mac}  ${n.cfg.wpa2 ? 'WPA2-PSK' : 'OPEN'}`)),
        ],
      }
    }
    case 'connect': {
      if (!ssid) return err('Usage: wifi connect <ssid> [password]')
      const nets = networksInRange(topo).filter((n) => n.ssid === ssid)
      if (!nets.length) return err(`No network named "${ssid}" in range`)
      const key = pw.length ? pw.join(' ') : undefined
      if (nets[0].cfg.wpa2 && !key) return err(`"${ssid}" is secured with WPA2: wifi connect ${ssid} <password>`)
      const problems = nets.map((n) => wifiProblem(n.ap, ssid, key))
      const k = problems.findIndex((p) => p === null)
      if (k < 0) {
        if (problems.includes('wrong password')) return err('Authentication failed: wrong password (4-way handshake failed)')
        return { lines: [out('Association rejected by the access point', 'err'), out(`  ↳ ${problems[0]}`, 'muted')] }
      }
      if (current) topo.links = topo.links.filter((l) => l !== current)
      const ap = nets[k].ap
      topo.links.push({
        id: Math.random().toString(36).slice(2, 10),
        a: { device: ap.id, iface: 'd0' },
        b: { device: dev.id, iface: 'wlan0' },
        up: true,
        wifi: { ssid, key },
      })
      const lines = [out(`Connected to "${ssid}" via ${ap.name} (${nets[k].cfg.wpa2 ? 'WPA2-PSK, AES' : 'open, unencrypted'})`, 'ok')]
      if (!nets[k].cfg.wpa2) lines.push(out('  ↳ Open network: anyone nearby can read this traffic', 'muted'))
      if (!dev.ifaces[0].ip) lines.push(out('  ↳ wlan0 has no IP yet: ip set <ip/prefix>', 'muted'))
      return { lines, mutated: true }
    }
    case 'disconnect': {
      if (!current) return err('Not connected')
      topo.links = topo.links.filter((l) => l !== current)
      return { lines: [out(`Disconnected from "${current.wifi?.ssid}"`, 'ok')], mutated: true }
    }
    case undefined:
    case 'status': {
      if (!current?.wifi) return { lines: [out('wlan0: not connected', 'muted')] }
      const ap = getDevice(topo, current.a.device)
      const up = linkActive(topo, current)
      return {
        lines: [
          out(`wlan0: ${up ? 'connected' : 'DISCONNECTED'} to "${current.wifi.ssid}" via ${ap?.name}`, up ? 'ok' : 'err'),
          ...(up || !ap ? [] : [out(`  ↳ ${wifiProblem(ap, current.wifi.ssid, current.wifi.key)}`, 'muted')]),
        ],
      }
    }
    default:
      return err('Usage: wifi scan | wifi connect <ssid> [password] | wifi status | wifi disconnect')
  }
}

function showRoutes(dev: Device): CommandResult {
  if (DEVICE_CATALOG[dev.type].layer === 2) return { lines: [out('Switches do not route', 'err')] }
  const rows = routingTable(dev)
  const lines: Line[] = [out('Type  Network             Next hop         Iface', 'info')]
  for (const r of rows) {
    lines.push(
      out(
        `${r.kind === 'connected' ? 'C' : 'S'}     ${(r.network + '/' + r.prefix).padEnd(20)}${(r.kind === 'connected' ? 'connected' : r.nextHop).padEnd(17)}${r.iface.name}`,
      ),
    )
  }
  if (isHost(dev) && dev.gateway) lines.push(out(`*     0.0.0.0/0           ${dev.gateway.padEnd(17)}(gateway)`))
  dev.routes.forEach((r, n) => {
    if (!rows.some((x) => x.kind === 'static' && x.network === r.network && x.prefix === r.prefix && x.nextHop === r.via))
      lines.push(out(`S#${n + 1}   ${(r.network + '/' + r.prefix).padEnd(20)}${r.via.padEnd(17)}INACTIVE`, 'err'))
  })
  if (dev.routes.length) lines.push(out(`static routes: ${dev.routes.map((r, n) => `#${n + 1} ${r.network}/${r.prefix} via ${r.via}`).join(', ')}`, 'muted'))
  if (lines.length === 1) lines.push(out('(empty — configure an interface IP first)', 'muted'))
  return { lines }
}

function showFw(dev: Device): CommandResult {
  if (dev.type !== 'firewall') return { lines: [out('Not a firewall', 'err')] }
  const lines: Line[] = [out(`Firewall ${dev.name} — rules are checked top to bottom, first match wins`, 'info')]
  dev.fwRules.forEach((r, n) => lines.push(out(`  #${n + 1}  ${formatRule(r)}`, r.action === 'allow' ? 'ok' : 'err')))
  if (dev.fwRules.length === 0) lines.push(out('  (no rules)', 'muted'))
  lines.push(out(`  default: ${dev.fwDefault}   (replies to allowed traffic always pass — stateful)`, 'muted'))
  return { lines }
}

export function parseRule(args: string[]): FwRule | string {
  const usage = 'Usage: fw rule add <allow|deny> <src> <dst> [proto[/port]]  e.g. fw rule add deny 10.0.2.0/24 10.0.3.10 tcp/22'
  const [action, src, dst, protoArg = 'any'] = args
  if (action !== 'allow' && action !== 'deny') return usage
  const validSpec = (s?: string) => s === 'any' || (s !== undefined && parseCidr(s) !== null)
  if (!validSpec(src) || !validSpec(dst)) return usage
  const [p, portStr] = protoArg.split('/')
  if (!['any', 'icmp', 'tcp', 'udp'].includes(p)) return usage
  const rule: FwRule = { action, src: src!, dst: dst!, proto: p as Proto }
  if (portStr !== undefined) {
    const port = Number(portStr)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (p !== 'tcp' && p !== 'udp')) return usage
    rule.port = port
  }
  return rule
}
