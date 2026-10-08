/**
 * Cisco IOS-style console for routers, switches and firewalls.
 *
 * Modes follow IOS: user EXEC (R1>), privileged EXEC (R1#), global config,
 * interface config and line config. Keywords can be abbreviated as long as
 * they stay unambiguous (`sh ip int br`, `conf t`, `int g0/0`).
 */
import { execute, type CommandResult, type Line, type LineKind } from './commands'
import { routingTable, sendPacket, type SimState } from './forwarding'
import { inSubnet, ipToInt, isValidIp, maskInt, networkOf, prefixToMask } from './ip'
import { cableProblem, DEVICE_CATALOG, getDevice, linkActive, linkOn, linksOn, netIfaces, peerOf } from './network'
import type { Device, DeviceType, FwRule, Iface, IosConfig, IosSecret, SsidConfig, Topology, VtyTransport, WlanConfig } from './types'

export type Mode = 'user' | 'priv' | 'config' | 'if' | 'line' | 'ssid'

export interface Frame {
  deviceId: string
  mode: Mode
  iface?: string
  /** SSID being edited in `dot11 ssid` mode. */
  ssid?: string
  /** Set when this frame was opened from another device (SSH, or a console cable when `serial`); `exit` closes it. */
  remote?: { user: string; ip: string; serial?: boolean }
}

export type Pending =
  | { kind: 'enable'; tries: number }
  | { kind: 'ssh'; deviceId: string; ip: string; user: string; tries: number; fromHost: boolean }
  | { kind: 'rsa' }

export interface Session {
  frames: Frame[]
  pending?: Pending
}

export interface Ctx {
  topo: Topology
  state: SimState
  s: Session
  f: Frame
  dev: Device
  promptLen: number
}

type Result = CommandResult | Line[]

interface Spec {
  words: string[]
  modes: Mode[]
  help: string
  /** Shown by `?` once all keywords are typed. */
  syntax?: string[]
  /** Matched only when typed in full (old NetSim aliases), never listed. */
  hidden?: boolean
  only?: DeviceType[]
  run: (c: Ctx, rest: string[]) => Result
}

const L = (text: string, kind: LineKind = 'out'): Line => ({ text, kind })
const tip = (text: string): Line => L(`  ↳ ${text}`, 'muted')
const fail = (text: string, ...tips: string[]): Line[] => [L(text, 'err'), ...tips.map(tip)]

export const isIos = (d: Device) => d.type === 'router' || d.type === 'switch' || d.type === 'firewall' || d.type === 'ap'
const isL2 = (d: Device) => DEVICE_CATALOG[d.type].layer === 2
const conf = (d: Device): IosConfig => (d.ios ??= {})
const wlan = (d: Device): WlanConfig => (conf(d).wlan ??= { ssids: {} })

const MODEL: Record<string, string> = { router: 'NS-2911', switch: 'NS-2960', firewall: 'NS-ASA', ap: 'NS-AIR-2700' }
const CAP: Record<string, string> = { router: 'R', switch: 'S', firewall: 'F', ap: 'T' }

// ---------- names, masks, fake hashes ----------

const LONG: Record<string, string> = { g: 'GigabitEthernet', fa: 'FastEthernet', d: 'Dot11Radio' }
const SHORT: Record<string, string> = { g: 'Gig ', fa: 'Fas ', d: 'Dot11 ' }
const IFNAME = /^(g|fa|d)(\d+(?:\/\d+)?)$/

export function longName(n: string): string {
  const m = IFNAME.exec(n)
  return m ? LONG[m[1]] + m[2] : n
}
const shortName = (n: string) => {
  const m = IFNAME.exec(n)
  return m ? SHORT[m[1]] + m[2] : n
}

/** Accepts `g0/0`, `gi0/0`, `GigabitEthernet0/0`, `fa0/1`, or the type and number as two tokens. */
function parseIface(dev: Device, tokens: string[]): Iface | undefined {
  const text = (/\d/.test(tokens[0] ?? '') ? tokens[0] : (tokens[0] ?? '') + (tokens[1] ?? '')).toLowerCase()
  const m = /^([a-z0-9]*?[a-z])(\d+(?:\/\d+)?)$/.exec(text)
  if (!m) return undefined
  const kind = 'gigabitethernet'.startsWith(m[1])
    ? 'g'
    : 'fastethernet'.startsWith(m[1])
      ? 'fa'
      : 'dot11radio'.startsWith(m[1])
        ? 'd'
        : null
  return kind ? dev.ifaces.find((i) => i.name === kind + m[2]) : undefined
}

export function maskToPrefix(mask: string): number | null {
  if (!isValidIp(mask)) return null
  const n = ipToInt(mask) >>> 0
  for (let p = 0; p <= 32; p++) if (maskInt(p) >>> 0 === n) return p
  return null
}

const ciscoMac = (mac: string) => mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.')

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function fakeHash(s: string, n: number, seed: number): string {
  let h = seed >>> 0
  let res = ''
  for (let k = 0; k < n; k++) {
    for (const ch of s + k) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    res += B64[h % 64]
  }
  return res
}

const T7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87'
/** Real Cisco type 7 encoding (reversible, which is why `secret` is preferred). */
function type7(v: string): string {
  const salt = 8
  return (
    '08' +
    [...v]
      .map((c, i) => (c.charCodeAt(0) ^ T7_KEY.charCodeAt((salt + i) % T7_KEY.length)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

function showSecret(sec: IosSecret, encrypt: boolean): string {
  if (sec.kind === 'secret') return `secret 5 $1$${fakeHash(sec.value, 4, 7)}$${fakeHash(sec.value, 22, 99)}`
  return encrypt ? `password 7 ${type7(sec.value)}` : `password ${sec.value}`
}

// ---------- state helpers ----------

type IfStatus = { status: string; protocol: string }
function ifStatus(topo: Topology, dev: Device, i: Iface): IfStatus {
  if (i.shutdown) return { status: 'administratively down', protocol: 'down' }
  if (i.name === 'd0') return dev.ios?.wlan?.radioSsid ? { status: 'up', protocol: 'up' } : { status: 'reset', protocol: 'down' }
  const l = linkOn(topo, dev.id, i.name)
  if (!l || !linkActive(topo, l)) return { status: 'down', protocol: 'down' }
  return { status: 'up', protocol: 'up' }
}

export function sshEnabled(cfg: IosConfig | undefined): boolean {
  return (cfg?.rsaBits ?? 0) >= 768
}

const transportAllowsSsh = (t: VtyTransport | undefined) => t === undefined || t === 'all' || t === 'ssh'

function resolveTarget(topo: Topology, arg: string | undefined): string | null {
  if (!arg) return null
  if (isValidIp(arg)) return arg
  return getDevice(topo, arg)?.ifaces.find((i) => i.ip && !i.shutdown)?.ip ?? null
}

// ---------- running-config ----------

export function runningConfig(dev: Device): string[] {
  const c = dev.ios ?? {}
  const enc = !!c.passwordEncryption
  const out: string[] = ['!', 'version 15.4', enc ? 'service password-encryption' : 'no service password-encryption', '!', `hostname ${dev.name}`, '!']
  if (c.enable) out.push(`enable ${showSecret(c.enable, enc)}`, '!')
  if (c.domain) out.push(`ip domain-name ${c.domain}`)
  if (c.sshVersion) out.push(`ip ssh version ${c.sshVersion}`)
  if (c.domain || c.sshVersion) out.push('!')
  for (const [u, sec] of Object.entries(c.users ?? {})) out.push(`username ${u} ${showSecret(sec, enc)}`)
  if (Object.keys(c.users ?? {}).length) out.push('!')
  for (const [name, sc] of Object.entries(c.wlan?.ssids ?? {})) {
    out.push(`dot11 ssid ${name}`)
    if (sc.open) out.push('   authentication open')
    if (sc.wpa2) out.push('   authentication key-management wpa version 2')
    if (sc.broadcast) out.push('   guest-mode')
    if (sc.psk) out.push(`   wpa-psk ascii ${enc ? '7 ' + type7(sc.psk) : '0 ' + sc.psk}`)
    out.push('!')
  }
  for (const i of netIfaces(dev)) {
    out.push(`interface ${longName(i.name)}`)
    if (i.description) out.push(` description ${i.description}`)
    if (i.name === 'd0') {
      if (c.wlan?.aes) out.push(' encryption mode ciphers aes-ccm')
      if (c.wlan?.radioSsid) out.push(` ssid ${c.wlan.radioSsid}`)
    }
    if (!isL2(dev)) out.push(i.ip ? ` ip address ${i.ip} ${prefixToMask(i.prefix!)}` : ' no ip address')
    if (i.shutdown) out.push(' shutdown')
    out.push('!')
  }
  for (const r of dev.routes) out.push(`ip route ${r.network} ${prefixToMask(r.prefix)} ${r.via}`)
  if (dev.routes.length) out.push('!')
  if (dev.type === 'firewall') {
    out.push('! NetSim firewall policy (first match wins)')
    out.push(`fw default ${dev.fwDefault}`)
    for (const r of dev.fwRules) out.push(fwCommand(r))
    out.push('!')
  }
  if (c.banner) out.push(`banner motd ^C${c.banner}^C`, '!')
  out.push('line con 0', 'line vty 0 4')
  const v = c.vty ?? {}
  if (v.password) out.push(` password ${enc ? '7 ' + type7(v.password) : v.password}`)
  if (v.login === 'local') out.push(' login local')
  else if (v.login === 'none') out.push(' no login')
  else out.push(' login')
  if (v.transport && v.transport !== 'all') out.push(` transport input ${v.transport}`)
  out.push('!', 'end')
  return out
}

const fwCommand = (r: FwRule) => `fw rule add ${r.action} ${r.src} ${r.dst} ${r.proto}${r.port !== undefined ? '/' + r.port : ''}`

// ---------- commands ----------

const EXEC: Mode[] = ['user', 'priv']
const PRIV: Mode[] = ['priv']
const CFG: Mode[] = ['config']
const IF: Mode[] = ['if']
const LINE: Mode[] = ['line']
const SUB: Mode[] = ['config', 'if', 'line', 'ssid']
const SSID: Mode[] = ['ssid']
const AP: DeviceType[] = ['ap']
const L3: DeviceType[] = ['router', 'firewall']

const HELP: Record<string, string> = {
  show: 'Show running system information',
  ip: 'Global IP configuration subcommands',
  no: 'Negate a command or set its defaults',
  crypto: 'Encryption module',
  enable: 'Modify enable password parameters',
  clear: 'Reset functions',
  copy: 'Copy from one file to another',
  line: 'Configure a terminal line',
  service: 'Modify use of network based services',
  banner: 'Define a login banner',
  login: 'Enable password checking',
  transport: 'Define transport protocols for line',
  interface: 'Select an interface to configure',
}

/** `X` and `no X` inside `dot11 ssid`. */
function ssidSetting(words: string[], help: string, set: (s: SsidConfig, on: boolean) => void): Spec[] {
  const run = (on: boolean) => (c: Ctx, rest: string[]): Result => {
    if (words[2] === 'wpa' && on && rest.join(' ') !== 'version 2') return fail('% NetSim supports WPA2 only: authentication key-management wpa version 2')
    set(wlan(c.dev).ssids[c.f.ssid!], on)
    return { lines: [], mutated: true }
  }
  return [
    { words, modes: SSID, help, only: AP, syntax: words[2] === 'wpa' ? ['version 2  WPA2'] : undefined, run: run(true) },
    { words: ['no', ...words], modes: SSID, help: `Undo: ${words.join(' ')}`, only: AP, run: run(false) },
  ]
}

function exitExec(c: Ctx): Result {
  if (c.f.remote) {
    c.s.frames.pop()
    return [L(c.f.remote.serial ? `[Console session on ${c.f.remote.ip} closed]` : `[Connection to ${c.f.remote.ip} closed by foreign host]`, 'muted')]
  }
  c.f.mode = 'user'
  return [L(''), L(`${c.dev.name} con0 is now available`, 'muted'), L(''), L('Press RETURN to get started.', 'muted')]
}

const SPECS: Spec[] = [
  // ----- EXEC -----
  {
    words: ['enable'],
    modes: EXEC,
    help: 'Turn on privileged commands',
    run: (c) => {
      if (c.f.mode === 'priv') return []
      const sec = c.dev.ios?.enable
      if (!sec) {
        if (c.f.remote && !c.f.remote.serial) return fail('% No password set', 'Remote (vty) sessions need an enable secret: conf t → enable secret <password>')
        c.f.mode = 'priv'
        return []
      }
      c.s.pending = { kind: 'enable', tries: 0 }
      return []
    },
  },
  { words: ['disable'], modes: PRIV, help: 'Turn off privileged commands', run: (c) => ((c.f.mode = 'user'), []) },
  { words: ['exit'], modes: EXEC, help: 'Exit from the EXEC', run: exitExec },
  { words: ['logout'], modes: EXEC, help: 'Exit from the EXEC', run: exitExec },
  { words: ['quit'], modes: EXEC, help: 'Exit from the EXEC', run: exitExec },
  {
    words: ['configure'],
    modes: PRIV,
    help: 'Enter configuration mode',
    syntax: ['terminal  Configure from the terminal'],
    run: (c, rest) => {
      if (rest[0] && !'terminal'.startsWith(rest[0].toLowerCase())) return fail('% NetSim only supports: configure terminal')
      c.f.mode = 'config'
      return [L('Enter configuration commands, one per line.  End with CNTL/Z.')]
    },
  },
  { words: ['ping'], modes: EXEC, help: 'Send echo messages', syntax: ['WORD  Ping destination address or hostname'], run: (c, r) => ping(c, r[0]) },
  { words: ['traceroute'], modes: EXEC, help: 'Trace route to destination', syntax: ['WORD  Trace route to destination address or hostname'], run: (c, r) => traceroute(c, r[0]) },
  {
    words: ['ssh'],
    modes: EXEC,
    help: 'Open a secure shell client connection',
    syntax: ['-l  Log in using this user name', '   e.g. ssh -l admin 10.0.0.1'],
    run: (c, rest) => {
      const a = parseSshArgs(rest)
      if (typeof a === 'string') return fail(a)
      return sshConnect(c.topo, c.state, c.s, c.dev, a.user, a.host, false)
    },
  },
  {
    words: ['show', 'ip', 'interface', 'brief'],
    modes: EXEC,
    help: 'Brief summary of IP status and configuration',
    run: (c) => {
      const lines = [L('Interface              IP-Address      OK? Method Status                Protocol', 'info')]
      for (const i of netIfaces(c.dev)) {
        const st = ifStatus(c.topo, c.dev, i)
        lines.push(
          L(
            `${longName(i.name).padEnd(23)}${(i.ip ?? 'unassigned').padEnd(16)}YES ${(i.ip ? 'manual' : 'unset').padEnd(7)}${st.status.padEnd(22)}${st.protocol}`,
            st.protocol === 'up' ? 'ok' : 'muted',
          ),
        )
      }
      return lines
    },
  },
  { words: ['show', 'ip', 'route'], modes: EXEC, help: 'IP routing table', only: L3, run: (c) => showIpRoute(c.dev) },
  {
    words: ['show', 'ip', 'ssh'],
    modes: EXEC,
    help: 'Information on SSH',
    run: (c) => {
      const cfg = c.dev.ios
      if (!sshEnabled(cfg))
        return [
          L('SSH Disabled - version 1.99'),
          L('%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).'),
          tip(cfg?.domain ? 'crypto key generate rsa modulus 2048' : 'First set a domain: ip domain-name lab.local, then crypto key generate rsa modulus 2048'),
        ]
      return [
        L(`SSH Enabled - version ${cfg!.sshVersion ? '2.0' : '1.99'}`, 'ok'),
        L('Authentication timeout: 120 secs; Authentication retries: 3'),
        L(`Modulus size: ${cfg!.rsaBits} bits`),
      ]
    },
  },
  { words: ['show', 'arp'], modes: EXEC, help: 'ARP table', only: L3, run: (c) => showArp(c) },
  {
    words: ['show', 'interfaces'],
    modes: EXEC,
    help: 'Interface status and configuration',
    syntax: ['WORD  Interface name, e.g. g0/0', '<cr>'],
    run: (c, rest) => {
      let list = netIfaces(c.dev)
      if (rest.length) {
        const i = parseIface(c.dev, rest)
        if (!i) return fail(`% Invalid interface. ${c.dev.name} has: ${c.dev.ifaces.map((x) => x.name).join(', ')}`)
        list = [i]
      }
      return list.flatMap((i) => {
        const st = ifStatus(c.topo, c.dev, i)
        const kind = i.name.startsWith('g') ? 'Gigabit' : 'Fast'
        const l = linkOn(c.topo, c.dev.id, i.name)
        const problem = l && cableProblem(c.topo, l)
        return [
          L(`${longName(i.name)} is ${st.status}, line protocol is ${st.protocol}`, st.protocol === 'up' ? 'ok' : 'err'),
          ...(problem ? [tip(problem)] : []),
          L(`  Hardware is NetSim ${kind} Ethernet, address is ${ciscoMac(i.mac)} (bia ${ciscoMac(i.mac)})`),
          ...(i.description ? [L(`  Description: ${i.description}`)] : []),
          ...(i.ip ? [L(`  Internet address is ${i.ip}/${i.prefix}`)] : []),
          L(`  MTU 1500 bytes, BW ${kind === 'Gigabit' ? '1000000' : '100000'} Kbit/sec, DLY 10 usec`),
        ]
      })
    },
  },
  {
    words: ['show', 'mac', 'address-table'],
    modes: EXEC,
    help: 'MAC forwarding table',
    only: ['switch'],
    run: (c) => {
      const entries = Object.entries(c.state.mac[c.dev.id] ?? {})
      return [
        L('          Mac Address Table', 'info'),
        L('-------------------------------------------', 'info'),
        L(''),
        L('Vlan    Mac Address       Type        Ports', 'info'),
        L('----    -----------       --------    -----', 'info'),
        ...entries.map(([m, p]) => L(`   1    ${ciscoMac(m)}    DYNAMIC     ${shortName(p).replace(' ', '')}`)),
        L(`Total Mac Addresses for this criterion: ${entries.length}`),
        ...(entries.length ? [] : [tip('Switches learn MACs from traffic. Ping across the switch, then look again.')]),
      ]
    },
  },
  {
    words: ['show', 'cdp', 'neighbors'],
    modes: EXEC,
    help: 'CDP neighbor entries',
    run: (c) => {
      const lines = [
        L('Capability Codes: R - Router, S - Switch, F - Firewall, T - Access point', 'muted'),
        L(''),
        L('Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID', 'info'),
      ]
      for (const i of c.dev.ifaces) {
        const l = linkOn(c.topo, c.dev.id, i.name)
        if (!l || !linkActive(c.topo, l)) continue
        const peer = peerOf(l, c.dev.id, i.name)
        const pd = getDevice(c.topo, peer.device)
        if (!pd || !isIos(pd)) continue
        const cap = CAP[pd.type]
        const plat = MODEL[pd.type]
        lines.push(L(`${pd.name.padEnd(17)}${shortName(i.name).padEnd(18)}150${' '.repeat(13)}${cap}      ${plat.padEnd(10)}${shortName(peer.iface)}`))
      }
      if (lines.length === 3) lines.push(tip('CDP only sees directly cabled Cisco-style devices (routers, switches, firewalls).'))
      return lines
    },
  },
  {
    words: ['show', 'version'],
    modes: EXEC,
    help: 'System hardware and software status',
    run: (c) => [
      L('NetSim IOS Software, Version 15.4(3)M, RELEASE SOFTWARE (fc1)'),
      L(`${c.dev.name} uptime is 4 hours, 2 minutes`),
      L(`netsim ${MODEL[c.dev.type]} processor with 524288K bytes of memory.`),
      L(`${netIfaces(c.dev).length} interfaces: ${netIfaces(c.dev).map((i) => longName(i.name)).join(', ')}`),
      L('Configuration register is 0x2102'),
    ],
  },
  {
    words: ['show', 'running-config'],
    modes: PRIV,
    help: 'Current operating configuration',
    run: (c) => {
      const cfg = runningConfig(c.dev)
      return [L('Building configuration...'), L(''), L(`Current configuration : ${cfg.join('\n').length} bytes`), ...cfg.map((t) => L(t, t === '!' ? 'muted' : 'out'))]
    },
  },
  {
    words: ['show', 'startup-config'],
    modes: PRIV,
    help: 'Contents of startup configuration',
    run: (c) => {
      const saved = c.dev.ios?.startup
      if (!saved) return fail('startup-config is not present', 'Save the running-config with: write memory')
      return saved.split('\n').map((t) => L(t, t === '!' ? 'muted' : 'out'))
    },
  },
  { words: ['show', 'firewall'], modes: EXEC, help: 'NetSim firewall rules', only: ['firewall'], run: (c) => legacy(c, 'show fw') },
  { words: ['show', 'fw'], modes: EXEC, help: '', hidden: true, only: ['firewall'], run: (c) => legacy(c, 'show fw') },
  { words: ['write'], modes: PRIV, help: 'Write running configuration to memory', syntax: ['memory  Write to NV memory', '<cr>'], run: (c) => save(c) },
  {
    words: ['copy', 'running-config', 'startup-config'],
    modes: PRIV,
    help: 'Copy running configuration to startup',
    run: (c) => [L('Destination filename [startup-config]?'), ...asLines(save(c))],
  },
  {
    words: ['clear', 'arp-cache'],
    modes: PRIV,
    help: 'Clear the entire ARP cache',
    only: L3,
    run: (c) => ((c.state.arp[c.dev.id] = {}), []),
  },
  {
    words: ['clear', 'mac', 'address-table'],
    modes: PRIV,
    help: 'Clear dynamic MAC addresses',
    only: ['switch'],
    run: (c) => ((c.state.mac[c.dev.id] = {}), []),
  },
  {
    words: ['fw'],
    modes: ['priv', 'config'],
    help: 'NetSim firewall rules (fw rule add|del, fw default)',
    syntax: ['rule add <allow|deny> <src> <dst> [proto[/port]]', 'rule del <n>', 'default <allow|deny>'],
    only: ['firewall'],
    run: (c, rest) => legacy(c, ['fw', ...rest].join(' ')),
  },

  // ----- global config -----
  {
    words: ['hostname'],
    modes: CFG,
    help: 'Set system\'s network name',
    syntax: ['WORD  This system\'s network name'],
    run: (c, rest) => legacy(c, `hostname ${rest[0] ?? ''}`, true),
  },
  {
    words: ['interface'],
    modes: CFG,
    help: 'Select an interface to configure',
    syntax: ['GigabitEthernet  e.g. interface g0/0', 'FastEthernet     e.g. interface fa0/1', 'Dot11Radio       e.g. interface Dot11Radio0 (access points)'],
    run: (c, rest) => {
      const i = parseIface(c.dev, rest)
      if (!i) return fail('% Invalid interface', `${c.dev.name} has: ${c.dev.ifaces.map((x) => x.name).join(', ')}`)
      c.f.mode = 'if'
      c.f.iface = i.name
      return []
    },
  },
  {
    words: ['ip', 'route'],
    modes: CFG,
    help: 'Establish static routes',
    only: L3,
    syntax: ['A.B.C.D  Destination prefix', '   e.g. ip route 10.3.0.0 255.255.255.0 10.2.0.2'],
    run: (c, rest) => {
      const r = parseRoute(rest)
      if (typeof r === 'string') return fail(r)
      if (c.dev.routes.some((x) => x.network === r.network && x.prefix === r.prefix && x.via === r.via)) return []
      c.dev.routes.push(r)
      const active = routingTable(c.dev).some((x) => x.kind === 'static' && x.nextHop === r.via)
      return { lines: active ? [] : [tip(`Next hop ${r.via} is not in a connected subnet, so this route stays inactive.`)], mutated: true }
    },
  },
  {
    words: ['no', 'ip', 'route'],
    modes: CFG,
    help: 'Remove a static route',
    only: L3,
    run: (c, rest) => {
      const r = parseRoute(rest)
      if (typeof r === 'string') return fail(r)
      const n = c.dev.routes.findIndex((x) => x.network === r.network && x.prefix === r.prefix && x.via === r.via)
      if (n < 0) return fail('%No matching route to delete')
      c.dev.routes.splice(n, 1)
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['ip', 'domain-name'],
    modes: CFG,
    help: 'Define the default domain name',
    syntax: ['WORD  Default domain name, e.g. lab.local'],
    run: (c, rest) => {
      if (!rest[0] || !/^[\w.-]+$/.test(rest[0])) return fail('% Incomplete command.')
      conf(c.dev).domain = rest[0]
      return { lines: [], mutated: true }
    },
  },
  { words: ['no', 'ip', 'domain-name'], modes: CFG, help: 'Remove the domain name', run: (c) => (delete conf(c.dev).domain, { lines: [], mutated: true }) },
  {
    words: ['ip', 'ssh', 'version'],
    modes: CFG,
    help: 'Specify protocol version to be supported',
    syntax: ['<1-2>  Protocol version'],
    run: (c, rest) => {
      if (rest[0] === '1') {
        delete conf(c.dev).sshVersion
        return [tip('SSH v1 is obsolete and insecure. Use ip ssh version 2.')]
      }
      if (rest[0] !== '2') return fail('% Incomplete command.')
      if (!sshEnabled(c.dev.ios)) return fail('Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).')
      conf(c.dev).sshVersion = 2
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['crypto', 'key', 'generate', 'rsa'],
    modes: CFG,
    help: 'Generate RSA keys',
    syntax: ['modulus  Provide number of modulus bits on the command line', '<cr>'],
    run: (c, rest) => {
      if (!c.dev.ios?.domain) return fail('% Please define a domain-name first.', 'ip domain-name lab.local')
      if (rest[0] && 'modulus'.startsWith(rest[0].toLowerCase())) return generateRsa(c.dev, rest[1])
      c.s.pending = { kind: 'rsa' }
      return [
        L(`The name for the keys will be: ${c.dev.name}.${c.dev.ios.domain}`),
        L('Choose the size of the key modulus in the range of 360 to 4096 for your'),
        L('  General Purpose Keys. Choosing a key modulus greater than 512 may take'),
        L('  a few minutes.'),
        L(''),
      ]
    },
  },
  {
    words: ['crypto', 'key', 'zeroize', 'rsa'],
    modes: CFG,
    help: 'Remove RSA keys',
    run: (c) => {
      delete conf(c.dev).rsaBits
      delete conf(c.dev).sshVersion
      return { lines: [L('%SSH-5-DISABLED: SSH 2.0 has been disabled', 'info')], mutated: true }
    },
  },
  {
    words: ['username'],
    modes: CFG,
    help: 'Establish User Name Authentication',
    syntax: ['WORD  User name', '   e.g. username admin secret Str0ngPass'],
    run: (c, rest) => {
      const [user, ...more] = rest
      if (!user || !/^[\w.-]+$/.test(user)) return fail('% Incomplete command.')
      let k = 0
      if (more[k]?.toLowerCase() === 'privilege') k += 2
      const kindWord = more[k]?.toLowerCase() ?? ''
      const kind = 'secret'.startsWith(kindWord) && kindWord ? 'secret' : 'password'.startsWith(kindWord) && kindWord ? 'password' : null
      if (!kind) return fail('% Incomplete command.', `username ${user} secret <password>`)
      let pwTokens = more.slice(k + 1)
      if (pwTokens.length > 1 && pwTokens[0] === '0') pwTokens = pwTokens.slice(1)
      if (!pwTokens.length) return fail('% Incomplete command.')
      ;(conf(c.dev).users ??= {})[user] = { value: pwTokens.join(' '), kind }
      return { lines: kind === 'password' ? [tip('`password` is stored in clear text. Prefer `secret`.')] : [], mutated: true }
    },
  },
  {
    words: ['no', 'username'],
    modes: CFG,
    help: 'Remove a user',
    run: (c, rest) => {
      if (!rest[0] || !c.dev.ios?.users?.[rest[0]]) return fail(`% User ${rest[0] ?? ''} not found`)
      delete c.dev.ios.users[rest[0]]
      return { lines: [], mutated: true }
    },
  },
  ...(['secret', 'password'] as const).flatMap((kind): Spec[] => [
    {
      words: ['enable', kind],
      modes: CFG,
      help: kind === 'secret' ? 'Assign the privileged level secret (hashed)' : 'Assign the privileged level password (clear text)',
      syntax: ['LINE  The password'],
      run: (c, rest) => {
        let pw = rest
        if (pw.length > 1 && pw[0] === '0') pw = pw.slice(1)
        if (!pw.length) return fail('% Incomplete command.')
        const cur = c.dev.ios?.enable
        if (kind === 'password' && cur?.kind === 'secret') return fail('% An enable secret is already set and takes precedence.')
        conf(c.dev).enable = { value: pw.join(' '), kind }
        return { lines: kind === 'password' ? [tip('enable password is weak. Prefer enable secret.')] : [], mutated: true }
      },
    },
    {
      words: ['no', 'enable', kind],
      modes: CFG,
      help: `Remove the enable ${kind}`,
      run: (c) => {
        if (c.dev.ios?.enable?.kind === kind) delete c.dev.ios.enable
        return { lines: [], mutated: true }
      },
    },
  ]),
  {
    words: ['service', 'password-encryption'],
    modes: CFG,
    help: 'Encrypt system passwords',
    run: (c) => ((conf(c.dev).passwordEncryption = true), { lines: [], mutated: true }),
  },
  {
    words: ['no', 'service', 'password-encryption'],
    modes: CFG,
    help: 'Store passwords in clear text',
    run: (c) => (delete conf(c.dev).passwordEncryption, { lines: [], mutated: true }),
  },
  {
    words: ['banner', 'motd'],
    modes: CFG,
    help: 'Set Message of the Day banner',
    syntax: ['LINE  c banner-text c, where \'c\' is a delimiting character', '   e.g. banner motd #Authorized access only#'],
    run: (c, rest) => {
      const text = rest.join(' ')
      const d = text[0]
      const end = d ? text.indexOf(d, 1) : -1
      if (!d || end < 0) return fail('% NetSim needs the banner on one line: banner motd #text#')
      conf(c.dev).banner = text.slice(1, end)
      return { lines: [], mutated: true }
    },
  },
  { words: ['no', 'banner', 'motd'], modes: CFG, help: 'Remove the banner', run: (c) => (delete conf(c.dev).banner, { lines: [], mutated: true }) },
  {
    words: ['line', 'vty'],
    modes: CFG,
    help: 'Virtual terminal (remote SSH/Telnet logins)',
    syntax: ['<0-15>  First line number', '   e.g. line vty 0 4'],
    run: (c, rest) => {
      const a = Number(rest[0] ?? 0)
      const b = Number(rest[1] ?? a)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 15 || b < a) return fail('% Invalid input: line vty 0 4')
      c.f.mode = 'line'
      return []
    },
  },

  // ----- interface config -----
  {
    words: ['ip', 'address'],
    modes: IF,
    help: 'Set the IP address of an interface',
    syntax: ['A.B.C.D  IP address', '   e.g. ip address 10.0.0.1 255.255.255.0'],
    run: (c, rest) => {
      if (isL2(c.dev)) return fail('% Layer 2 switchport: it cannot have an IP address.')
      const [ip, mask] = rest
      if (!ip || !mask) return fail('% Incomplete command.', 'ip address <ip> <subnet mask>, e.g. ip address 10.0.0.1 255.255.255.0')
      if (!isValidIp(ip)) return fail(`% Invalid IP address ${ip}`)
      if (/^\/?\d+$/.test(mask)) return fail('% Invalid input: IOS wants a dotted subnet mask.', `/${mask.replace('/', '')} is ${prefixToMask(Math.min(32, Number(mask.replace('/', ''))))}`)
      const prefix = maskToPrefix(mask)
      if (prefix === null) return fail(`% Bad mask ${mask}`)
      const net = networkOf(ip, prefix)
      if (prefix < 31 && (net === ip || inSubnet(ip, net, prefix) && ipToInt(ip) === ipToInt(net) + 2 ** (32 - prefix) - 1))
        return fail(`Bad mask /${prefix} for address ${ip}`, `${ip} is the ${net === ip ? 'network' : 'broadcast'} address of ${net}/${prefix}`)
      const clash = c.dev.ifaces.find(
        (o) => o.name !== c.f.iface && o.ip && (inSubnet(ip, o.ip, o.prefix!) || inSubnet(o.ip, ip, prefix)),
      )
      if (clash) return fail(`% ${net} overlaps with ${longName(clash.name)}`)
      const i = c.dev.ifaces.find((x) => x.name === c.f.iface)!
      i.ip = ip
      i.prefix = prefix
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['no', 'ip', 'address'],
    modes: IF,
    help: 'Remove the IP address',
    run: (c) => {
      const i = c.dev.ifaces.find((x) => x.name === c.f.iface)!
      delete i.ip
      delete i.prefix
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['shutdown'],
    modes: IF,
    help: 'Shutdown the selected interface',
    run: (c) => {
      const i = c.dev.ifaces.find((x) => x.name === c.f.iface)!
      if (i.shutdown) return []
      i.shutdown = true
      return {
        lines: [
          L(`%LINK-5-CHANGED: Interface ${longName(i.name)}, changed state to administratively down`, 'info'),
          L(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${longName(i.name)}, changed state to down`, 'info'),
        ],
        mutated: true,
      }
    },
  },
  {
    words: ['no', 'shutdown'],
    modes: IF,
    help: 'Enable the selected interface',
    run: (c) => {
      const i = c.dev.ifaces.find((x) => x.name === c.f.iface)!
      if (!i.shutdown) return []
      delete i.shutdown
      const st = ifStatus(c.topo, c.dev, i)
      return {
        lines: [
          L(`%LINK-3-UPDOWN: Interface ${longName(i.name)}, changed state to ${st.status}`, 'info'),
          ...(st.protocol === 'up' ? [L(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${longName(i.name)}, changed state to up`, 'info')] : []),
        ],
        mutated: true,
      }
    },
  },
  {
    words: ['description'],
    modes: IF,
    help: 'Interface specific description',
    syntax: ['LINE  Up to 240 characters describing this interface'],
    run: (c, rest) => {
      if (!rest.length) return fail('% Incomplete command.')
      c.dev.ifaces.find((x) => x.name === c.f.iface)!.description = rest.join(' ').slice(0, 240)
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['no', 'description'],
    modes: IF,
    help: 'Remove the description',
    run: (c) => (delete c.dev.ifaces.find((x) => x.name === c.f.iface)!.description, { lines: [], mutated: true }),
  },

  // ----- line vty -----
  {
    words: ['login'],
    modes: LINE,
    help: 'Enable password checking',
    syntax: ['local  Local password checking (username/secret)', '<cr>   Check the line password'],
    run: (c, rest) => {
      const local = rest[0] && 'local'.startsWith(rest[0].toLowerCase())
      ;(conf(c.dev).vty ??= {}).login = local ? 'local' : 'password'
      const lines: Line[] = []
      if (local && !Object.keys(c.dev.ios!.users ?? {}).length) lines.push(tip('No local users yet. Add one in global config: username admin secret <password>'))
      if (!local && !c.dev.ios!.vty!.password) lines.push(L('% Login disabled on line 2, until \'password\' is set', 'err'))
      return { lines, mutated: true }
    },
  },
  {
    words: ['no', 'login'],
    modes: LINE,
    help: 'Disable password checking',
    run: (c) => {
      ;(conf(c.dev).vty ??= {}).login = 'none'
      return { lines: [tip('Anyone who can reach this device can now log in without a password. Not recommended.')], mutated: true }
    },
  },
  {
    words: ['password'],
    modes: LINE,
    help: 'Set a password',
    syntax: ['LINE  The password'],
    run: (c, rest) => {
      if (!rest.length) return fail('% Incomplete command.')
      ;(conf(c.dev).vty ??= {}).password = rest.join(' ')
      return { lines: [], mutated: true }
    },
  },
  { words: ['no', 'password'], modes: LINE, help: 'Remove the line password', run: (c) => (delete (conf(c.dev).vty ??= {}).password, { lines: [], mutated: true }) },
  {
    words: ['transport', 'input'],
    modes: LINE,
    help: 'Define which protocols to use when connecting to the terminal server',
    syntax: ['ssh     TCP/IP SSH protocol', 'telnet  TCP/IP Telnet protocol', 'all     All protocols', 'none    No protocols'],
    run: (c, rest) => {
      const words = rest.map((w) => w.toLowerCase())
      const pick = (w: string) => ['ssh', 'telnet', 'all', 'none'].find((k) => k.startsWith(w))
      const picked = words.map(pick)
      if (!picked.length || picked.some((p) => !p)) return fail('% Incomplete command.', 'transport input ssh')
      const set = new Set(picked)
      const t: VtyTransport = set.has('all') || (set.has('ssh') && set.has('telnet')) ? 'all' : (picked[0] as VtyTransport)
      ;(conf(c.dev).vty ??= {}).transport = t
      return { lines: t === 'all' || t === 'telnet' ? [tip('Telnet sends passwords in clear text. Use: transport input ssh')] : [], mutated: true }
    },
  },
  { words: ['exec-timeout'], modes: LINE, help: 'Set the EXEC timeout', syntax: ['<0-35791>  Timeout in minutes'], run: () => [] },

  // ----- access point (Aironet style) -----
  {
    words: ['dot11', 'ssid'],
    modes: CFG,
    help: 'Configure a wireless network name (SSID)',
    only: AP,
    syntax: ['WORD  SSID name, e.g. dot11 ssid OFFICE'],
    run: (c, rest) => {
      const name = rest[0]
      if (!name || !/^[\w.-]{1,32}$/.test(name)) return fail('% Incomplete command.', 'SSID names: letters, digits, - . _ (up to 32)')
      wlan(c.dev).ssids[name] ??= {}
      c.f.mode = 'ssid'
      c.f.ssid = name
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['no', 'dot11', 'ssid'],
    modes: CFG,
    help: 'Remove an SSID',
    only: AP,
    run: (c, rest) => {
      const w = c.dev.ios?.wlan
      if (!rest[0] || !w?.ssids[rest[0]]) return fail(`% SSID ${rest[0] ?? ''} not found`)
      delete w.ssids[rest[0]]
      if (w.radioSsid === rest[0]) delete w.radioSsid
      return { lines: [], mutated: true }
    },
  },
  ...ssidSetting(['authentication', 'open'], 'Open 802.11 authentication (needed by every SSID)', (s, on) => (s.open = on)),
  ...ssidSetting(['authentication', 'key-management', 'wpa'], 'WPA key management (add: version 2)', (s, on) => (s.wpa2 = on)),
  ...ssidSetting(['guest-mode'], 'Broadcast this SSID so clients can find it in a scan', (s, on) => (s.broadcast = on)),
  {
    words: ['wpa-psk', 'ascii'],
    modes: SSID,
    help: 'WPA2 pre-shared key (the Wi-Fi password)',
    only: AP,
    syntax: ['LINE  8 to 63 characters'],
    run: (c, rest) => {
      let k = rest
      if (k.length > 1 && k[0] === '0') k = k.slice(1)
      const key = k.join(' ')
      if (key.length < 8 || key.length > 63) return fail('% Invalid WPA-PSK: use 8 to 63 characters')
      wlan(c.dev).ssids[c.f.ssid!].psk = key
      return { lines: [], mutated: true }
    },
  },
  {
    words: ['no', 'wpa-psk'],
    modes: SSID,
    help: 'Remove the pre-shared key',
    only: AP,
    run: (c) => (delete wlan(c.dev).ssids[c.f.ssid!].psk, { lines: [], mutated: true }),
  },
  {
    words: ['ssid'],
    modes: IF,
    help: 'Serve an SSID on this radio',
    only: AP,
    syntax: ['WORD  An SSID created with dot11 ssid'],
    run: (c, rest) => {
      if (c.f.iface !== 'd0') return fail('% SSIDs go on the radio: interface Dot11Radio0')
      const w = wlan(c.dev)
      if (!rest[0]) return fail('% Incomplete command.')
      if (!w.ssids[rest[0]]) return fail(`% SSID ${rest[0]} does not exist. Create it first: dot11 ssid ${rest[0]}`)
      w.radioSsid = rest[0]
      return {
        lines: [L(`%DOT11-6-ASSOC: Interface Dot11Radio0, now serving SSID ${rest[0]}`, 'info')],
        mutated: true,
      }
    },
  },
  {
    words: ['no', 'ssid'],
    modes: IF,
    help: 'Stop serving the SSID',
    only: AP,
    run: (c) => (delete wlan(c.dev).radioSsid, { lines: [], mutated: true }),
  },
  {
    words: ['encryption', 'mode', 'ciphers'],
    modes: IF,
    help: 'Radio encryption (WPA2 needs aes-ccm)',
    only: AP,
    syntax: ['aes-ccm  WPA2 AES encryption', 'tkip     Old WPA encryption (weak)'],
    run: (c, rest) => {
      if (c.f.iface !== 'd0') return fail('% Encryption is set on the radio: interface Dot11Radio0')
      const cipher = rest[0]?.toLowerCase() ?? ''
      if (cipher && 'aes-ccm'.startsWith(cipher)) {
        wlan(c.dev).aes = true
        return { lines: [], mutated: true }
      }
      if (cipher && 'tkip'.startsWith(cipher)) return fail('% NetSim only supports aes-ccm', 'TKIP is broken and deprecated. WPA2 uses AES-CCMP.')
      return fail('% Incomplete command.')
    },
  },
  {
    words: ['no', 'encryption', 'mode'],
    modes: IF,
    help: 'Remove radio encryption',
    only: AP,
    run: (c) => (delete wlan(c.dev).aes, { lines: [], mutated: true }),
  },
  {
    words: ['show', 'dot11', 'associations'],
    modes: EXEC,
    help: 'Wireless clients on this access point',
    only: AP,
    run: (c) => {
      const lines = [L(`${c.dev.name} Associations: SSID [${c.dev.ios?.wlan?.radioSsid ?? 'none'}] :`, 'info'), L(''), L('MAC Address    IP address      Device        Name            State', 'info')]
      for (const l of linksOn(c.topo, c.dev.id, 'd0')) {
        const client = getDevice(c.topo, l.b.device)
        const i = client?.ifaces.find((x) => x.name === l.b.iface)
        if (!client || !i) continue
        const up = linkActive(c.topo, l)
        lines.push(L(`${ciscoMac(i.mac)} ${(i.ip ?? '-').padEnd(16)}${'laptop'.padEnd(14)}${client.name.padEnd(16)}${up ? 'Assoc' : 'Rejected'}`, up ? 'out' : 'err'))
      }
      if (lines.length === 3) lines.push(tip('No clients yet. On a laptop: wifi scan, then wifi connect <ssid> <password>'))
      return lines
    },
  },

  // ----- shared sub-mode navigation -----
  {
    words: ['exit'],
    modes: SUB,
    help: 'Exit from the current mode',
    run: (c) => {
      c.f.mode = c.f.mode === 'config' ? 'priv' : 'config'
      delete c.f.iface
      delete c.f.ssid
      return []
    },
  },
  { words: ['end'], modes: SUB, help: 'Exit to privileged EXEC mode', run: (c) => endConfig(c) },
]

function endConfig(c: Ctx): Line[] {
  c.f.mode = 'priv'
  delete c.f.iface
  delete c.f.ssid
  return [L(`%SYS-5-CONFIG_I: Configured from console by ${c.f.remote ? c.f.remote.user + ' on vty0' : 'console'}`, 'muted')]
}

const asLines = (r: Result): Line[] => (Array.isArray(r) ? r : r.lines)

function save(c: Ctx): Result {
  conf(c.dev).startup = runningConfig(c.dev).join('\n')
  return { lines: [L('Building configuration...'), L('[OK]', 'ok')], mutated: true }
}

function legacy(c: Ctx, line: string, quiet = false): Result {
  const r = execute(c.topo, c.state, c.dev.id, line)
  return quiet ? { ...r, lines: r.lines.filter((l) => l.kind === 'err') } : r
}

function parseRoute(rest: string[]) {
  const usage = '% Incomplete command. ip route <network> <mask> <next-hop IP>, e.g. ip route 10.3.0.0 255.255.255.0 10.2.0.2'
  const [net, mask, via] = rest
  if (!net || !mask || !via) return usage
  if (!isValidIp(net)) return `% Invalid network ${net}`
  const prefix = maskToPrefix(mask)
  if (prefix === null) return `% Bad mask ${mask}${/^\/?\d+$/.test(mask) ? ' (IOS wants a dotted mask like 255.255.255.0)' : ''}`
  if (!isValidIp(via)) return '% NetSim routes need a next-hop IP address, not an exit interface'
  if (networkOf(net, prefix) !== net) return `%Inconsistent address and mask (did you mean ${networkOf(net, prefix)}?)`
  return { network: net, prefix, via }
}

function generateRsa(dev: Device, bitsArg: string | undefined): CommandResult {
  const bits = bitsArg === undefined || bitsArg === '' ? 1024 : Number(bitsArg)
  if (!Number.isInteger(bits) || bits < 360 || bits > 4096) return { lines: fail('% Invalid modulus. Choose 360 to 4096 bits.') }
  const cfg = conf(dev)
  cfg.rsaBits = bits
  const lines = [
    L(`% The key modulus size is ${bits} bits`),
    L(`% Generating ${bits} bit RSA keys, keys will be non-exportable...`),
    L(`[OK] (elapsed time was ${Math.max(1, Math.round(bits / 1024))} seconds)`, 'ok'),
    L(''),
  ]
  if (bits >= 768) lines.push(L(`%SSH-5-ENABLED: SSH ${cfg.sshVersion ? '2.0' : '1.99'} has been enabled`, 'info'))
  else lines.push(tip('Keys under 768 bits only allow SSH v1. Use 2048.'))
  return { lines, mutated: true }
}

// ---------- show helpers ----------

function showIpRoute(dev: Device): Line[] {
  const lines = [
    L('Codes: L - local, C - connected, S - static, * - candidate default', 'muted'),
    L(''),
  ]
  const table = routingTable(dev)
  const def = table.find((r) => r.kind === 'static' && r.prefix === 0)
  lines.push(L(def ? `Gateway of last resort is ${def.nextHop} to network 0.0.0.0` : 'Gateway of last resort is not set'), L(''))
  for (const r of table) {
    if (r.kind === 'connected') {
      lines.push(L(`C        ${r.network}/${r.prefix} is directly connected, ${longName(r.iface.name)}`))
      lines.push(L(`L        ${r.iface.ip}/32 is directly connected, ${longName(r.iface.name)}`))
    } else {
      lines.push(L(`${r.prefix === 0 ? 'S*' : 'S '}       ${r.network}/${r.prefix} [1/0] via ${r.nextHop}`))
    }
  }
  if (table.length === 0) lines.push(tip('Empty: give an interface an IP address and bring it up first.'))
  for (const r of dev.routes)
    if (!table.some((x) => x.kind === 'static' && x.network === r.network && x.prefix === r.prefix && x.nextHop === r.via))
      lines.push(tip(`ip route ${r.network} ${prefixToMask(r.prefix)} ${r.via} is configured but inactive: ${r.via} is not in a connected subnet.`))
  return lines
}

function showArp(c: Ctx): Line[] {
  const lines = [L('Protocol  Address          Age (min)  Hardware Addr   Type   Interface', 'info')]
  for (const i of c.dev.ifaces)
    if (i.ip && !i.shutdown) lines.push(L(`Internet  ${i.ip.padEnd(17)}        -   ${ciscoMac(i.mac)}  ARPA   ${longName(i.name)}`))
  for (const [ip, mac] of Object.entries(c.state.arp[c.dev.id] ?? {})) {
    const i = c.dev.ifaces.find((x) => x.ip && inSubnet(ip, x.ip, x.prefix!))
    lines.push(L(`Internet  ${ip.padEnd(17)}        0   ${ciscoMac(mac)}  ARPA   ${i ? longName(i.name) : ''}`))
  }
  return lines
}

// ---------- ping / traceroute / ssh ----------

function ping(c: Ctx, arg: string | undefined): Result {
  if (isL2(c.dev)) return fail('% This layer 2 switch has no IP address to ping from.')
  if (!arg) return fail('% Incomplete command.')
  const target = resolveTarget(c.topo, arg)
  if (!target) return fail('% Unrecognized host or address, or protocol not running.')
  const before = Object.keys(c.state.arp[c.dev.id] ?? {}).length
  const r = sendPacket(c.topo, c.state, c.dev.id, target)
  const learned = Object.keys(c.state.arp[c.dev.id] ?? {}).length > before
  // Like real IOS, the first echo is lost while ARP resolves.
  const marks = !r.success ? '.....' : learned ? '.!!!!' : '!!!!!'
  const ok = [...marks].filter((m) => m === '!').length
  return {
    lines: [
      L('Type escape sequence to abort.'),
      L(`Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`),
      L(marks, r.success ? 'ok' : 'err'),
      L(`Success rate is ${ok * 20} percent (${ok}/5)${ok ? ', round-trip min/avg/max = 1/2/4 ms' : ''}`, r.success ? 'ok' : 'err'),
      ...(r.success ? [] : [tip(r.message)]),
    ],
    packet: r,
  }
}

function hopIp(topo: Topology, deviceId: string, linkId?: string): string {
  const d = getDevice(topo, deviceId)
  const l = linkId && topo.links.find((x) => x.id === linkId)
  const end = l && (l.a.device === deviceId ? l.a : l.b)
  return (end && d?.ifaces.find((i) => i.name === end.iface)?.ip) ?? d?.ifaces.find((i) => i.ip)?.ip ?? '?'
}

function traceroute(c: Ctx, arg: string | undefined): Result {
  if (isL2(c.dev)) return fail('% This layer 2 switch has no IP address to trace from.')
  const target = resolveTarget(c.topo, arg)
  if (!target) return fail(arg ? '% Unrecognized host or address, or protocol not running.' : '% Incomplete command.')
  const r = sendPacket(c.topo, c.state, c.dev.id, target)
  const lines = [L('Type escape sequence to abort.'), L(`Tracing the route to ${target}`), L('')]
  const req = r.hops.filter((h) => !h.reply && (h.action === 'route' || h.action === 'deliver' || (h.action === 'drop' && h.linkId)))
  req.forEach((h, n) => {
    if (h.action === 'drop') lines.push(L(`  ${n + 1} *  *  *`, 'err'), tip(h.detail))
    else lines.push(L(`  ${n + 1} ${hopIp(c.topo, h.deviceId, h.linkId)} ${1 + n} msec ${n} msec ${1 + n} msec`))
  })
  if (!req.length) lines.push(L('  1 *  *  *', 'err'), tip(r.hops[0]?.detail ?? r.message))
  return { lines, packet: r }
}

export function parseSshArgs(rest: string[]): { user: string; host: string } | string {
  const usage = 'Usage: ssh -l <user> <host>   or   ssh <user>@<host>'
  let user: string | undefined
  let host: string | undefined
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '-l') user = rest[++k]
    else if (rest[k].includes('@')) [user, host] = rest[k].split('@')
    else host = rest[k]
  }
  if (!user || !host) return usage
  return { user, host }
}

export interface SshCheck {
  ok: boolean
  lines: Line[]
  packet?: CommandResult['packet']
  target?: Device
  ip?: string
  auth?: 'local' | 'password' | 'none'
}

/** Everything up to the password prompt: reachability, SSH server, vty settings. */
export function sshPreflight(topo: Topology, state: SimState, from: Device, host: string, fromHost: boolean): SshCheck {
  const closed = (ip: string) => L(fromHost ? `Connection to ${ip} closed by remote host.` : `[Connection to ${ip} closed by foreign host]`, 'muted')
  if (isL2(from)) return { ok: false, lines: fail('% This layer 2 switch has no IP address to connect from.') }
  const ip = resolveTarget(topo, host)
  if (!ip) return { ok: false, lines: fail(fromHost ? `ssh: Could not resolve hostname ${host}` : '% Unknown host') }
  const refused = (why: string) => ({
    ok: false,
    lines: fail(fromHost ? `ssh: connect to host ${ip} port 22: Connection refused` : '% Connection refused by remote host', why),
  })
  const r = sendPacket(topo, state, from.id, ip, 'tcp', 22)
  if (!r.success)
    return {
      ok: false,
      packet: r,
      lines: fail(fromHost ? `ssh: connect to host ${ip} port 22: Connection timed out` : '% Connection timed out; remote host not responding', r.message),
    }
  const target = topo.devices.find((d) => d.ifaces.some((i) => i.ip === ip))!
  if (!isIos(target)) return { ...refused(`${target.name} is not running an SSH server in NetSim. SSH targets are routers, switches and firewalls.`), packet: r }
  const cfg = target.ios ?? {}
  if (!cfg.rsaBits) return { ...refused(`${target.name} has no RSA keys, so its SSH server is off. On it: ip domain-name …, crypto key generate rsa modulus 2048`), packet: r }
  if (!transportAllowsSsh(cfg.vty?.transport)) return { ...refused(`${target.name}'s vty lines do not accept SSH (transport input ${cfg.vty!.transport}).`), packet: r }
  if (!sshEnabled(cfg))
    return {
      ok: false,
      packet: r,
      lines: fail(fromHost ? 'Protocol major versions differ: 2 vs. 1' : '% Remote host only supports SSH version 1', `${target.name}'s ${cfg.rsaBits}-bit key is too small for SSH v2. Regenerate with modulus 2048.`),
    }
  const auth = cfg.vty?.login ?? 'password'
  if (auth === 'password' && !cfg.vty?.password)
    return { ok: false, packet: r, lines: [L('Password required, but none set', 'err'), closed(ip), tip(`Configure ${target.name}: line vty 0 4 → login local (with a username), or set a line password.`)] }
  return { ok: true, lines: [], packet: r, target, ip, auth }
}

export function sshConnect(topo: Topology, state: SimState, s: Session, from: Device, user: string, host: string, fromHost: boolean): CommandResult {
  const p = sshPreflight(topo, state, from, host, fromHost)
  if (!p.ok) return { lines: p.lines, packet: p.packet }
  if (p.auth === 'none') return { lines: sshLogin(s, p.target!, p.ip!, user), packet: p.packet }
  s.pending = { kind: 'ssh', deviceId: p.target!.id, ip: p.ip!, user, tries: 0, fromHost }
  return { lines: [], packet: p.packet }
}

function sshLogin(s: Session, target: Device, ip: string, user: string): Line[] {
  s.frames.push({ deviceId: target.id, mode: 'user', remote: { user, ip } })
  const banner = target.ios?.banner
  return [...(banner ? [L(''), L(banner, 'info'), L('')] : []), L(`--- ssh: logged in to ${target.name} as ${user} ---`, 'muted')]
}

/** Handles input while a password/question prompt is open. */
export function answerPending(topo: Topology, s: Session, input: string): CommandResult {
  const p = s.pending!
  const f = s.frames[s.frames.length - 1]
  const dev = getDevice(topo, f.deviceId)
  delete s.pending
  if (p.kind === 'rsa') {
    if (!dev) return { lines: [] }
    return generateRsa(dev, input.trim())
  }
  if (p.kind === 'enable') {
    if (dev?.ios?.enable && input === dev.ios.enable.value) {
      f.mode = 'priv'
      return { lines: [] }
    }
    if (p.tries + 1 >= 3) return { lines: [L('% Bad secrets', 'err')] }
    s.pending = { ...p, tries: p.tries + 1 }
    return { lines: [] }
  }
  const target = getDevice(topo, p.deviceId)
  const cfg = target?.ios ?? {}
  const expected = cfg.vty?.login === 'local' ? cfg.users?.[p.user]?.value : cfg.vty?.password
  if (target && expected !== undefined && input === expected) return { lines: sshLogin(s, target, p.ip, p.user) }
  if (p.tries + 1 >= 3) {
    const lines = p.fromHost
      ? [L(`${p.user}@${p.ip}: Permission denied (password).`, 'err')]
      : [L('% Authentication failed.', 'err'), L(`[Connection to ${p.ip} closed by foreign host]`, 'muted')]
    if (cfg.vty?.login === 'local' && !cfg.users?.[p.user]) lines.push(tip(`There is no user "${p.user}" on ${target?.name}.`))
    return { lines }
  }
  s.pending = { ...p, tries: p.tries + 1 }
  return { lines: p.fromHost ? [L('Permission denied, please try again.', 'err')] : [] }
}

export function pendingPrompt(p: Pending): string {
  if (p.kind === 'rsa') return 'How many bits in the modulus [1024]: '
  if (p.kind === 'ssh' && p.fromHost) return `${p.user}@${p.ip}'s password: `
  return 'Password: '
}

// ---------- parser ----------

function specsFor(dev: Device, mode: Mode): Spec[] {
  return SPECS.filter((s) => s.modes.includes(mode) && (!s.only || s.only.includes(dev.type)))
}

type Resolved =
  | { spec: Spec; rest: string[] }
  | { error: 'invalid'; at: number }
  | { error: 'ambiguous'; word: string }
  | { error: 'incomplete' }

function resolve(specs: Spec[], tokens: string[]): Resolved {
  let cands = specs
  for (let i = 0; ; i++) {
    const done = cands.filter((s) => s.words.length === i)
    const going = cands.filter((s) => s.words.length > i)
    if (i >= tokens.length) {
      if (done.length) return { spec: done[0], rest: [] }
      return going.length ? { error: 'incomplete' } : { error: 'invalid', at: i }
    }
    const t = tokens[i].toLowerCase()
    const exact = going.filter((s) => s.words[i] === t)
    const pre = exact.length ? exact : going.filter((s) => !s.hidden && s.words[i].startsWith(t))
    if (pre.length === 0) return done.length ? { spec: done[0], rest: tokens.slice(i) } : { error: 'invalid', at: i }
    if (new Set(pre.map((s) => s.words[i])).size > 1) return { error: 'ambiguous', word: tokens[i] }
    cands = pre
  }
}

/** Keywords that may follow `tokens`, for `?` and Tab. */
function nextWords(specs: Spec[], tokens: string[]): { word: string; help: string; specs: Spec[] }[] {
  let cands = specs.filter((s) => !s.hidden)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase()
    const exact = cands.filter((s) => s.words.length > i && s.words[i] === t)
    cands = exact.length ? exact : cands.filter((s) => s.words.length > i && s.words[i].startsWith(t))
    if (new Set(cands.map((s) => s.words[i])).size > 1) return []
  }
  const i = tokens.length
  const map = new Map<string, Spec[]>()
  for (const s of cands) if (s.words.length > i) map.set(s.words[i], [...(map.get(s.words[i]) ?? []), s])
  return [...map.entries()]
    .map(([word, ss]) => ({ word, specs: ss, help: (ss.find((s) => s.words.length === i + 1)?.help ?? HELP[word] ?? ss[0].help) }))
    .sort((a, b) => a.word.localeCompare(b.word))
}

const tokenize = (raw: string) => raw.trim().split(/\s+/).filter(Boolean)

function caret(raw: string, at: number, promptLen: number): Line[] {
  const re = /\S+/g
  let m: RegExpExecArray | null
  let col = raw.length
  for (let n = 0; (m = re.exec(raw)); n++) if (n === at) { col = m.index; break }
  return [L(' '.repeat(promptLen + col) + '^', 'err'), L("% Invalid input detected at '^' marker.", 'err')]
}

/** Common NetSim-shell commands typed on an IOS device get a pointer to the IOS way. */
const TRANSLATE: [RegExp, string][] = [
  [/^ip\s+set\b/i, 'IOS: configure terminal → interface g0/0 → ip address 10.0.0.1 255.255.255.0 → no shutdown'],
  [/^route\s+(add|del)\b/i, 'IOS (in config mode): ip route <network> <mask> <next-hop>, e.g. ip route 10.3.0.0 255.255.255.0 10.2.0.2'],
  [/^(ifconfig|ipconfig)\b/i, 'IOS: show ip interface brief'],
  [/^arp\b/i, 'IOS: show arp'],
  [/^help\b/i, 'IOS: type ? for a list of commands in the current mode'],
  [/^show\s+mac\s*$/i, 'IOS: show mac address-table'],
]

function help(c: Ctx, body: string): CommandResult {
  const tokens = tokenize(body)
  const specs = specsFor(c.dev, c.f.mode)
  const partial = body.length > 0 && !/\s$/.test(body)
  const lines: Line[] = []
  if (partial) {
    const opts = nextWords(specs, tokens.slice(0, -1)).filter((o) => o.word.startsWith(tokens[tokens.length - 1].toLowerCase()))
    if (!opts.length) lines.push(L('% Unrecognized command', 'err'))
    else lines.push(L(opts.map((o) => o.word).join('  ')))
    return { lines, refill: body }
  }
  const opts = nextWords(specs, tokens)
  const width = Math.max(14, ...opts.map((o) => o.word.length + 2))
  for (const o of opts) lines.push(L(`  ${o.word.padEnd(width)}${o.help}`))
  const r = tokens.length ? resolve(specs, tokens) : null
  if (r && 'spec' in r) for (const s of r.spec.syntax ?? ['<cr>']) lines.push(L(`  ${s}`))
  if (!lines.length) lines.push(L('% Unrecognized command', 'err'))
  return { lines, refill: body }
}

export function complete(dev: Device, mode: Mode, input: string): string {
  if (!input || /\s$/.test(input)) return input
  const tokens = tokenize(input)
  const last = tokens[tokens.length - 1].toLowerCase()
  const opts = nextWords(specsFor(dev, mode), tokens.slice(0, -1)).filter((o) => o.word.startsWith(last))
  if (opts.length !== 1) return input
  return input.slice(0, input.length - tokens[tokens.length - 1].length) + opts[0].word + ' '
}

export function runIos(c: Ctx, raw: string): CommandResult {
  const wrap = (r: Result): CommandResult => (Array.isArray(r) ? { lines: r } : r)
  if (raw.endsWith('?')) return help(c, raw.slice(0, -1))
  const tokens = tokenize(raw)
  if (!tokens.length) return { lines: [] }

  // `do <exec command>` from any config mode.
  if (c.f.mode !== 'user' && c.f.mode !== 'priv' && 'do'.startsWith(tokens[0].toLowerCase()) && tokens[0].length >= 2) {
    const tmp: Frame = { ...c.f, mode: 'priv' }
    return runIos({ ...c, f: tmp }, raw.trim().slice(tokens[0].length).trim())
  }

  let r = resolve(specsFor(c.dev, c.f.mode), tokens)
  // In interface/line mode, a global command drops back to config mode and runs there (like IOS).
  if (!('spec' in r) && (c.f.mode === 'if' || c.f.mode === 'line' || c.f.mode === 'ssid')) {
    const g = resolve(specsFor(c.dev, 'config'), tokens)
    if ('spec' in g) {
      c.f.mode = 'config'
      delete c.f.iface
      delete c.f.ssid
      r = g
    }
  }
  if ('spec' in r) return wrap(r.spec.run(c, r.rest))
  if (r.error === 'ambiguous') return { lines: [L(`% Ambiguous command:  "${r.word}"`, 'err')] }
  if (r.error === 'incomplete') return { lines: [L('% Incomplete command.', 'err'), tip('Add ? after the command to see what comes next.')] }

  const lines = caret(raw, r.at, c.promptLen)
  const hint = TRANSLATE.find(([re]) => re.test(raw.trim()))
  if (hint) lines.push(tip(hint[1]))
  else if (c.f.mode === 'user' && 'spec' in resolve(specsFor(c.dev, 'priv'), tokens))
    lines.push(tip('That command needs privileged mode: type enable'))
  else if ((c.f.mode === 'user' || c.f.mode === 'priv') && 'spec' in resolve(specsFor(c.dev, 'config'), tokens))
    lines.push(tip('That is a configuration command: type configure terminal first'))
  else if (c.f.mode === 'config' && 'spec' in resolve(specsFor(c.dev, 'if'), tokens))
    lines.push(tip('That is an interface command: select one first, e.g. interface g0/0'))
  else if (c.f.mode !== 'user' && c.f.mode !== 'priv' && 'spec' in resolve(specsFor(c.dev, 'priv'), tokens))
    lines.push(tip(`Exec commands need "do" in config mode: do ${raw.trim()}`))
  return { lines }
}

export function iosPrompt(name: string, mode: Mode): string {
  return {
    user: `${name}>`,
    priv: `${name}#`,
    config: `${name}(config)#`,
    if: `${name}(config-if)#`,
    line: `${name}(config-line)#`,
    ssid: `${name}(config-ssid)#`,
  }[mode]
}
