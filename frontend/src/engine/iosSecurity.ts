/**
 * Switch port security (`switchport port-security …`): limits which MAC addresses may
 * use an access port. The check itself runs in l2.ts as frames arrive on the port;
 * this file has the commands, `show port-security` and the running-config lines.
 */
import { ciscoMac, fail, L, longName, tip, type Ctx, type Mode, type Result, type Spec } from './iosBase'
import type { Device, Iface, PortSecurity } from './types'

const IF: Mode[] = ['if']
const EXEC: Mode[] = ['user', 'priv']
const SW: Device['type'][] = ['switch']

const ok = (lines: ReturnType<typeof L>[] = []): Result => ({ lines, mutated: true })
const cur = (c: Ctx): Iface => c.dev.ifaces.find((i) => i.name === c.f.iface)!
const portAbbr = (n: string) => n.replace(/^fa/, 'Fa').replace(/^g(?=\d)/, 'Gi')

/** `0011.2233.4455`, `00:11:22:33:44:55` or `00-11-…` -> NetSim's `00:11:22:33:44:55`, or null. */
export function parseMac(text: string | undefined): string | null {
  const hex = (text ?? '').toLowerCase().replace(/[.:-]/g, '')
  if (!/^[0-9a-f]{12}$/.test(hex)) return null
  return hex.match(/../g)!.join(':')
}

/**
 * The port's port-security settings, or why it can't have them. Like IOS, the port must
 * be set to access mode explicitly first (a port left at its default could become a trunk).
 */
function settings(c: Ctx, create: boolean): PortSecurity | string {
  const i = cur(c)
  if (!i.name.startsWith('fa') && !i.name.startsWith('g')) return `% ${longName(i.name)} is not a switch port.`
  if (!i.switchport) return `Command rejected: ${longName(i.name)} is a dynamic port.`
  if (i.switchport.mode !== 'access') return `Command rejected: ${longName(i.name)} is a trunk port.`
  if (!i.switchport.portSecurity && !create) return '% Port security is not enabled here: switchport port-security'
  return (i.switchport.portSecurity ??= { macs: [] })
}

/** Runs a change on this port's settings, turning a "why not" into the error. */
function change(c: Ctx, create: boolean, f: (ps: PortSecurity) => Result): Result {
  const ps = settings(c, create)
  if (typeof ps === 'string') return fail(ps, ps.includes('dynamic') ? 'Set the mode first: switchport mode access' : '')
  return f(ps)
}

function showSummary(c: Ctx): ReturnType<typeof L>[] {
  const lines = [L('Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action', 'info'), L('                (Count)       (Count)          (Count)', 'muted')]
  for (const i of c.dev.ifaces) {
    const ps = i.switchport?.portSecurity
    if (!ps) continue
    const st = c.state.portSec?.[c.dev.id]?.[i.name]
    const current = ps.macs.length + (st?.learned.length ?? 0)
    lines.push(L(`${portAbbr(i.name).padEnd(13)}${String(ps.max ?? 1).padStart(13)}${String(current).padStart(13)}${String(st?.violations ?? 0).padStart(19)}  ${(ps.violation ?? 'shutdown').padStart(15)}`, i.errDisabled ? 'err' : 'out'))
  }
  if (lines.length === 2) lines.push(tip('No secure ports. On an access port: switchport mode access → switchport port-security'))
  return lines
}

function showPort(c: Ctx, i: Iface): ReturnType<typeof L>[] {
  const ps = i.switchport?.portSecurity
  if (!ps) return [L(`Port Security              : Disabled`), tip(`interface ${i.name} → switchport mode access → switchport port-security`)]
  const st = c.state.portSec?.[c.dev.id]?.[i.name]
  const status = i.errDisabled ? 'Secure-shutdown' : i.shutdown ? 'Secure-down' : 'Secure-up'
  return [
    L(`Port Security              : Enabled`),
    L(`Port Status                : ${status}`, i.errDisabled ? 'err' : 'ok'),
    L(`Violation Mode             : ${ps.violation === 'restrict' ? 'Restrict' : ps.violation === 'protect' ? 'Protect' : 'Shutdown'}`),
    L(`Maximum MAC Addresses      : ${ps.max ?? 1}`),
    L(`Total MAC Addresses        : ${ps.macs.length + (st?.learned.length ?? 0)}`),
    L(`Configured MAC Addresses   : ${ps.macs.filter((m) => !m.sticky).length}`),
    L(`Sticky MAC Addresses       : ${ps.macs.filter((m) => m.sticky).length}`),
    L(`Last Source Address:Vlan   : ${st?.last ? `${ciscoMac(st.last)}:${i.switchport?.vlan ?? 1}` : '0000.0000.0000:0'}`),
    L(`Security Violation Count   : ${st?.violations ?? 0}`),
    ...(i.errDisabled ? [tip(`The port is err-disabled. Fix the cause, then: interface ${i.name} → shutdown → no shutdown`)] : []),
  ]
}

function showAddresses(c: Ctx): ReturnType<typeof L>[] {
  const lines = [L('          Secure Mac Address Table', 'info'), L('Vlan    Mac Address       Type                     Ports', 'info'), L('----    -----------       ----                     -----', 'info')]
  for (const i of c.dev.ifaces) {
    const ps = i.switchport?.portSecurity
    if (!ps) continue
    const vlan = String(i.switchport?.vlan ?? 1).padStart(4)
    for (const m of ps.macs) lines.push(L(`${vlan}    ${ciscoMac(m.mac)}    ${(m.sticky ? 'SecureSticky' : 'SecureConfigured').padEnd(25)}${portAbbr(i.name)}`))
    for (const mac of c.state.portSec?.[c.dev.id]?.[i.name]?.learned ?? []) lines.push(L(`${vlan}    ${ciscoMac(mac)}    ${'SecureDynamic'.padEnd(25)}${portAbbr(i.name)}`))
  }
  if (lines.length === 3) lines.push(tip('No secure MACs yet: they are learned as devices send traffic through the port'))
  return lines
}

export const SECURITY_SPECS: Spec[] = [
  {
    words: ['switchport', 'port-security'],
    modes: IF,
    help: 'Limit which MAC addresses may use this access port',
    only: SW,
    syntax: ['<cr>', 'maximum <n>  How many MACs (default 1)', 'violation shutdown|restrict|protect', 'mac-address sticky | mac-address H.H.H'],
    run: (c, rest) => {
      const [w, ...args] = rest.map((x) => x.toLowerCase())
      if (!w)
        return change(c, true, () =>
          ok([tip('One MAC is allowed by default. Others: switchport port-security maximum <n>, and mac-address sticky to save them in the config.')]),
        )
      if ('maximum'.startsWith(w)) {
        const n = Number(args[0])
        if (!Number.isInteger(n) || n < 1 || n > 132) return fail('% Invalid maximum (1-132)')
        return change(c, true, (ps) => ((ps.max = n), ok()))
      }
      if ('violation'.startsWith(w)) {
        const v = (['shutdown', 'restrict', 'protect'] as const).find((x) => args[0] && x.startsWith(args[0]))
        if (!v) return fail('% Incomplete command. violation shutdown|restrict|protect')
        return change(c, true, (ps) => {
          if (v === 'shutdown') delete ps.violation
          else ps.violation = v
          return ok([tip({ shutdown: 'A violation err-disables the port (shutdown, then no shutdown, to recover).', restrict: 'A violation drops the frame and counts it; the port stays up.', protect: 'A violation drops the frame silently, without counting.' }[v])])
        })
      }
      if ('mac-address'.startsWith(w)) {
        if (args[0] && 'sticky'.startsWith(args[0]) && !args[1]) return change(c, true, (ps) => ((ps.sticky = true), ok([tip('Learned MACs are now written to the running-config: save it to keep them.')])))
        const mac = parseMac(args[0] === 'sticky' ? args[1] : args[0])
        if (!mac) return fail('% Invalid MAC address. mac-address H.H.H (e.g. 0011.2233.4455) or mac-address sticky')
        return change(c, true, (ps) => {
          if (!ps.macs.some((m) => m.mac === mac)) ps.macs.push({ mac, ...(args[0] === 'sticky' ? { sticky: true } : {}) })
          return ok(ps.macs.length > (ps.max ?? 1) ? [tip(`${ps.macs.length} MACs but a maximum of ${ps.max ?? 1}: raise it with switchport port-security maximum ${ps.macs.length}`)] : [])
        })
      }
      return fail(`% Invalid input "${w}"`)
    },
  },
  {
    words: ['no', 'switchport', 'port-security'],
    modes: IF,
    help: 'Remove port security (or one of its settings)',
    only: SW,
    run: (c, rest) => {
      const i = cur(c)
      const ps = i.switchport?.portSecurity
      if (!ps) return []
      const [w, a] = rest.map((x) => x.toLowerCase())
      if (!w) {
        delete i.switchport!.portSecurity
        if (i.errDisabled === 'psecure-violation') delete i.errDisabled
        if (c.state.portSec?.[c.dev.id]) delete c.state.portSec[c.dev.id][i.name]
      } else if ('maximum'.startsWith(w)) delete ps.max
      else if ('violation'.startsWith(w)) delete ps.violation
      else if ('mac-address'.startsWith(w)) {
        if (a && 'sticky'.startsWith(a)) {
          delete ps.sticky
          ps.macs = ps.macs.filter((m) => !m.sticky)
        } else {
          const mac = parseMac(a)
          ps.macs = ps.macs.filter((m) => m.mac !== mac)
        }
      }
      return ok()
    },
  },
  {
    words: ['show', 'port-security'],
    modes: EXEC,
    help: 'Port security settings and violations',
    only: SW,
    syntax: ['interface <port>  One port in detail', 'address           Secure MAC addresses', '<cr>'],
    run: (c, rest) => {
      const [w, ...more] = rest
      if (!w) return showSummary(c)
      if ('address'.startsWith(w.toLowerCase())) return showAddresses(c)
      if ('interface'.startsWith(w.toLowerCase())) {
        const name = more.join('').toLowerCase().replace(/^fastethernet/, 'fa').replace(/^gigabitethernet/, 'g').replace(/^gi(?=\d)/, 'g')
        const i = c.dev.ifaces.find((x) => x.name === name)
        return i ? showPort(c, i) : [L('% Invalid interface', 'err')]
      }
      return [L(`% Invalid input "${w}"`, 'err')]
    },
  },
]

/** Port-security lines inside an interface block (after `switchport mode access`). */
export function securityIface(i: Iface): string[] {
  const ps = i.switchport?.portSecurity
  if (!ps || i.switchport?.mode !== 'access') return []
  const out = [' switchport port-security']
  if (ps.max && ps.max !== 1) out.push(` switchport port-security maximum ${ps.max}`)
  if (ps.violation) out.push(` switchport port-security violation ${ps.violation}`)
  if (ps.sticky) out.push(' switchport port-security mac-address sticky')
  for (const m of ps.macs) out.push(` switchport port-security mac-address ${m.sticky ? 'sticky ' : ''}${ciscoMac(m.mac)}`)
  return out
}