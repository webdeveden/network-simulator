/**
 * Spanning-tree commands on switches: mode, bridge priority per VLAN (`priority`,
 * `root primary|secondary`), PortFast and BPDU guard on ports, port cost, and
 * `show spanning-tree` in the IOS layout. The tree itself is computed in stp.ts.
 */
import { ciscoMac, conf, fail, L, longName, tip, type Ctx, type Mode, type Result, type Spec } from './iosBase'
import { linkOn, peerOf, getDevice } from './network'
import { bridgePriority, spanningTree, type StpTree } from './stp'
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
  return out.length ? out : null
}

function setPriority(dev: Device, vlans: number[], p: number) {
  const prio = ((conf(dev).stp ??= {}).priority ??= {})
  for (const v of vlans) {
    if (p === 32768) delete prio[v]
    else prio[v] = p
  }
}

function showTree(c: Ctx, tree: StpTree): ReturnType<typeof L>[] {
  const me = tree.switches.get(c.dev.id)
  if (!me) return []
  const rapid = c.dev.ios?.stp?.mode === 'rapid-pvst'
  const isRoot = tree.root.id === me.id
  const lines = [
    L(`VLAN${String(tree.vlan).padStart(4, '0')}`, 'info'),
    L(`  Spanning tree enabled protocol ${rapid ? 'rstp' : 'ieee'}`),
    L(`  Root ID    Priority    ${tree.root.priority}`),
    L(`             Address     ${ciscoMac(tree.root.mac)}`),
    ...(isRoot ? [L('             This bridge is the root', 'ok')] : [L(`             Cost        ${me.rootCost}`), L(`             Port        ${c.dev.ifaces.findIndex((i) => i.name === me.rootPort) + 1} (${longName(me.rootPort!)})`)]),
    L(''),
    L(`  Bridge ID  Priority    ${me.priority}  (priority ${me.priority - tree.vlan} sys-id-ext ${tree.vlan})`),
    L(`             Address     ${ciscoMac(me.mac)}`),
    L(''),
    L('Interface           Role Sts Cost      Prio.Nbr Type', 'info'),
    L('------------------- ---- --- --------- -------- --------------------------------', 'info'),
  ]
  for (const p of [...me.ports].sort((a, b) => a.portId - b.portId)) {
    const sts = p.forwarding ? 'FWD' : 'BLK'
    const type = `P2p${p.edge ? ' Edge' : ''}`
    lines.push(L(`${portAbbr(p.port).padEnd(20)}${p.role.padEnd(5)}${sts} ${String(p.cost).padEnd(10)}128.${String(p.portId).padEnd(5)}${type}`, p.forwarding ? 'out' : 'err'))
  }
  const blocked = me.ports.filter((p) => !p.forwarding)
  if (blocked.length) lines.push(tip(`${blocked.map((p) => p.port).join(', ')} blocking: a redundant path to the root. It takes over if the forwarding path fails.`))
  return lines
}

export const STP_SPECS: Spec[] = [
  {
    words: ['spanning-tree', 'mode'],
    modes: CFG,
    help: 'Spanning tree operating mode',
    only: SW,
    syntax: ['pvst        Per-VLAN spanning tree (802.1D)', 'rapid-pvst  Per-VLAN rapid spanning tree (802.1w)'],
    run: (c, rest) => {
      const m = rest[0]?.toLowerCase()
      if (m !== 'pvst' && m !== 'rapid-pvst') return fail('% Incomplete command. spanning-tree mode pvst|rapid-pvst')
      ;(conf(c.dev).stp ??= {}).mode = m
      return ok([tip('NetSim converges instantly in both modes; rapid-pvst is the modern choice (seconds instead of 30-50 s on real switches).')])
    },
  },
  {
    words: ['spanning-tree', 'vlan'],
    modes: CFG,
    help: 'Bridge settings for VLANs',
    only: SW,
    syntax: ['<vlans> priority <0-61440>  In steps of 4096; lower wins root', '<vlans> root primary|secondary  Make this switch the root (or the backup)'],
    run: (c, rest) => {
      const vlans = vlanList(rest[0])
      const w = rest[1]?.toLowerCase()
      if (!vlans || !w) return fail('% Incomplete command. spanning-tree vlan 1 priority 4096  |  spanning-tree vlan 1 root primary')
      if ('priority'.startsWith(w)) {
        const p = Number(rest[2])
        if (!Number.isInteger(p) || p < 0 || p > 61440) return fail('% Invalid priority (0-61440)')
        if (p % 4096) return fail('% Bridge Priority must be in increments of 4096.', 'Allowed values are: 0 4096 8192 12288 16384 20480 24576 28672 32768 36864 40960 45056 49152 53248 57344 61440')
        setPriority(c.dev, vlans, p)
        return ok()
      }
      if ('root'.startsWith(w)) {
        const kind = rest[2]?.toLowerCase()
        if (kind !== 'primary' && kind !== 'secondary') return fail('% Incomplete command. root primary|secondary')
        for (const v of vlans) {
          // Primary: 24576, or 4096 below the current root if that is lower already. Secondary: 28672.
          let p = kind === 'secondary' ? 28672 : 24576
          if (kind === 'primary') {
            const tree = spanningTree(c.topo, v)
            if (tree && tree.root.id !== c.dev.id) p = Math.min(p, Math.max(0, tree.root.priority - v - 4096))
          }
          setPriority(c.dev, [v], p)
        }
        return ok()
      }
      return fail(`% Invalid input "${rest[1]}"`)
    },
  },
  {
    words: ['no', 'spanning-tree', 'vlan'],
    modes: CFG,
    help: 'Back to the default priority (32768)',
    only: SW,
    run: (c, rest) => {
      const vlans = vlanList(rest[0])
      if (!vlans) return fail('% Incomplete command.')
      setPriority(c.dev, vlans, 32768)
      return ok()
    },
  },
  {
    words: ['spanning-tree', 'portfast'],
    modes: IF,
    help: 'Edge port: skip the listening/learning delay (only for ports to single hosts)',
    only: SW,
    run: (c) => {
      ;(cur(c).stp ??= {}).portfast = true
      return ok([
        L('%Warning: portfast should only be enabled on ports connected to a single host. Connecting hubs, concentrators, switches, bridges, etc... to this interface when portfast is enabled, can cause temporary bridging loops.', 'info'),
        tip('Pair it with spanning-tree bpduguard enable, so a switch plugged in here shuts the port.'),
      ])
    },
  },
  { words: ['no', 'spanning-tree', 'portfast'], modes: IF, help: 'Not an edge port', only: SW, run: (c) => (delete (cur(c).stp ??= {}).portfast, ok()) },
  {
    words: ['spanning-tree', 'bpduguard'],
    modes: IF,
    help: 'Err-disable this port if a switch (BPDUs) shows up on it',
    only: SW,
    syntax: ['enable', 'disable'],
    run: (c, rest) => {
      const w = rest[0]?.toLowerCase()
      if (w !== 'enable' && w !== 'disable') return fail('% Incomplete command. spanning-tree bpduguard enable|disable')
      const i = cur(c)
      if (w === 'disable') {
        delete (i.stp ??= {}).bpduguard
        return ok()
      }
      ;(i.stp ??= {}).bpduguard = true
      // A switch already on the other end: its BPDUs trip the guard right away.
      const l = linkOn(c.topo, c.dev.id, i.name)
      const peer = l && getDevice(c.topo, peerOf(l, c.dev.id, i.name).device)
      if (peer?.type === 'switch') {
        i.errDisabled = 'bpduguard'
        return ok([L(`%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${longName(i.name)} with BPDU Guard enabled. Disabling port.`, 'err'), L(`%PM-4-ERR_DISABLE: bpduguard error detected on ${portAbbr(i.name)}, putting ${portAbbr(i.name)} in err-disable state`, 'err')])
      }
      return ok()
    },
  },
  {
    words: ['spanning-tree', 'cost'],
    modes: IF,
    help: 'Port cost toward the root (lower is preferred)',
    only: SW,
    syntax: ['<1-200000000>  Cost (defaults: 19 FastEthernet, 4 GigabitEthernet)'],
    run: (c, rest) => {
      const n = Number(rest[0])
      if (!Number.isInteger(n) || n < 1 || n > 200000000) return fail('% Invalid cost')
      ;(cur(c).stp ??= {}).cost = n
      return ok()
    },
  },
  { words: ['no', 'spanning-tree', 'cost'], modes: IF, help: 'Default cost', only: SW, run: (c) => (delete (cur(c).stp ??= {}).cost, ok()) },
  {
    words: ['show', 'spanning-tree'],
    modes: EXEC,
    help: 'Spanning tree topology: root bridge, port roles and states',
    only: SW,
    syntax: ['vlan <n>  One VLAN', '<cr>'],
    run: (c, rest) => {
      const only = rest[0]?.toLowerCase() === 'vlan' ? Number(rest[1]) : null
      const vlans = [1, ...Object.keys(c.dev.ios?.vlans ?? {}).map(Number)].filter((v) => only === null || v === only)
      const out: ReturnType<typeof L>[] = []
      for (const v of vlans) {
        const tree = spanningTree(c.topo, v)
        if (tree?.switches.has(c.dev.id)) out.push(...showTree(c, tree), L(''))
      }
      return out.length ? out : [L(`% No spanning tree instance exists${only !== null ? ` for VLAN ${only}` : ''}.`, 'err')]
    },
  },
]

/** Global spanning-tree lines for the running-config. */
export function stpConfig(dev: Device): string[] {
  const s = dev.ios?.stp
  if (!s) return []
  const out: string[] = []
  if (s.mode) out.push(`spanning-tree mode ${s.mode}`)
  for (const [v, p] of Object.entries(s.priority ?? {})) out.push(`spanning-tree vlan ${v} priority ${p}`)
  if (out.length) out.push('!')
  return out
}

/** Spanning-tree lines inside an interface block. */
export function stpIface(i: Iface): string[] {
  const s = i.stp
  if (!s) return []
  return [...(s.portfast ? [' spanning-tree portfast'] : []), ...(s.bpduguard ? [' spanning-tree bpduguard enable'] : []), ...(s.cost ? [` spanning-tree cost ${s.cost}`] : [])]
}

export { bridgePriority }