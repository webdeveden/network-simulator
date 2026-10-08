/**
 * A terminal session on one device. PCs and servers get the NetSim Linux-style
 * shell; routers, switches and firewalls get the IOS console. SSH pushes a new
 * frame for the remote device, and `exit` pops it.
 */
import { execute, type CommandResult } from './commands'
import type { SimState } from './forwarding'
import { answerPending, complete, iosPrompt, isIos, parseSshArgs, pendingPrompt, runIos, sshConnect, type Session } from './ios'
import { getDevice, linkOn } from './network'
import type { Device, Topology } from './types'

export type { Session } from './ios'

export function newSession(deviceId: string): Session {
  return { frames: [{ deviceId, mode: 'user' }] }
}

/** Drops frames whose device was deleted. Returns the active device, if any. */
function active(topo: Topology, s: Session): Device | undefined {
  while (s.frames.length > 1 && !getDevice(topo, s.frames[s.frames.length - 1].deviceId)) {
    s.frames.pop()
    delete s.pending
  }
  return getDevice(topo, s.frames[s.frames.length - 1].deviceId)
}

export function promptOf(topo: Topology, s: Session): { text: string; secret: boolean } {
  if (s.pending) return { text: pendingPrompt(s.pending), secret: s.pending.kind !== 'rsa' }
  const dev = active(topo, s)
  if (!dev) return { text: '(no device)>', secret: false }
  const f = s.frames[s.frames.length - 1]
  return { text: isIos(dev) ? iosPrompt(dev.name, f.mode) : `${dev.name}:~$`, secret: false }
}

export function sessionIsIos(topo: Topology, s: Session): boolean {
  const dev = active(topo, s)
  return !s.pending && !!dev && isIos(dev)
}

export function runLine(topo: Topology, state: SimState, s: Session, input: string, promptLen = 0): CommandResult {
  if (s.pending) return answerPending(topo, s, input)
  const dev = active(topo, s)
  if (!dev) return { lines: [{ text: 'No device selected', kind: 'err' }] }
  const f = s.frames[s.frames.length - 1]
  if (dev.type === 'patch') return { lines: [{ text: `${dev.name} is a patch panel: passive wiring, no console. Front port N connects straight through to rear port N.`, kind: 'muted' }] }
  if (isIos(dev)) return runIos({ topo, state, s, f, dev, promptLen }, input)

  const [cmd, ...rest] = input.trim().split(/\s+/)
  if (cmd === 'console') {
    // Over the console cable: no IP needed, like plugging a laptop into a new router.
    const l = linkOn(topo, dev.id, 'com1')
    if (!l) return { lines: [{ text: `${dev.name} has no console cable on COM1. Plug one into a router, switch, firewall or AP console port.`, kind: 'err' }] }
    const peer = l.a.device === dev.id ? l.b : l.a
    const target = getDevice(topo, peer.device)
    if (!target || !isIos(target)) return { lines: [{ text: 'Nothing answers on COM1', kind: 'err' }] }
    s.frames.push({ deviceId: target.id, mode: 'user', remote: { user: 'console', ip: 'COM1', serial: true } })
    return {
      lines: [
        { text: `Connected to ${target.name} on COM1 (9600 8N1). Press Enter if the prompt doesn't show.`, kind: 'muted' },
        ...(target.ios?.banner ? [{ text: target.ios.banner, kind: 'info' as const }] : []),
      ],
    }
  }
  if (cmd === 'ssh') {
    const a = parseSshArgs(rest)
    if (typeof a === 'string') return { lines: [{ text: a, kind: 'err' }] }
    return sshConnect(topo, state, s, dev, a.user, a.host, true)
  }
  const r = execute(topo, state, dev.id, input)
  if (cmd === 'help' || cmd === '?')
    r.lines.splice(-1, 0, { text: `  ${'ssh <user>@<host>'.padEnd(48)} log in to a router, switch or firewall over SSH`, kind: 'out' })
  return r
}

export function completeLine(topo: Topology, s: Session, input: string): string {
  const dev = active(topo, s)
  if (s.pending || !dev || !isIos(dev)) return input
  return complete(dev, s.frames[s.frames.length - 1].mode, input)
}

/** Ctrl+Z in a config mode: same as `end`. */
export function ctrlZ(topo: Topology, state: SimState, s: Session): CommandResult | null {
  const dev = active(topo, s)
  const f = s.frames[s.frames.length - 1]
  if (s.pending || !dev || !isIos(dev) || f.mode === 'user' || f.mode === 'priv') return null
  return runLine(topo, state, s, 'end')
}
