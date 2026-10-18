/**
 * IOS access-list commands: numbered (`access-list 1-99|100-199 …`) and named
 * (`ip access-list standard|extended NAME`, its own mode with `permit`/`deny`/`remark`
 * and sequence numbers), applied to interfaces (`ip access-group … in|out`) or to SSH
 * logins (`access-class … in` under `line vty`). Matching lives in acl.ts.
 */
import { aclCheck, aclKind, aclLineText, parseAclLine, seqOf, type AclKind } from './acl'
import { conf, fail, L, longName, tip, type Ctx, type Mode, type Result, type Spec } from './iosBase'
import type { AclEntry, Device, Iface } from './types'

const CFG: Mode[] = ['config']
const IF: Mode[] = ['if']
const NACL: Mode[] = ['nacl-std', 'nacl-ext']
const EXEC: Mode[] = ['user', 'priv']
const L3: Device['type'][] = ['router', 'firewall', 'isp']

const ok = (lines: ReturnType<typeof L>[] = []): Result => ({ lines, mutated: true })
const cur = (c: Ctx): Iface => c.dev.ifaces.find((i) => i.name === c.f.iface)!

/** The list a name or number refers to (created empty when `create`). */
function listOf(d: Device, name: string, create = false): AclEntry[] | undefined {
  const acls = create ? (conf(d).acls ??= {}) : d.ios?.acls
  if (!acls) return undefined
  if (create) acls[name] ??= []
  return acls[name]
}

/** Interfaces and vty lines that use a list, for warnings and `show access-lists`. */
function usersOf(d: Device, name: string): string[] {
  const out: string[] = []
  for (const i of d.ifaces) {
    if (i.aclIn === name) out.push(`${longName(i.name)} in`)
    if (i.aclOut === name) out.push(`${longName(i.name)} out`)
  }
  if (d.ios?.vty?.accessClass === name) out.push('line vty (access-class)')
  if (d.ios?.nat?.overload && String(d.ios.nat.overload.acl) === name) out.push('NAT source list')
  return out
}

/** Adds a parsed line, keeping sequence order; `seq` given = insert or replace at that number. */
function addLine(list: AclEntry[], e: AclEntry, seq?: number) {
  if (seq === undefined) {
    // Next multiple of 10 after the last line, like IOS.
    const last = list.length ? seqOf(list, list.length - 1) : 0
    const next = (Math.floor(last / 10) + 1) * 10
    if (list.length && list.some((x) => x.seq !== undefined)) e.seq = next
    list.push(e)
    return
  }
  // Numbering every line keeps the order once one line has its own number.
  list.forEach((x, k) => (x.seq ??= seqOf(list, k)))
  e.seq = seq
  const at = list.findIndex((x) => x.seq === seq)
  if (at >= 0) list[at] = e
  else {
    list.push(e)
    list.sort((a, b) => a.seq! - b.seq!)
  }
}

/** Hints after adding a line: a too-broad permit/deny before it, or the implicit deny catching everyone. */
function hintsAfterAdd(d: Device, name: string, kind: AclKind): ReturnType<typeof tip>[] {
  const list = d.ios!.acls![name]
  const real = list.filter((e) => e.remark === undefined)
  const hints = []
  const last = real[real.length - 1]
  if (real.length === 1 && last.action === 'deny')
    hints.push(tip(`Only a deny so far: every other packet hits the implicit deny at the end. Add a permit line, e.g. ${kind === 'standard' ? 'permit any' : 'permit ip any any'}`))
  const catchAll = real.findIndex((e) => e.src === 'any' && !e.wildcard && (kind === 'standard' || ((e.proto === 'ip' || !e.proto) && (e.dst ?? 'any') === 'any' && !e.port && !e.srcPort)))
  if (catchAll >= 0 && catchAll < real.length - 1)
    hints.push(tip(`Line ${seqOf(list, list.indexOf(real[catchAll]))} (${aclLineText(real[catchAll])}) matches everything, so the lines after it never run. Order matters: specific lines first.`))
  if (!usersOf(d, name).length) hints.push(tip(`Not applied anywhere yet: interface … → ip access-group ${name} in|out`))
  return hints
}

function showLists(c: Ctx, only?: string): ReturnType<typeof L>[] {
  const acls = Object.entries(c.dev.ios?.acls ?? {}).filter(([n]) => !only || n === only)
  if (!acls.length) return only ? [L(`% Access list ${only} does not exist`, 'err')] : [tip('No access lists. access-list 1 permit 192.168.1.0 0.0.0.255, or ip access-list extended NAME')]
  const hits = c.state.aclHits?.[c.dev.id] ?? {}
  const lines: ReturnType<typeof L>[] = []
  for (const [n, list] of acls) {
    const kind = aclKind(c.dev, n) ?? 'standard'
    lines.push(L(`${kind === 'standard' ? 'Standard' : 'Extended'} IP access list ${n}`, 'info'))
    list.forEach((e, k) => {
      if (e.remark !== undefined) return
      const seq = seqOf(list, k)
      const m = hits[`${n}#${seq}`]
      const text = aclLineText(e).replace(/^(permit|deny) (\S+) (\S+)$/, (all, a, ip, w) => (kind === 'standard' && /\d/.test(w) ? `${a} ${ip}, wildcard bits ${w}` : all))
      lines.push(L(`    ${seq} ${text}${m ? ` (${m} match${m === 1 ? '' : 'es'})` : ''}`, e.action === 'permit' ? 'out' : 'err'))
    })
    const denied = hits[`${n}#deny`]
    if (denied) lines.push(L(`    (implicit deny: ${denied} match${denied === 1 ? '' : 'es'})`, 'muted'))
    const users = usersOf(c.dev, n)
    lines.push(tip(users.length ? `Applied: ${users.join(', ')}` : `Not applied to any interface or line`))
  }
  return lines
}

/** A numbered list name: a number in a standard or extended range. */
function numbered(d: Device, raw: string | undefined): { name: string; kind: AclKind } | string {
  if (!raw || !/^\d+$/.test(raw)) return '% Incomplete command. access-list <1-99 | 100-199> …'
  const kind = aclKind(d, raw)
  if (!kind) return `% Invalid access list number ${raw}: 1-99 (standard) or 100-199 (extended)`
  return { name: raw, kind }
}

export const ACL_SPECS: Spec[] = [
  {
    words: ['access-list'],
    modes: CFG,
    help: 'Add an access list entry',
    only: L3,
    syntax: [
      '<1-99>    Standard: permit|deny <source> [wildcard] | host <ip> | any',
      '<100-199> Extended: permit|deny ip|icmp|tcp|udp <source> <destination> [eq <port>]',
      '   e.g. access-list 1 permit 192.168.1.0 0.0.0.255',
      '   e.g. access-list 110 deny tcp any host 10.3.0.10 eq 22',
      '<n> remark <text>  A comment line',
    ],
    run: (c, rest) => {
      const id = numbered(c.dev, rest[0])
      if (typeof id === 'string') return fail(id)
      const e = parseAclLine(id.kind, rest.slice(1))
      if (typeof e === 'string') return fail(e)
      addLine(listOf(c.dev, id.name, true)!, e)
      return ok(e.remark !== undefined ? [] : hintsAfterAdd(c.dev, id.name, id.kind))
    },
  },
  {
    words: ['no', 'access-list'],
    modes: CFG,
    help: 'Delete a whole numbered access list',
    only: L3,
    run: (c, rest) => {
      const name = rest[0]
      if (!name || !c.dev.ios?.acls?.[name]) return fail(`% Access list ${name ?? ''} does not exist`)
      delete c.dev.ios.acls[name]
      const users = usersOf(c.dev, name)
      return ok(users.length ? [tip(`Still applied on ${users.join(', ')}: a missing list filters nothing, so that traffic is now allowed.`)] : [])
    },
  },
  ...(['standard', 'extended'] as const).flatMap((kind): Spec[] => [
    {
      words: ['ip', 'access-list', kind],
      modes: CFG,
      help: kind === 'standard' ? 'Named standard access list (source addresses)' : 'Named extended access list (protocol, source, destination, port)',
      only: L3,
      syntax: ['WORD  Name, e.g. ' + (kind === 'standard' ? 'MGMT-HOSTS' : 'BLOCK-SSH')],
      run: (c, rest) => {
        const name = rest[0]
        if (!name || !/^[A-Za-z][\w.-]{0,63}$/.test(name)) return fail('% Incomplete command. ip access-list ' + kind + ' <name> (starting with a letter)')
        const was = c.dev.ios?.aclTypes?.[name]
        if (was && was !== kind) return fail(`% ${name} is already a ${was} list`)
        ;(conf(c.dev).aclTypes ??= {})[name] = kind
        listOf(c.dev, name, true)
        c.f.mode = kind === 'standard' ? 'nacl-std' : 'nacl-ext'
        c.f.acl = name
        return ok()
      },
    },
    {
      words: ['no', 'ip', 'access-list', kind],
      modes: CFG,
      help: `Delete a named ${kind} access list`,
      only: L3,
      run: (c, rest) => {
        const name = rest[0]
        if (!name || c.dev.ios?.aclTypes?.[name] !== kind) return fail(`% Access list ${name ?? ''} does not exist`)
        delete c.dev.ios.acls?.[name]
        delete c.dev.ios.aclTypes![name]
        return ok()
      },
    },
  ]),
  // Inside a named list: [seq] permit|deny … , remark …, no <seq>
  ...(['permit', 'deny', 'remark'] as const).map(
    (word): Spec => ({
      words: [word],
      modes: NACL,
      help: word === 'remark' ? 'A comment line' : `${word === 'permit' ? 'Allow' : 'Block'} matching packets`,
      only: L3,
      syntax: ['standard: <source> [wildcard] | host <ip> | any', 'extended: ip|icmp|tcp|udp <source> <destination> [eq <port>] [established]'],
      run: (c, rest) => addNamed(c, undefined, [word, ...rest]),
    }),
  ),
  {
    words: ['no'],
    modes: NACL,
    help: 'Delete a line by its sequence number',
    only: L3,
    syntax: ['<1-2147483647>  Sequence number, e.g. no 20'],
    run: (c, rest) => {
      const list = listOf(c.dev, c.f.acl!)
      const seq = Number(rest[0])
      const at = list ? list.findIndex((_, k) => seqOf(list, k) === seq) : -1
      if (!list || at < 0) return fail(`% No line ${rest[0] ?? ''} in ${c.f.acl}`)
      list.forEach((x, k) => (x.seq ??= seqOf(list, k)))
      list.splice(at, 1)
      return ok()
    },
  },
  {
    words: ['ip', 'access-group'],
    modes: IF,
    help: 'Filter packets on this interface with an access list',
    only: L3,
    syntax: ['<acl> in   Check packets arriving on this interface', '<acl> out  Check packets leaving through it', '   e.g. ip access-group 110 in'],
    run: (c, rest) => {
      const [name, dir] = rest
      const d = dir?.toLowerCase()
      if (!name || (d !== 'in' && d !== 'out')) return fail('% Incomplete command. ip access-group <acl> in|out')
      const i = cur(c)
      if (d === 'in') i.aclIn = name
      else i.aclOut = name
      const lines = []
      if (!c.dev.ios?.acls?.[name]) lines.push(tip(`Access list ${name} doesn't exist yet: until it does, nothing is filtered.`))
      if (aclKind(c.dev, name) === 'standard') lines.push(tip('Standard lists match the source only: apply them close to the destination.'))
      else lines.push(tip('Extended lists can match the destination too: apply them close to the source.'))
      lines.push(tip('ACLs are stateless: replies are checked too. Allow them, or use "established" for TCP.'))
      return ok(lines)
    },
  },
  {
    words: ['no', 'ip', 'access-group'],
    modes: IF,
    help: 'Stop filtering on this interface',
    only: L3,
    run: (c, rest) => {
      const d = rest[rest.length - 1]?.toLowerCase()
      const i = cur(c)
      if (d === 'in' || !d) delete i.aclIn
      if (d === 'out' || !d) delete i.aclOut
      return ok()
    },
  },
  {
    words: ['access-class'],
    modes: ['line'],
    help: 'Only let hosts an access list permits log in over SSH/Telnet',
    syntax: ['<acl> in  e.g. access-class 10 in'],
    run: (c, rest) => {
      const [name, dir] = rest
      if (!name || dir?.toLowerCase() !== 'in') return fail('% Incomplete command. access-class <acl> in')
      ;(conf(c.dev).vty ??= {}).accessClass = name
      return ok(c.dev.ios?.acls?.[name] ? [] : [tip(`Access list ${name} doesn't exist yet. Create it in config mode, e.g. access-list ${name} permit host <admin PC>`)])
    },
  },
  { words: ['no', 'access-class'], modes: ['line'], help: 'Let any host log in again', run: (c) => (delete (conf(c.dev).vty ??= {}).accessClass, ok()) },
  {
    words: ['show', 'access-lists'],
    modes: EXEC,
    help: 'List access lists, with how many packets each line matched',
    only: L3,
    syntax: ['<acl>  One list', '<cr>'],
    run: (c, rest) => showLists(c, rest[0]),
  },
  {
    words: ['show', 'ip', 'interface'],
    modes: EXEC,
    help: 'IP settings of an interface, including access lists',
    only: L3,
    syntax: ['brief  Brief summary', 'WORD   One interface, e.g. g0/0'],
    run: (c, rest) => {
      const list = rest.length ? c.dev.ifaces.filter((i) => i.name === rest.join('').toLowerCase() || longName(i.name).toLowerCase() === rest.join('').toLowerCase()) : c.dev.ifaces.filter((i) => i.ip)
      if (!list.length) return [L('% Invalid interface', 'err')]
      return list.flatMap((i) => [
        L(`${longName(i.name)} is ${i.shutdown ? 'administratively down' : 'up'}`, 'info'),
        L(`  Internet address is ${i.ip ? `${i.ip}/${i.prefix}` : 'not set'}`),
        L(`  Outgoing access list is ${i.aclOut ?? 'not set'}`),
        L(`  Inbound  access list is ${i.aclIn ?? 'not set'}`),
        L(`  Proxy ARP is enabled`),
        ...(i.nat ? [L(`  IP NAT ${i.nat}`)] : []),
      ])
    },
  },
  {
    words: ['clear', 'access-list', 'counters'],
    modes: ['priv'],
    help: 'Reset the match counters',
    only: L3,
    run: (c) => (((c.state.aclHits ??= {})[c.dev.id] = {}), []),
  },
]

/** A line typed inside `ip access-list …` (optionally starting with a sequence number). */
function addNamed(c: Ctx, seq: number | undefined, tokens: string[]): Result {
  const name = c.f.acl!
  const kind: AclKind = c.f.mode === 'nacl-ext' ? 'extended' : 'standard'
  const e = parseAclLine(kind, tokens)
  if (typeof e === 'string') return fail(e)
  addLine(listOf(c.dev, name, true)!, e, seq)
  return ok(e.remark !== undefined ? [] : hintsAfterAdd(c.dev, name, kind))
}

/** `15 deny …` inside a named list: lines that start with a sequence number. */
export function namedLineWithSeq(c: Ctx, tokens: string[]): Result | null {
  if ((c.f.mode !== 'nacl-std' && c.f.mode !== 'nacl-ext') || !/^\d+$/.test(tokens[0] ?? '')) return null
  return addNamed(c, Number(tokens[0]), tokens.slice(1))
}

/** Lines for the running-config: numbered lists, then named ones. */
export function aclConfig(dev: Device): string[] {
  const out: string[] = []
  const acls = Object.entries(dev.ios?.acls ?? {})
  for (const [n, list] of acls.filter(([n]) => /^\d+$/.test(n))) for (const e of list) out.push(`access-list ${n} ${aclLineText(e)}`)
  for (const [n, list] of acls.filter(([n]) => !/^\d+$/.test(n))) {
    out.push(`ip access-list ${dev.ios?.aclTypes?.[n] ?? 'standard'} ${n}`)
    list.forEach((e, k) => out.push(` ${seqOf(list, k)} ${aclLineText(e)}`))
  }
  if (acls.length) out.push('!')
  return out
}

/** `ip access-group` lines inside an interface block. */
export const aclIface = (i: Iface): string[] => [...(i.aclIn ? [` ip access-group ${i.aclIn} in`] : []), ...(i.aclOut ? [` ip access-group ${i.aclOut} out`] : [])]

/** Why a packet was dropped, for ping/traceroute hints. */
export const aclDropText = (d: Device, name: string, dir: 'in' | 'out', iface: string, v: ReturnType<typeof aclCheck>) =>
  `Denied by ${d.name} access list ${name} ${dir} on ${iface} (${v.text})`