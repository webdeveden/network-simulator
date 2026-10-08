import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import type { CommandResult, Line } from '../engine/commands'
import { emptySimState, sendPacket, type SimState } from '../engine/forwarding'
import {
  addDevice,
  CABLES,
  cableProblem,
  connect,
  connectPorts,
  DEVICE_CATALOG,
  disconnect,
  linkOn,
  emptyTopology,
  getDevice,
  isOutside,
  removeDevice,
  topologyCost,
} from '../engine/network'
import { emptyRacks, newRackSpot, roomGroups, spotFor, tidyByRoom } from '../room/groups'
import { deleteRack as deleteRackFrom, moveDeviceInRack, officesOf, roomLabel, roomLayout, roomOf, roomsOf, WALL_RACK_BASE } from '../room/layout'
import { completeLine, ctrlZ, newSession, promptOf, runLine, sessionIsIos, type Session } from '../engine/shell'
import type { CableChoice, Device, DeviceType, IpLogEntry, Link, PingResult, Topology } from '../engine/types'

export const ALL_TYPES = Object.keys(DEVICE_CATALOG) as DeviceType[]

export const STEP_MS = 380

export type View = '2d' | '3d'

function savedShowRooms(): boolean {
  try {
    return localStorage.getItem('netsim.rooms2d') !== 'hidden'
  } catch {
    return true
  }
}

function savedCable(): CableChoice {
  try {
    const c = localStorage.getItem('netsim.cable')
    return c && (c === 'auto' || c in CABLES) ? (c as CableChoice) : 'auto'
  } catch {
    return 'auto'
  }
}

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

export type Selection = { kind: 'device' | 'link' | 'rack'; id: string } | null

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
  /** Cable type used for the next connection. */
  const cable = ref<CableChoice>(savedCable())
  /** 2D map: draw a box around the devices of each room. */
  const showRooms = ref(savedShowRooms())
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
    populateBalconies(t)
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
    ipSnapshot = networkIps(t)
  }

  /** Network devices whose IPs belong in the admin's notes. */
  const NOTED: DeviceType[] = ['router', 'switch', 'firewall', 'ap', 'isp', 'modem']
  function networkIps(t: Topology): Map<string, { device: string; iface: string; ip: string | null }> {
    const m = new Map<string, { device: string; iface: string; ip: string | null }>()
    for (const d of t.devices.filter((x) => NOTED.includes(x.type)))
      for (const i of d.ifaces) if (i.ip || i.prefix !== undefined) m.set(`${d.id}|${i.name}`, { device: d.name, iface: i.name, ip: i.ip ? `${i.ip}/${i.prefix}` : null })
    return m
  }
  let ipSnapshot = networkIps(topo.value)

  // Whenever a network device's IP is assigned, changed or removed (CLI, PuTTY, side
  // panel…), note it in the admin's log. Loading a network resets the snapshot first.
  watch(
    () => JSON.stringify([...networkIps(topo.value)]),
    () => {
      const now = networkIps(topo.value)
      const log: IpLogEntry[] = []
      for (const [k, v] of now) {
        const before = ipSnapshot.get(k)?.ip ?? null
        if (before !== v.ip) log.push({ t: Date.now(), device: v.device, iface: v.iface, ip: v.ip, was: before })
      }
      for (const [k, v] of ipSnapshot)
        if (!now.has(k) && v.ip && topo.value.devices.some((d) => `${d.id}|${v.iface}` === k)) log.push({ t: Date.now(), device: v.device, iface: v.iface, ip: null, was: v.ip })
      ipSnapshot = now
      if (log.length) topo.value.ipLog = [...(topo.value.ipLog ?? []), ...log].slice(-60)
    },
  )

  function notify(text: string, kind: 'ok' | 'err' = 'ok') {
    toast.value = { text, kind, key: Date.now() }
  }

  function canAfford(cost: number): boolean {
    if (budget.value === null || spent.value + cost <= budget.value) return true
    notify(`Over budget: $${spent.value + cost} > $${budget.value}`, 'err')
    return false
  }

  /**
   * Adds a device. Its 2D spot is worked out from its room (see spotFor), unless it
   * was dropped (`dropped`) inside its own room's box: then it stays where it was dropped.
   */
  function add(type: DeviceType, x: number, y: number, where: { rack?: number; room?: string; deskOf?: string } = {}, dropped = false) {
    if (!palette.value.includes(type)) return
    if (!canAfford(DEVICE_CATALOG[type].cost)) return
    // The first device in an empty rack lands on the rack's spot on the 2D map.
    const spot = where.rack !== undefined ? emptyRacks(topo.value).find((e) => e.index === where.rack) : undefined
    const d = addDevice(topo.value, type, Math.round(spot?.x ?? x), Math.round(spot?.y ?? y))
    if (where.rack !== undefined) d.rack = where.rack
    if (where.room !== undefined) d.room = where.room
    if (where.deskOf !== undefined) d.deskOf = where.deskOf
    const home = roomGroups(topo.value, d.id).find((g) => g.id === roomOf(d, topo.value))
    const keep = dropped && home && x >= home.x && x <= home.x + home.w && y >= home.y && y <= home.y + home.h
    const auto = keep ? null : spotFor(topo.value, d.id)
    if (auto) {
      d.x = Math.round(auto.x)
      d.y = Math.round(auto.y)
    }
    selection.value = { kind: 'device', id: d.id }
    return d
  }

  /** A device waiting for the "where does it go?" dialog. `preset` pre-selects a choice. */
  /** The "add a rack" dialog (from the device list). */
  const rackDialog = ref(false)
  const pendingAdd = ref<{ type: DeviceType; x: number; y: number; preset?: { rack?: number; room?: string }; dropped?: boolean } | null>(null)

  /** Asks where a new device goes (rack or office) before adding it. The ISP is outside: no question. */
  function requestAdd(type: DeviceType, x: number, y: number, preset?: { rack?: number; room?: string }, dropped = false) {
    if (!palette.value.includes(type)) return
    if (isOutside({ type } as Device)) {
      const d = add(type, x, y)
      if (d) notify(`${d.name} is outside the building: it shows on the 2D map only`)
      return
    }
    pendingAdd.value = { type, x, y, preset, dropped }
  }

  /** Where the dialog said to put it: an existing rack, a new rack, or an office. */
  type Placement = { rack: number } | { newFloorRack: true } | { newWallRack: string } | { room: string } | { deskOf: string }

  function confirmAdd(where: Placement) {
    const p = pendingAdd.value
    if (!p) return
    pendingAdd.value = null
    if ('room' in where) {
      const d = add(p.type, p.x, p.y, { room: where.room }, p.dropped)
      if (d) withDeskPhone(d)
      return d
    }
    if ('deskOf' in where) return add(p.type, p.x, p.y, { deskOf: where.deskOf }, p.dropped)
    const rack = 'rack' in where ? where.rack : 'newFloorRack' in where ? addFloorRack() : addWallRack(where.newWallRack)
    return add(p.type, p.x, p.y, { rack }, p.dropped)
  }

  /** Puts a phone on each of these PC/laptop desks. Cabling is left to the player. */
  function addPhones(deskIds: string[]) {
    const p = pendingAdd.value
    if (!p) return
    const hosts = deskIds.map((id) => getDevice(topo.value, id)).filter((d): d is Device => !!d)
    if (!canAfford(DEVICE_CATALOG.phone.cost * hosts.length)) return
    pendingAdd.value = null
    for (const host of hosts) {
      const phone = addDevice(topo.value, 'phone', Math.round(host.x + 110), Math.round(host.y))
      phone.deskOf = host.id
      const spot = spotFor(topo.value, phone.id)
      if (spot) Object.assign(phone, { x: Math.round(spot.x), y: Math.round(spot.y) })
    }
    const n = hosts.length
    notify(`${n} phone${n === 1 ? '' : 's'} added: cable each PC to its phone's pc port, and the phone's eth0 to the network`)
  }

  /**
   * Deletes an office or balcony (never the server room or the last office). Its
   * devices move to another office, its wall racks go (their gear moves to the
   * server room), and its custom name and colour are forgotten.
   */
  function deleteRoom(id: string): string | null {
    const t = topo.value
    const room = roomsOf(t).find((r) => r.id === id)
    if (!room) return 'Unknown room'
    if (room.kind === 'racks') return "The server room holds the floor racks: it can't be deleted"
    if (room.kind === 'office' && officesOf(t).length <= 1) return 'The building needs at least one office'
    const label = roomLabel(t, id)
    if (t.customRooms?.some((r) => r.id === id)) t.customRooms = t.customRooms.filter((r) => r.id !== id)
    else t.removedRooms = [...(t.removedRooms ?? []), id]
    for (const w of (t.wallRacks ?? []).filter((w) => w.room === id)) {
      for (const d of t.devices.filter((d) => d.rack === w.id)) {
        delete d.rack
        delete d.slot
      }
      if (t.rackPos) delete t.rackPos[w.id]
    }
    t.wallRacks = (t.wallRacks ?? []).filter((w) => w.room !== id)
    for (const d of t.devices.filter((d) => d.room === id)) delete d.room
    if (t.rooms) delete t.rooms[id]
    notify(`${label} deleted`)
    return null
  }

  /** Deletes a rack; its devices move to the server room's floor racks. */
  function deleteRack(index: number) {
    const name = deleteRackFrom(topo.value, index)
    if (name) notify(`${name} deleted`)
    if (selection.value?.kind === 'rack') selection.value = null
  }

  /** Ask the 3D view to take the player to a room (it watches this). */
  /** A pending "go to" for the 3D view; it sets `done` once it has moved the player. */
  const goTo = ref<{ room?: string; device?: string; rack?: number; seq: number; done?: boolean } | null>(null)
  function goToRoom(room: string) {
    setView('3d')
    goTo.value = { room, seq: (goTo.value?.seq ?? 0) + 1 }
  }
  /** "Show in 3D" for a rack: stand in front of it, door open. */
  function goToRack(rack: number) {
    setView('3d')
    goTo.value = { rack, seq: (goTo.value?.seq ?? 0) + 1 }
  }
  /** "Show in 3D": walk up to a device, facing it. */
  function goToDevice(device: string) {
    setView('3d')
    goTo.value = { device, seq: (goTo.value?.seq ?? 0) + 1 }
  }

  /** The "add a room" dialog (from the device list). */
  const roomDialog = ref(false)

  /** A new office (east end of the building) or balcony (off the corridor). Returns its id. */
  function addRoom(label: string, kind: 'office' | 'balcony', color?: string): string {
    const list = (topo.value.customRooms ??= [])
    const id = `room-${Date.now().toString(36)}`
    list.push({ id, label: label.trim().slice(0, 40) || (kind === 'balcony' ? 'Balcony' : 'New office'), kind })
    if (color) editRoom(id, { color })
    return id
  }

  /**
   * Every balcony seat has someone on it: each empty lounge chair gets a laptop user
   * and each free railing spot a smartphone user (real devices). Runs when a network
   * loads and when a balcony is added.
   */
  function populateBalconies(t: Topology) {
    const balconies = roomsOf(t).filter((r) => r.kind === 'balcony')
    if (!balconies.length) return
    const free = roomLayout(t).seats.filter((s) => !s.deviceId)
    for (const b of balconies) {
      const room = roomLayout(t).rooms.find((r) => r.id === b.id)!
      const here = free.filter((s) => s.x > room.x0 && s.x < room.x1 && s.z > room.z0 && s.z < room.z1)
      here.forEach((seat, k) => {
        const n = t.devices.length + k
        const d = addDevice(t, seat.pose === 'sit' ? 'laptop' : 'mobile', 120 + (n % 5) * 130, 80 + Math.floor(n / 5) * 120)
        d.room = b.id
        const spot = spotFor(t, d.id)
        if (spot) Object.assign(d, { x: Math.round(spot.x), y: Math.round(spot.y) })
      })
    }
  }

  /** People on a new balcony: a laptop user on every chair, a smartphone user at every railing spot. */
  function addBalconyPeople() {
    const before = topo.value.devices.length
    populateBalconies(topo.value)
    selection.value = null
    return topo.value.devices.length - before
  }

  /** Every new PC comes with an IP phone on its desk (not cabled: you wire it yourself). */
  function withDeskPhone(pc: Device) {
    if (pc.type !== 'pc' || !palette.value.includes('phone')) return
    if (budget.value !== null && spent.value + DEVICE_CATALOG.phone.cost > budget.value) return
    const phone = addDevice(topo.value, 'phone', pc.x + 120, pc.y)
    phone.deskOf = pc.id
    const spot = spotFor(topo.value, phone.id)
    if (spot) Object.assign(phone, { x: Math.round(spot.x), y: Math.round(spot.y) })
    selection.value = { kind: 'device', id: pc.id }
    notify(`${pc.name} added with ${phone.name} on its desk: cable the PC to the phone's pc port, and the phone's eth0 to the network`)
  }

  /** One more (empty) floor rack in the server room; returns its index. */
  function addFloorRack(): number {
    const floors = roomLayout(topo.value).racks.filter((r) => r.kind === 'floor').length
    const spot = newRackSpot(topo.value, 'server')
    topo.value.serverRacks = floors + 1
    topo.value.rackPos = { ...topo.value.rackPos, [floors]: spot }
    return floors
  }

  /** A new wall-mounted mini rack (IDF) in an office; returns its id. */
  function addWallRack(room: string, name?: string): number {
    const list = (topo.value.wallRacks ??= [])
    const id = Math.max(WALL_RACK_BASE - 1, ...list.map((w) => w.id)) + 1
    const spot = newRackSpot(topo.value, room)
    list.push({ id, room, name: name?.trim() || `IDF-${String.fromCharCode(65 + (list.length % 26))}` })
    topo.value.rackPos = { ...topo.value.rackPos, [id]: spot }
    return id
  }

  function setCable(c: CableChoice) {
    cable.value = c
    try {
      localStorage.setItem('netsim.cable', c)
    } catch {
      // Storage blocked: the choice just won't be remembered.
    }
  }

  const cableCost = () => CABLES[cable.value === 'auto' ? 'straight' : cable.value].cost

  /** Says what was laid, and warns right away when it's the wrong copper cable. */
  function reportCable(l: Link) {
    const name = CABLES[l.cable!].label.toLowerCase()
    const problem = cableProblem(topo.value, l)
    if (problem) notify(`Plugged in a ${name} cable, but the link is down: ${problem}`, 'err')
    else notify(cable.value === 'auto' ? `Auto: ${name} cable` : `${CABLES[l.cable!].label} cable connected`)
  }

  function link(a: string, b: string) {
    if (!canAfford(cableCost())) return
    const r = connect(topo.value, a, b, cable.value)
    if (typeof r === 'string') return notify(r, 'err')
    selection.value = { kind: 'link', id: r.id }
    reportCable(r)
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
    if (!canAfford(cableCost())) return false
    const r = connectPorts(topo.value, a, aIface, b, bIface, cable.value)
    if (typeof r === 'string') {
      notify(r, 'err')
      return false
    }
    reportCable(r)
    return true
  }

  function unplug(deviceId: string, iface: string) {
    const l = linkOn(topo.value, deviceId, iface)
    if (!l) return
    disconnect(topo.value, l.id)
    if (selection.value?.kind === 'link' && selection.value.id === l.id) selection.value = null
  }

  function setShowRooms(on: boolean) {
    showRooms.value = on
    try {
      localStorage.setItem('netsim.rooms2d', on ? 'shown' : 'hidden')
    } catch {
      // Storage blocked: the choice just won't be remembered.
    }
  }

  /** Names and colours a room (a blank name restores the default). Saved with the network; 2D and 3D both read it. */
  function editRoom(id: string, edit: { label?: string; color?: string }) {
    const t = topo.value
    const room = { ...(t.rooms?.[id] ?? {}) }
    if (edit.label !== undefined) {
      const clean = edit.label.trim().slice(0, 40)
      if (clean) room.label = clean
      else delete room.label
    }
    if (edit.color !== undefined) room.color = edit.color
    t.rooms = { ...t.rooms, [id]: room }
  }

  function renameRoom(id: string, label: string) {
    editRoom(id, { label })
  }

  /** Lays the 2D map out in room blocks. */
  function tidyRooms() {
    tidyByRoom(topo.value)
  }

  /** Moves a PC, laptop or AP into another office of the 3D building. */
  function moveToRoom(deviceId: string, room: string) {
    const d = getDevice(topo.value, deviceId)
    if (!d) return
    d.room = room
    delete d.deskOf // a phone moved elsewhere gets its own desk
  }

  function moveInRack(deviceId: string, rack: number, index: number): string | null {
    return moveDeviceInRack(topo.value, deviceId, rack, index)
  }

  function removeSelected() {
    const s = selection.value
    if (!s) return
    if (s.kind === 'rack') return // racks are deleted from their panel, after a confirmation
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
    cable,
    setCable,
    linkPorts,
    unplug,
    moveInRack,
    moveToRoom,
    pendingAdd,
    addPhones,
    addBalconyPeople,
    deleteRoom,
    deleteRack,
    goTo,
    goToRoom,
    goToDevice,
    goToRack,
    rackDialog,
    roomDialog,
    addRoom,
    requestAdd,
    confirmAdd,
    addFloorRack,
    addWallRack,
    showRooms,
    setShowRooms,
    renameRoom,
    editRoom,
    tidyRooms,
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
