/**
 * DHCP: a client broadcasts DISCOVER on its LAN (or VLAN). A router interface in that
 * broadcast domain answers from one of its pools whose network covers the interface's
 * subnet, or relays the request to its `ip helper-address`, where a pool covering the
 * relay's subnet hands out the lease (the giaddr rule).
 */
import { intToIp, inSubnet, ipToInt, maskInt } from './ip'
import { broadcastDomain, type SimState } from './l2'
import { sendPacket } from './forwarding'
import { isHost, isRouterLike, linkActive, linkOn, physPort } from './network'
import type { Line } from './commands'
import type { Device, DhcpPool, DhcpServer, Iface, Topology } from './types'

export interface DhcpOutcome {
  ok: boolean
  lines: Line[]
  ip?: string
  prefix?: number
  gateway?: string
}

const L = (text: string, kind: Line['kind'] = 'out'): Line => ({ text, kind })
const tip = (text: string): Line => L(`  ↳ ${text}`, 'muted')

export const dhcpOf = (d: Device): DhcpServer => ((d.ios ??= {}).dhcp ??= { pools: {}, excluded: [], leases: [] })

/** The pool on `server` that serves clients behind an interface addressed `giaddr`. */
function poolFor(server: Device, giaddr: string): [string, DhcpPool & { network: string; prefix: number }] | null {
  for (const [name, p] of Object.entries(server.ios?.dhcp?.pools ?? {}))
    if (p.network && p.prefix !== undefined && inSubnet(giaddr, p.network, p.prefix)) return [name, p as DhcpPool & { network: string; prefix: number }]
  return null
}

const excluded = (s: DhcpServer, ip: string) => s.excluded.some((r) => ipToInt(ip) >= ipToInt(r.from) && ipToInt(ip) <= ipToInt(r.to))

function allocate(topo: Topology, server: Device, poolName: string, pool: DhcpPool & { network: string; prefix: number }, client: Iface): string | null {
  const s = dhcpOf(server)
  // Same client, same pool: it gets its old address back.
  const old = s.leases.find((l) => l.mac === client.mac && l.pool === poolName)
  const used = new Set(topo.devices.flatMap((d) => d.ifaces.filter((i) => i.ip && i !== client).map((i) => i.ip!)))
  if (old && !used.has(old.ip)) return old.ip
  const base = ipToInt(pool.network)
  const size = 2 ** (32 - pool.prefix)
  for (let k = 1; k < size - 1; k++) {
    const ip = intToIp((base + k) >>> 0)
    if (ip === pool.router || excluded(s, ip) || used.has(ip)) continue
    return ip
  }
  return null
}

/** Runs DISCOVER / OFFER / REQUEST / ACK for one interface and applies the lease. */
export function dhcpRequest(topo: Topology, state: SimState, dev: Device, ifaceName: string): DhcpOutcome {
  const iface = dev.ifaces.find((i) => i.name === ifaceName)
  if (!iface) return { ok: false, lines: [L(`No interface ${ifaceName}`, 'err')] }
  const link = linkOn(topo, dev.id, physPort(iface.name))
  if (!link || !linkActive(topo, link))
    return { ok: false, lines: [L(`${ifaceName}: no link, so nobody can hear the DHCP request`, 'err'), tip(iface.name === 'wlan0' ? 'Join Wi-Fi first: wifi connect <ssid> <password>' : 'Plug a cable into it first.')] }

  const lines: Line[] = [L(`DHCPDISCOVER on ${ifaceName} to 255.255.255.255 port 67 (broadcast)`, 'muted')]
  const heard = broadcastDomain(topo, dev, iface, state).filter((h) => isRouterLike(h.device) && h.iface.ip && h.iface.prefix !== undefined)
  const problems: string[] = []
  for (const h of heard) {
    const giaddr = h.iface.ip!
    let server: Device = h.device
    let relayed = false
    if (!poolFor(server, giaddr)) {
      if (!h.iface.helper) {
        problems.push(`${h.device.name} ${h.iface.name} (${giaddr}) heard it, but has no DHCP pool for that subnet and no ip helper-address`)
        continue
      }
      const owner = topo.devices.find((d) => d.ifaces.some((i) => i.ip === h.iface.helper))
      if (!owner) {
        problems.push(`${h.device.name} relays to ${h.iface.helper}, but no device has that address`)
        continue
      }
      const r = sendPacket(topo, state, h.device.id, h.iface.helper, 'udp', 67)
      if (!r.success) {
        problems.push(`${h.device.name} could not reach DHCP server ${h.iface.helper}: ${r.message}`)
        continue
      }
      server = owner
      relayed = true
      lines.push(L(`  relayed by ${h.device.name} ${h.iface.name} (giaddr ${giaddr}) to ${h.iface.helper}`, 'muted'))
    }
    const found = poolFor(server, giaddr)
    if (!found) {
      problems.push(`${server.name} has no DHCP pool with a network covering ${giaddr}`)
      continue
    }
    const [name, pool] = found
    const ip = allocate(topo, server, name, pool, iface)
    if (!ip) {
      problems.push(`pool ${name} on ${server.name} is out of addresses`)
      continue
    }
    const serverIp = relayed ? h.iface.helper! : giaddr
    lines.push(L(`DHCPOFFER of ${ip} from ${serverIp} (${server.name}, pool ${name})`, 'muted'))
    lines.push(L(`DHCPREQUEST for ${ip} to ${serverIp}`, 'muted'))
    // Apply the lease.
    iface.ip = ip
    iface.prefix = pool.prefix
    iface.dhcp = true
    if (isHost(dev)) {
      if (pool.router) dev.gateway = pool.router
      else delete dev.gateway
    } else if (pool.router) iface.dhcpGateway = pool.router
    else delete iface.dhcpGateway
    const s = dhcpOf(server)
    s.leases = s.leases.filter((l) => l.mac !== iface.mac)
    s.leases.push({ ip, mac: iface.mac, host: dev.name, pool: name })
    lines.push(L(`DHCPACK: ${ifaceName} bound to ${ip}/${pool.prefix}${pool.router ? `, gateway ${pool.router}` : ''}${pool.dns ? `, DNS ${pool.dns}` : ''}`, 'ok'))
    if (!pool.router) lines.push(tip(`Pool ${name} has no default-router, so ${dev.name} can only reach its own subnet.`))
    return { ok: true, lines, ip, prefix: pool.prefix, gateway: pool.router }
  }
  lines.push(L('No DHCPOFFERS received.', 'err'))
  if (!heard.length) lines.push(tip('No router interface is in this LAN/VLAN. Check cables, switch port VLANs and trunks.'))
  for (const p of problems) lines.push(tip(p))
  return { ok: false, lines }
}

/** Gives the address back: the lease is removed and the interface unconfigured. */
export function dhcpRelease(topo: Topology, dev: Device, ifaceName: string): Line[] {
  const iface = dev.ifaces.find((i) => i.name === ifaceName)
  if (!iface?.dhcp) return [L(`${ifaceName} has no DHCP lease`, 'err')]
  for (const d of topo.devices) if (d.ios?.dhcp) d.ios.dhcp.leases = d.ios.dhcp.leases.filter((l) => l.mac !== iface.mac)
  const was = iface.ip
  delete iface.ip
  delete iface.prefix
  delete iface.dhcp
  delete iface.dhcpGateway
  if (isHost(dev)) delete dev.gateway
  return [L(`DHCPRELEASE of ${was ?? '-'} on ${ifaceName}`, 'ok')]
}

/** Leases still in use (the client still has that address). */
export function activeLeases(topo: Topology, server: Device) {
  return (server.ios?.dhcp?.leases ?? []).filter((l) => topo.devices.some((d) => d.ifaces.some((i) => i.mac === l.mac && i.ip === l.ip)))
}

export const poolSize = (p: DhcpPool) => (p.prefix === undefined ? 0 : Math.max(0, 2 ** (32 - p.prefix) - 2))
export const broadcastOf = (network: string, prefix: number) => intToIp((ipToInt(network) | (~maskInt(prefix) >>> 0)) >>> 0)