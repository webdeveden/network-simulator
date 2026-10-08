/**
 * "This device" facts for the Learn tab: the lessons applied to the device's
 * actual configuration, e.g. which subnet its address is in.
 */
import { routingTable } from '../engine/forwarding'
import { inSubnet, intToIp, ipToInt, maskInt, networkOf, prefixToMask } from '../engine/ip'
import { cableProblem, DEVICE_CATALOG, isHost, linkActive, linkOn, linksOn, netIfaces } from '../engine/network'
import { isIos } from '../engine/ios'
import type { Device, Topology } from '../engine/types'

export interface Fact {
  label: string
  value: string
  tone?: 'ok' | 'warn'
}

/** "10.0.0.0/24 · mask 255.255.255.0 · hosts .1–.254" */
export function describeSubnet(ip: string, prefix: number): string {
  const net = networkOf(ip, prefix)
  const mask = prefixToMask(prefix)
  if (prefix >= 31) return `${net}/${prefix} · mask ${mask} · point-to-point`
  const first = intToIp(ipToInt(net) + 1)
  const last = intToIp((ipToInt(net) | (~maskInt(prefix) >>> 0)) - 1)
  const hosts = 2 ** (32 - prefix) - 2
  return `${net}/${prefix} · mask ${mask} · ${hosts} hosts ${first} – ${last}`
}

export function deviceFacts(topo: Topology, d: Device): Fact[] {
  const facts: Fact[] = []
  const layer2 = DEVICE_CATALOG[d.type].layer === 2

  if (isHost(d)) {
    const i = d.ifaces[0]
    if (!i.ip || i.prefix === undefined) facts.push({ label: i.name, value: 'no IP address yet', tone: 'warn' })
    else {
      facts.push({ label: i.name, value: `${i.ip}/${i.prefix}` })
      facts.push({ label: 'subnet', value: describeSubnet(i.ip, i.prefix) })
      if (!d.gateway) facts.push({ label: 'gateway', value: 'none: only this subnet is reachable', tone: 'warn' })
      else if (!inSubnet(d.gateway, i.ip, i.prefix))
        facts.push({ label: 'gateway', value: `${d.gateway} is outside your subnet: it can't work`, tone: 'warn' })
      else facts.push({ label: 'gateway', value: `${d.gateway} (in your subnet)`, tone: 'ok' })
    }
    const l = linkOn(topo, d.id, i.name)
    if (d.type === 'laptop' || d.type === 'mobile')
      facts.push(
        l?.wifi
          ? { label: 'wi-fi', value: `"${l.wifi.ssid}" ${linkActive(topo, l) ? 'connected' : 'dropped by the AP'}`, tone: linkActive(topo, l) ? 'ok' : 'warn' }
          : { label: 'wi-fi', value: 'not connected', tone: 'warn' },
      )
    else facts.push(l ? { label: 'cable', value: linkActive(topo, l) ? 'connected' : (cableProblem(topo, l) ?? 'link down'), tone: linkActive(topo, l) ? 'ok' : 'warn' } : { label: 'cable', value: 'not plugged in', tone: 'warn' })
    return facts
  }

  if (layer2) {
    const wired = netIfaces(d).filter((i) => i.name !== 'd0')
    const used = wired.filter((i) => linkOn(topo, d.id, i.name)).length
    facts.push({ label: 'ports', value: `${used} of ${wired.length} cabled${d.type === 'switch' ? ', no IP needed (layer 2)' : ''}` })
    const shut = d.ifaces.filter((i) => i.shutdown).map((i) => i.name)
    if (shut.length) facts.push({ label: 'shut down', value: shut.join(', ') })
  }

  if (d.type === 'ap') {
    const w = d.ios?.wlan
    const ssid = w?.radioSsid ? w.ssids[w.radioSsid] : undefined
    if (!ssid) facts.push({ label: 'radio', value: 'no SSID served yet', tone: 'warn' })
    else {
      const secure = ssid.wpa2 && ssid.psk && w!.aes
      facts.push({ label: 'SSID', value: `${w!.radioSsid}${ssid.broadcast ? '' : ' (hidden)'}` })
      facts.push({ label: 'security', value: secure ? 'WPA2-PSK, AES' : ssid.wpa2 ? 'WPA2 incomplete' : 'open: anyone can join', tone: secure ? 'ok' : 'warn' })
    }
    const clients = linksOn(topo, d.id, 'd0').filter((l) => linkActive(topo, l)).length
    facts.push({ label: 'clients', value: String(clients) })
  }

  if (!layer2) {
    for (const i of d.ifaces) {
      if (!i.ip || i.prefix === undefined) continue
      const l = linkOn(topo, d.id, i.name)
      const state = i.shutdown ? 'shut down' : !l ? 'no cable' : linkActive(topo, l) ? 'up' : 'down'
      facts.push({ label: i.name, value: `${i.ip}/${i.prefix} → network ${networkOf(i.ip, i.prefix)}  (${state})`, tone: state === 'up' ? 'ok' : 'warn' })
    }
    if (!d.ifaces.some((i) => i.ip)) facts.push({ label: 'interfaces', value: 'no addresses yet', tone: 'warn' })
    const statics = routingTable(d).filter((r) => r.kind === 'static').length
    facts.push({ label: 'routes', value: `${routingTable(d).filter((r) => r.kind === 'connected').length} connected, ${statics} static${d.routes.length > statics ? `, ${d.routes.length - statics} inactive` : ''}` })
  }

  if (d.type === 'firewall') facts.push({ label: 'policy', value: `${d.fwRules.length} rule${d.fwRules.length === 1 ? '' : 's'}, default ${d.fwDefault}`, tone: d.fwDefault === 'deny' ? 'ok' : 'warn' })

  if (isIos(d)) {
    const c = d.ios ?? {}
    if (d.type !== 'ap' || c.enable) facts.push({ label: 'enable', value: c.enable ? (c.enable.kind === 'secret' ? 'secret (hashed)' : 'password (clear text!)') : 'no password', tone: c.enable?.kind === 'secret' ? 'ok' : 'warn' })
    if (c.rsaBits) facts.push({ label: 'SSH', value: `${c.rsaBits}-bit keys, vty ${c.vty?.transport ?? 'all'}`, tone: c.vty?.transport === 'ssh' ? 'ok' : 'warn' })
  }
  return facts
}
