/**
 * Wireless LAN Controller (WLC) and lightweight access points, the Cisco split-MAC
 * model. You define WLANs (SSIDs, security, VLAN) once on the WLC's dashboard; any
 * access point that can reach the WLC over the wired network auto-joins it (CAPWAP,
 * simplified here as "reachable at layer 2") and becomes lightweight: instead of its
 * own local SSIDs it broadcasts the WLC's enabled WLANs.
 *
 * An AP with no WLC in reach stays autonomous and uses its local dot11 config, exactly
 * as before — so nothing changes for networks without a controller.
 */
import { getDevice, isBridge, linkActive, linksOn, patchPartner, peerOf } from './network'
import type { Device, Topology, WlcWlan } from './types'

/** An SSID an access point is currently serving, however it is configured. */
export interface ServedWlan {
  ssid: string
  wpa2: boolean
  psk?: string
  broadcast: boolean
  /** Open-system auth present (autonomous APs need `authentication open`; WLC WLANs always have it). */
  open: boolean
  /** AES-CCM present on the radio (WLC WLANs always do). */
  aes: boolean
}

/**
 * Any device reachable from `fromDev`'s `fromIface` across the switched network
 * (through switches, patch panels, modems) that matches `match`. Used so an AP can
 * find a WLC. VLAN tags are ignored: WLC discovery uses the management network.
 */
function reachable(topo: Topology, fromDev: string, fromIface: string, match: (d: Device) => boolean): Device | null {
  const first = linksOn(topo, fromDev, fromIface)[0]
  if (!first || !linkActive(topo, first)) return null
  const start = peerOf(first, fromDev, fromIface)
  const queue: { device: string; iface: string }[] = [start]
  const seen = new Set<string>()
  while (queue.length) {
    const node = queue.shift()!
    const d = getDevice(topo, node.device)
    if (!d) continue
    if (match(d)) return d
    if (d.type === 'patch') {
      const out = linksOn(topo, d.id, patchPartner(node.iface))[0]
      if (out && linkActive(topo, out)) queue.push(peerOf(out, d.id, patchPartner(node.iface)))
      continue
    }
    if (!isBridge(d)) continue // an endpoint that isn't what we want: stop here
    if (seen.has(d.id)) continue
    seen.add(d.id)
    for (const l of linksOn(topo, d.id)) {
      if (!linkActive(topo, l)) continue
      const here = l.a.device === d.id ? l.a : l.b
      if (here.iface === node.iface && l === first) continue
      queue.push(peerOf(l, d.id, here.iface))
    }
  }
  return null
}

/** The WLC an access point has joined (reachable over its wired uplink), or null (autonomous). */
export function controllerFor(topo: Topology, ap: Device): Device | null {
  if (ap.type !== 'ap') return null
  const uplink = ap.ifaces.find((i) => i.name === 'g0/0')
  if (!uplink) return null
  return reachable(topo, ap.id, uplink.name, (d) => d.type === 'wlc')
}

/** The WLANs an access point broadcasts: the WLC's enabled ones if it joined one, else its local dot11 SSIDs. */
export function servedWlans(topo: Topology, ap: Device): ServedWlan[] {
  if (ap.type !== 'ap') return []
  const radio = ap.ifaces.find((i) => i.name === 'd0')
  if (!radio || radio.shutdown) {
    // A lightweight AP's radio is enabled by the controller, so it still serves WLANs even if d0 was never touched locally.
    if (!controllerFor(topo, ap) || radio?.shutdown) return []
  }
  const wlc = controllerFor(topo, ap)
  if (wlc) {
    return (wlc.wlc?.wlans ?? [])
      .filter((w) => w.enabled && w.ssid)
      .map((w) => ({ ssid: w.ssid, wpa2: w.security === 'wpa2', psk: w.psk, broadcast: w.broadcast, open: true, aes: true }))
  }
  // Autonomous: the single SSID bound to the radio.
  const conf = ap.ios?.wlan
  if (!conf?.radioSsid) return []
  const s = conf.ssids[conf.radioSsid]
  if (!s) return []
  return [{ ssid: conf.radioSsid, wpa2: !!s.wpa2, psk: s.psk, broadcast: !!s.broadcast, open: !!s.open, aes: !!conf.aes }]
}

/** Why an association with `ssid` on this AP would fail, or null if it succeeds. Covers both AP modes. */
export function serviceProblem(topo: Topology, ap: Device, ssid: string, key: string | undefined): string | null {
  const w = servedWlans(topo, ap).find((x) => x.ssid === ssid)
  if (!w) return `${ap.name} is not serving "${ssid}"`
  if (!w.open) return `${ap.name} rejects the association: SSID ${ssid} has no "authentication open"`
  if (!w.wpa2) return null
  if (!w.psk) return `${ap.name} has WPA2 on ${ssid} but no "wpa-psk ascii <key>"`
  if (!w.aes) return `${ap.name} has WPA2 on ${ssid} but Dot11Radio0 has no "encryption mode ciphers aes-ccm"`
  if (key !== w.psk) return 'wrong password'
  return null
}

/** A fresh default WLAN for the dashboard's "create" button. */
export function newWlan(dev: Device): WlcWlan {
  const ids = (dev.wlc?.wlans ?? []).map((w) => w.id)
  const id = (ids.length ? Math.max(...ids) : 0) + 1
  return { id, profile: `wlan${id}`, ssid: '', security: 'wpa2', vlan: undefined, enabled: true, broadcast: true }
}
