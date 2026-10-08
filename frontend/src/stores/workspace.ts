import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef } from 'vue'
import type { CommandResult, Line } from '../engine/commands'
import { emptySimState, sendPacket, type SimState } from '../engine/forwarding'
import {
  addDevice,
  CABLE_COST,
  connect,
  connectPorts,
  DEVICE_CATALOG,
  disconnect,
  linkOn,
  emptyTopology,
  getDevice,
  removeDevice,
  topologyCost,
} from '../engine/network'
import { moveDeviceInRack } from '../room/layout'
import { completeLine, ctrlZ, newSession, promptOf, runLine, sessionIsIos, type Session } from '../engine/shell'
import type { DeviceType, PingResult, Topology } from '../engine/types'

export const ALL_TYPES = Object.keys(DEVICE_CATALOG) as DeviceType[]

export const STEP_MS = 380

export type View = '2d' | '3d'

function savedView(): View {
  try {
    return localStorage.getItem('netsim.view') === '3d' ? '3d' : '2d'
  } catch {
    return '2d'
  }
}

/** A floating console window. Positions are in pixels inside the canvas area. */
export interface ConsoleWin {
  deviceId: string
  x: number
  y: number
  z: number
}

export type Selection = { kind: 'device' | 'link'; id: string } | null

export interface PacketAnim {
  linkId: string
  forward: boolean
  color: string
  key: number
}

export const useWorkspace = defineStore('workspace', () => {
  const topo = ref<Topology>(emptyTopology())
  const sim = shallowRef<SimState>(markRaw(emptySimState()))
  const selection = ref<Selection>(null)
  const view = ref<View>(savedView())
  const palette = ref<DeviceType[]>(ALL_TYPES)
  const budget = ref<number | null>(null)
  const baselineCost = ref(0)

  const anim = ref<PacketAnim | null>(null)
  const flash = ref<Record<string, 'ok' | 'err' | 'hit'>>({})
  const toast = ref<{ text: string; kind: 'ok' | 'err'; key: number } | null>(null)
  /** Lines pushed to the terminal from outside it (GUI actions). */
  /** `deviceId` set: only that device's terminals show the lines. */
  const termFeed = ref<{ seq: number; lines: Line[]; deviceId?: string }>({ seq: 0, lines: [] })
  const consoles = ref<ConsoleWin[]>([])
  let zTop = 1

  let animToken = 0
  /** One terminal session per device, kept while switching between devices. */
  let sessions = new Map<string, Session>()

  /** The session for a device, or for the selected device when none is given. */
  function session(deviceId?: string): Session | undefined {
    const d = deviceId ? getDevice(topo.value, deviceId) : selectedDevice.value
    if (!d) return undefined
    let s = sessions.get(d.id)
    if (!s) sessions.set(d.id, (s = newSession(d.id)))
    return s
  }

  const spent = computed(() => topologyCost(topo.value) - baselineCost.value)
  const selectedDevice = computed(() =>
    selection.value?.kind === 'device' ? getDevice(topo.value, selection.value.id) : undefined,
  )
  const selectedLink = computed(() =>
    selection.value?.kind === 'link' ? topo.value.links.find((l) => l.id === selection.value!.id) : undefined,
  )

  function load(t: Topology, opts: { palette?: DeviceType[]; budget?: number | null } = {}) {
    topo.value = t
    sim.value = markRaw(emptySimState())
    palette.value = opts.palette ?? ALL_TYPES
    budget.value = opts.budget ?? null
    baselineCost.value = topologyCost(t)
    selection.value = null
    anim.value = null
    flash.value = {}
    sessions = new Map()
    consoles.value = []
  }

  function notify(text: string, kind: 'ok' | 'err' = 'ok') {
    toast.value = { text, kind, key: Date.now() }
  }

  function canAfford(cost: number): boolean {
    if (budget.value === null || spent.value + cost <= budget.value) return true
    notify(`Over budget: $${spent.value + cost} > $${budget.value}`, 'err')
    return false
  }

  function add(type: DeviceType, x: number, y: number, rack?: number) {
    if (!palette.value.includes(type)) return
    if (!canAfford(DEVICE_CATALOG[type].cost)) return
    const d = addDevice(topo.value, type, Math.round(x), Math.round(y))
    if (rack !== undefined) d.rack = rack
    selection.value = { kind: 'device', id: d.id }
    return d
  }

  function link(a: string, b: string) {
    if (!canAfford(CABLE_COST)) return
    const r = connect(topo.value, a, b)
    if (typeof r === 'string') notify(r, 'err')
    else selection.value = { kind: 'link', id: r.id }
  }

  function setView(v: View) {
    view.value = v
    try {
      localStorage.setItem('netsim.view', v)
    } catch {
      // Storage blocked: the choice just won't be remembered.
    }
  }

  function linkPorts(a: string, aIface: string, b: string, bIface: string): boolean {
    if (!canAfford(CABLE_COST)) return false
    const r = connectPorts(topo.value, a, aIface, b, bIface)
    if (typeof r === 'string') {
      notify(r, 'err')
      return false
    }
    return true
  }

  function unplug(deviceId: string, iface: string) {
    const l = linkOn(topo.value, deviceId, iface)
    if (!l) return
    disconnect(topo.value, l.id)
    if (selection.value?.kind === 'link' && selection.value.id === l.id) selection.value = null
  }

  function moveInRack(deviceId: string, rack: number, index: number): string | null {
    return moveDeviceInRack(topo.value, deviceId, rack, index)
  }

  function removeSelected() {
    const s = selection.value
    if (!s) return
    if (s.kind === 'link') disconnect(topo.value, s.id)
    else {
      const d = getDevice(topo.value, s.id)
      if (d?.locked) return notify(`${d.name} is part of the mission and cannot be deleted`, 'err')
      removeDevice(topo.value, s.id)
    }
    selection.value = null
  }

  function moveDevice(id: string, x: number, y: number) {
    const d = getDevice(topo.value, id)
    if (d) {
      d.x = Math.round(x)
      d.y = Math.round(y)
    }
  }

  function print(lines: Line[], deviceId?: string) {
    termFeed.value = { seq: termFeed.value.seq + 1, lines, deviceId }
  }

  function run(line: string, promptLen = 0, deviceId?: string): CommandResult {
    const s = session(deviceId)
    if (!s) return { lines: [{ text: 'Select a device on the canvas first', kind: 'err' }] }
    const r = runLine(topo.value, sim.value, s, line, promptLen)
    if (r.packet) playPacket(r.packet)
    return r
  }

  function prompt(deviceId?: string) {
    const s = session(deviceId)
    return s ? promptOf(topo.value, s) : { text: '(no device)>', secret: false }
  }

  const termIsIos = (deviceId?: string) => {
    const s = session(deviceId)
    return !!s && sessionIsIos(topo.value, s)
  }

  const termComplete = (input: string, deviceId?: string) => {
    const s = session(deviceId)
    return s ? completeLine(topo.value, s, input) : input
  }

  function termCtrlZ(deviceId?: string): CommandResult | null {
    const s = session(deviceId)
    return s ? ctrlZ(topo.value, sim.value, s) : null
  }

  /** Opens a console window for a device, or brings its window to the front. */
  function openConsole(deviceId: string) {
    const open = consoles.value.find((c) => c.deviceId === deviceId)
    if (open) return focusConsole(deviceId)
    const n = consoles.value.length
    consoles.value.push({ deviceId, x: 40 + (n % 6) * 32, y: 40 + (n % 6) * 32, z: ++zTop })
  }

  function closeConsole(deviceId: string) {
    consoles.value = consoles.value.filter((c) => c.deviceId !== deviceId)
  }

  function focusConsole(deviceId: string) {
    const c = consoles.value.find((x) => x.deviceId === deviceId)
    if (c && c.z !== zTop) c.z = ++zTop
  }

  /** GUI ping: same engine call, echoed to the terminal. */
  function pingFromGui(srcId: string, dstIp: string) {
    const src = getDevice(topo.value, srcId)
    if (!src) return
    const r = sendPacket(topo.value, sim.value, srcId, dstIp)
    print(
      [
        { text: `${src.name}> ping ${dstIp}`, kind: 'muted' },
        { text: r.message, kind: r.success ? 'ok' : 'err' },
      ],
      srcId,
    )
    playPacket(r)
  }

  async function playPacket(r: PingResult) {
    const token = ++animToken
    flash.value = {}
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms))
    for (let i = 0; i < r.hops.length; i++) {
      if (token !== animToken) return
      const hop = r.hops[i]
      const prev = r.hops[i - 1]
      if (hop.linkId && prev) {
        const l = topo.value.links.find((x) => x.id === hop.linkId)
        if (l) {
          anim.value = {
            linkId: l.id,
            forward: l.a.device === prev.deviceId,
            color: hop.reply ? '#22d3ee' : '#39ff88',
            key: Date.now() + i,
          }
          await wait(STEP_MS)
        }
      }
      if (token !== animToken) return
      flash.value = {
        [hop.deviceId]: hop.action === 'drop' ? 'err' : hop.action === 'deliver' ? 'ok' : 'hit',
      }
      if (hop.action === 'drop') break
    }
    anim.value = null
    await wait(900)
    if (token === animToken) flash.value = {}
  }

  return {
    topo,
    sim,
    selection,
    view,
    setView,
    linkPorts,
    unplug,
    moveInRack,
    palette,
    budget,
    spent,
    anim,
    flash,
    toast,
    termFeed,
    consoles,
    openConsole,
    closeConsole,
    focusConsole,
    selectedDevice,
    selectedLink,
    load,
    notify,
    add,
    link,
    removeSelected,
    moveDevice,
    print,
    run,
    prompt,
    termIsIos,
    termComplete,
    termCtrlZ,
    pingFromGui,
  }
})
