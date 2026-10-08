import { emptySimState, sendPacket } from './forwarding'
import { sshPreflight } from './ios'
import { inSubnet, isValidIp, networkOf, parseCidr } from './ip'
import { getDevice, linkActive, linkOn } from './network'
import type { DeviceType, IosConfig, Topology } from './types'

export type Objective =
  | { type: 'ping'; label: string; from: string; to: string; expect: 'success' | 'fail' }
  | { type: 'tcp'; label: string; from: string; to: string; port: number; expect: 'success' | 'fail' }
  | { type: 'inSubnet'; label: string; devices: string[]; subnet: string; minPrefix?: number }
  | { type: 'distinctSubnets'; label: string; devices: string[] }
  | { type: 'deviceCount'; label: string; deviceType: DeviceType; min: number }
  /** `user` can log in over SSH with a local account (password not checked). */
  | { type: 'ssh'; label: string; from: string; to: string; user: string }
  | { type: 'ios'; label: string; device: string; check: IosCheck }
  /** The device is associated to this SSID and the AP still accepts it. */
  | { type: 'wifi'; label: string; device: string; ssid: string }

export type IosCheck = 'enableSecret' | 'sshOnly' | 'passwordEncryption' | 'saved' | 'wpa2'

export interface ObjectiveStatus {
  objective: Objective
  done: boolean
  detail: string
}

function resolveIp(topo: Topology, nameOrIp: string): string | null {
  if (isValidIp(nameOrIp)) return nameOrIp
  return getDevice(topo, nameOrIp)?.ifaces.find((i) => i.ip)?.ip ?? null
}

/** Evaluates on a fresh SimState so the player's ARP/MAC tables are untouched. */
export function evaluate(topo: Topology, objectives: Objective[]): ObjectiveStatus[] {
  return objectives.map((o) => ({ objective: o, ...check(topo, o) }))
}

function check(topo: Topology, o: Objective): { done: boolean; detail: string } {
  switch (o.type) {
    case 'ping':
    case 'tcp': {
      const src = getDevice(topo, o.from)
      const dst = resolveIp(topo, o.to)
      if (!src) return { done: false, detail: `${o.from} not found` }
      if (!dst) return { done: false, detail: `${o.to} has no IP yet` }
      const r =
        o.type === 'ping'
          ? sendPacket(topo, emptySimState(), src.id, dst, 'icmp')
          : sendPacket(topo, emptySimState(), src.id, dst, 'tcp', o.port)
      const done = r.success === (o.expect === 'success')
      return { done, detail: r.message }
    }
    case 'inSubnet': {
      const net = parseCidr(o.subnet)!
      for (const name of o.devices) {
        const d = getDevice(topo, name)
        const i = d?.ifaces.find((x) => x.ip)
        if (!i?.ip || i.prefix === undefined) return { done: false, detail: `${name} has no IP` }
        if (!inSubnet(i.ip, net.ip, net.prefix) || i.prefix < net.prefix)
          return { done: false, detail: `${name} (${i.ip}/${i.prefix}) is not inside ${o.subnet}` }
        if (o.minPrefix !== undefined && i.prefix < o.minPrefix)
          return { done: false, detail: `${name} uses /${i.prefix}, needs /${o.minPrefix} or smaller` }
      }
      return { done: true, detail: 'ok' }
    }
    case 'distinctSubnets': {
      const seen = new Map<string, string>()
      for (const name of o.devices) {
        const i = getDevice(topo, name)?.ifaces.find((x) => x.ip)
        if (!i?.ip || i.prefix === undefined) return { done: false, detail: `${name} has no IP` }
        const net = `${networkOf(i.ip, i.prefix)}/${i.prefix}`
        for (const [other, otherNet] of seen) {
          const [oip, op] = otherNet.split('/')
          if (inSubnet(i.ip, oip, Number(op)) || inSubnet(oip, i.ip, i.prefix))
            return { done: false, detail: `${name} and ${other} share subnet ${net}` }
        }
        seen.set(name, net)
      }
      return { done: true, detail: 'ok' }
    }
    case 'ssh': {
      const src = getDevice(topo, o.from)
      if (!src) return { done: false, detail: `${o.from} not found` }
      const p = sshPreflight(topo, emptySimState(), src, o.to, true)
      if (!p.ok) return { done: false, detail: p.lines.map((l) => l.text.replace(/^\s*↳ /, '')).join(' — ') }
      if (p.auth !== 'local') return { done: false, detail: `${p.target!.name} vty lines must use local accounts: login local` }
      if (!p.target!.ios?.users?.[o.user]) return { done: false, detail: `No user "${o.user}" on ${p.target!.name}` }
      return { done: true, detail: 'ok' }
    }
    case 'ios': {
      const d = getDevice(topo, o.device)
      if (!d) return { done: false, detail: `${o.device} not found` }
      return iosCheck(d.ios ?? {}, o.check)
    }
    case 'wifi': {
      const d = getDevice(topo, o.device)
      if (!d) return { done: false, detail: `${o.device} not found` }
      const l = linkOn(topo, d.id, 'wlan0')
      if (!l?.wifi) return { done: false, detail: `${o.device} is not connected to Wi-Fi` }
      if (l.wifi.ssid !== o.ssid) return { done: false, detail: `${o.device} is on "${l.wifi.ssid}", not "${o.ssid}"` }
      return linkActive(topo, l) ? { done: true, detail: 'ok' } : { done: false, detail: 'association dropped: the AP no longer accepts it' }
    }
    case 'deviceCount': {
      const n = topo.devices.filter((d) => d.type === o.deviceType).length
      return { done: n >= o.min, detail: `${n}/${o.min}` }
    }
  }
}

function iosCheck(c: IosConfig, check: IosCheck): { done: boolean; detail: string } {
  switch (check) {
    case 'enableSecret':
      if (c.enable?.kind === 'secret') return { done: true, detail: 'ok' }
      return { done: false, detail: c.enable ? 'enable password is set, but an enable secret is required' : 'no enable secret' }
    case 'sshOnly':
      return c.vty?.transport === 'ssh'
        ? { done: true, detail: 'ok' }
        : { done: false, detail: `vty transport input is ${c.vty?.transport ?? 'all (default)'}` }
    case 'passwordEncryption':
      return { done: !!c.passwordEncryption, detail: c.passwordEncryption ? 'ok' : 'service password-encryption is off' }
    case 'saved':
      return { done: !!c.startup, detail: c.startup ? 'ok' : 'running-config not saved (write memory)' }
    case 'wpa2': {
      const ssid = c.wlan?.radioSsid
      const sc = ssid ? c.wlan!.ssids[ssid] : undefined
      if (!sc) return { done: false, detail: 'the radio serves no SSID' }
      if (!sc.wpa2 || !sc.psk) return { done: false, detail: `${ssid} is an open network` }
      return c.wlan!.aes ? { done: true, detail: 'ok' } : { done: false, detail: 'radio has no AES encryption' }
    }
  }
}

export function stars(cost: number, parCost: number, seconds: number, parTime: number): number {
  return 1 + (cost <= parCost ? 1 : 0) + (seconds <= parTime ? 1 : 0)
}
