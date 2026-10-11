/**
 * Shared pieces of the Cisco IOS-style console: modes, sessions, output helpers and
 * interface names. The commands live in ios.ts (management, Wi-Fi) and iosNet.ts
 * (VLANs, routing protocols, DHCP, NAT).
 */
import type { CommandResult, Line, LineKind } from './commands'
import type { SimState } from './l2'
import { DEVICE_CATALOG, isConsolePort, isRadio } from './network'
import { ipToInt, isValidIp, maskInt } from './ip'
import type { Device, DeviceType, Iface, IosConfig, IosSecret, Topology, WlanConfig } from './types'

export type Mode = 'user' | 'priv' | 'config' | 'if' | 'line' | 'ssid' | 'router' | 'vlan' | 'dhcp'

export interface Frame {
  deviceId: string
  mode: Mode
  iface?: string
  /** SSID being edited in `dot11 ssid` mode. */
  ssid?: string
  /** `interface range`: every interface the commands apply to. */
  range?: string[]
  /** `router ospf|eigrp|rip|bgp` being configured. */
  proto?: 'ospf' | 'eigrp' | 'rip' | 'bgp'
  /** `vlan N` being named. */
  vlan?: number
  /** `ip dhcp pool NAME` being edited. */
  pool?: string
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

export type Result = CommandResult | Line[]

export interface Spec {
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

export const L = (text: string, kind: LineKind = 'out'): Line => ({ text, kind })
export const tip = (text: string): Line => L(`  ↳ ${text}`, 'muted')
export const fail = (text: string, ...tips: string[]): Line[] => [L(text, 'err'), ...tips.map(tip)]

export const isIos = (d: Device) => d.type === 'router' || d.type === 'switch' || d.type === 'firewall' || d.type === 'ap' || d.type === 'isp'
export const isL2 = (d: Device) => DEVICE_CATALOG[d.type].layer === 2
export const conf = (d: Device): IosConfig => (d.ios ??= {})
export const wlan = (d: Device): WlanConfig => (conf(d).wlan ??= { ssids: {} })

export const MODEL: Record<string, string> = { router: 'NS-2911', switch: 'NS-2960', firewall: 'NS-ASA', ap: 'NS-AIR-2700', isp: 'NS-ISP-PE' }
export const CAP: Record<string, string> = { router: 'R', switch: 'S', firewall: 'F', ap: 'T', isp: 'R' }

// ---------- names, masks, fake hashes ----------

export const LONG: Record<string, string> = { g: 'GigabitEthernet', fa: 'FastEthernet', d: 'Dot11Radio', vlan: 'Vlan', lo: 'Loopback' }
export const SHORT: Record<string, string> = { g: 'Gig ', fa: 'Fas ', d: 'Dot11 ', vlan: 'Vl', lo: 'Lo' }
const IFNAME = /^(g|fa|d|vlan|lo)(\d+(?:\/\d+)?(?:\.\d+)?)$/

export function longName(n: string): string {
  const m = IFNAME.exec(n)
  return m ? LONG[m[1]] + m[2] : n
}
export const shortName = (n: string) => {
  const m = IFNAME.exec(n)
  return m ? SHORT[m[1]] + m[2] : n
}

/**
 * The NetSim name for what was typed: `g0/0`, `gi0/0`, `GigabitEthernet0/0`, `fa0/1`,
 * `g0/0.10` (subinterface), `vlan 10` / `Vlan10` (SVI), `loopback 0`, or the type and
 * number as two tokens.
 */
export function ifaceName(tokens: string[]): string | undefined {
  const text = (/\d/.test(tokens[0] ?? '') ? tokens[0] : (tokens[0] ?? '') + (tokens[1] ?? '')).toLowerCase()
  const m = /^([a-z][a-z0-9-]*?)(\d+(?:\/\d+)?(?:\.\d+)?)$/.exec(text)
  if (!m) return undefined
  const kinds: [string, string][] = [['gigabitethernet', 'g'], ['fastethernet', 'fa'], ['dot11radio', 'd'], ['vlan', 'vlan'], ['loopback', 'lo']]
  const kind = kinds.find(([long]) => long.startsWith(m[1]))?.[1]
  return kind ? kind + m[2] : undefined
}

/** An existing interface from what was typed. */
export function parseIface(dev: Device, tokens: string[]): Iface | undefined {
  const n = ifaceName(tokens)
  return n ? dev.ifaces.find((i) => i.name === n) : undefined
}

/** Physical ports that can carry subinterfaces or switchport settings. */
export const physicalPort = (dev: Device, name: string) => {
  const i = dev.ifaces.find((x) => x.name === name)
  return !!i && !isConsolePort(name) && !isRadio(name) && name !== 'lo0' && !name.includes('.') && !name.startsWith('vlan')
}

export function maskToPrefix(mask: string): number | null {
  if (!isValidIp(mask)) return null
  const n = ipToInt(mask) >>> 0
  for (let p = 0; p <= 32; p++) if (maskInt(p) >>> 0 === n) return p
  return null
}

export const ciscoMac = (mac: string) => mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.')

export const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export function fakeHash(s: string, n: number, seed: number): string {
  let h = seed >>> 0
  let res = ''
  for (let k = 0; k < n; k++) {
    for (const ch of s + k) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    res += B64[h % 64]
  }
  return res
}

export const T7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87'
/** Real Cisco type 7 encoding (reversible, which is why `secret` is preferred). */
export function type7(v: string): string {
  const salt = 8
  return (
    '08' +
    [...v]
      .map((c, i) => (c.charCodeAt(0) ^ T7_KEY.charCodeAt((salt + i) % T7_KEY.length)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

export function showSecret(sec: IosSecret, encrypt: boolean): string {
  if (sec.kind === 'secret') return `secret 5 $1$${fakeHash(sec.value, 4, 7)}$${fakeHash(sec.value, 22, 99)}`
  return encrypt ? `password 7 ${type7(sec.value)}` : `password ${sec.value}`
}

