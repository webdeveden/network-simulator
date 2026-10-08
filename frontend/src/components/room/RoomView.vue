<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { longName } from '../../engine/ios'
import { cableProblem, CABLES, getDevice, linkOn, peerOf, portKind } from '../../engine/network'
import type { Device, DeviceType } from '../../engine/types'
import { onDesk, roomLayout } from '../../room/layout'
import { RoomScene, type RackDrag, type Target } from '../../room/RoomScene'
import { STEP_MS, useWorkspace } from '../../stores/workspace'

const ws = useWorkspace()
const el = ref<HTMLDivElement>()
const locked = ref(false)
const hover = ref<Target | null>(null)
const carry = ref<{ deviceId: string; iface: string } | null>(null)
const drag = ref<RackDrag | null>(null)
let scene: RoomScene | null = null

function readHelp() {
  try {
    return localStorage.getItem('netsim.roomHelp') !== 'hidden'
  } catch {
    return true
  }
}
const showHelp = ref(readHelp())
function hideHelp() {
  showHelp.value = false
  try {
    localStorage.setItem('netsim.roomHelp', 'hidden')
  } catch {
    // Storage blocked: the help bar will just come back next time.
  }
}

const name = (id: string) => getDevice(ws.topo, id)?.name ?? '?'
const port = (deviceId: string, iface: string) => `${name(deviceId)} ${iface}`

/** Changes that need the room rebuilt: devices, addresses, ports, cables. */
const structure = computed(() =>
  JSON.stringify([
    ws.topo.devices.map((d) => [d.id, d.type, d.name, d.gateway, d.rack, d.slot, d.ios?.wlan, d.ifaces.map((i) => [i.name, i.ip, i.prefix, i.shutdown])]),
    ws.topo.links.map((l) => [l.id, l.a, l.b, l.up, l.wifi]),
  ]),
)

const hint = computed(() => {
  const d = drag.value
  if (d) {
    if (d.rack === null) return `Moving ${name(d.deviceId)} · drop it onto a rack`
    if (!d.ok) return `Rack ${d.rack + 1} is full`
    return `Moving ${name(d.deviceId)} → rack ${d.rack + 1}, position ${d.index + 1} · release to drop`
  }
  const t = hover.value
  if (!t) return carry.value ? 'Aim at a free port and click to plug the cable in' : ''
  if (t.kind === 'door') return `Rack ${t.rack + 1} · Click: ${scene?.isDoorOpen(t.rack) ? 'close' : 'open'} door`
  switch (t.kind) {
    case 'port': {
      const l = linkOn(ws.topo, t.deviceId, t.iface)
      const d = getDevice(ws.topo, t.deviceId)
      const kind = d ? portKind(d, t.iface) : 'copper'
      const label = `${name(t.deviceId)} · ${t.iface === 'con0' ? 'Console' : t.iface === 'com1' ? 'COM1' : longName(t.iface)}${kind === 'fiber' ? ' (fiber)' : kind === 'console' ? ' (console)' : ''}`
      if (carry.value) {
        if (carry.value.deviceId === t.deviceId && carry.value.iface === t.iface) return `${label} · Click: put the cable back`
        return l ? `${label} · already in use` : `${label} · Click: plug in`
      }
      if (l) {
        const peer = peerOf(l, t.deviceId, t.iface)
        const problem = cableProblem(ws.topo, l)
        return `${label} → ${port(peer.device, peer.iface)} (${CABLES[l.cable ?? 'straight'].label.toLowerCase()})${problem ? ` · DOWN: ${problem}` : ''} · Click: unplug`
      }
      const fit = cableMismatch(kind)
      return fit ? `${label} · free · ${fit}` : `${label} · free · Click: take a ${cableName.value} cable · E: console`
    }
    case 'device': {
      const d = getDevice(ws.topo, t.deviceId)
      if (!d) return ''
      const racked = !onDesk(d)
      return `${d.name} (${d.type}) · E: open console · Click: select${racked ? ' · Drag: move in the rack' : ''}`
    }
    case 'cable': {
      const l = ws.topo.links.find((x) => x.id === t.linkId)
      return l ? `Cable ${port(l.a.device, l.a.iface)} ↔ ${port(l.b.device, l.b.iface)} · Click: select` : ''
    }
  }
  return ''
})

const cableName = computed(() => (ws.cable === 'auto' ? 'auto' : CABLES[ws.cable].label.toLowerCase()))

/** Why the selected cable can't go into this kind of port (null if it fits). Auto fits anything. */
function cableMismatch(kind: string): string | null {
  const c = ws.cable
  if (c === 'auto') return null
  if (kind === 'console' && c !== 'console') return 'A console port takes a console cable: pick Console in the cable list'
  if (kind === 'fiber' && c !== 'fiber') return 'A fiber (SFP) port takes a fiber cable: pick Fiber in the cable list'
  if (kind === 'copper' && (c === 'fiber' || c === 'console'))
    return `A copper RJ45 port takes a straight-through or crossover cable, not ${CABLES[c].label.toLowerCase()}`
  return null
}

function primary(t: Target | null) {
  if (carry.value) {
    if (t?.kind === 'door') return scene?.toggleDoor(t.rack)
    if (t?.kind !== 'port') return
    const from = carry.value
    if (from.deviceId === t.deviceId && from.iface === t.iface) return setCarry(null)
    if (linkOn(ws.topo, t.deviceId, t.iface)) return ws.notify(`${port(t.deviceId, t.iface)} already has a cable`, 'err')
    if (ws.linkPorts(from.deviceId, from.iface, t.deviceId, t.iface)) {
      ws.notify(`Plugged ${port(from.deviceId, from.iface)} ↔ ${port(t.deviceId, t.iface)}`)
      setCarry(null)
    }
    return
  }
  if (!t) return
  switch (t.kind) {
    case 'port':
      ws.selection = { kind: 'device', id: t.deviceId }
      if (linkOn(ws.topo, t.deviceId, t.iface)) {
        ws.unplug(t.deviceId, t.iface)
        ws.notify(`Unplugged ${port(t.deviceId, t.iface)}`)
      } else {
        const d = getDevice(ws.topo, t.deviceId)
        const wrong = d && cableMismatch(portKind(d, t.iface))
        if (wrong) ws.notify(wrong, 'err')
        else setCarry({ deviceId: t.deviceId, iface: t.iface })
      }
      break
    case 'door':
      scene?.toggleDoor(t.rack)
      break
    case 'device':
      ws.selection = { kind: 'device', id: t.deviceId }
      break
    case 'cable':
      ws.selection = { kind: 'link', id: t.linkId }
      break
  }
}

function use(t: Target | null) {
  const id = t && (t.kind === 'port' || t.kind === 'device') ? t.deviceId : null
  if (!id) return
  setCarry(null)
  ws.selection = { kind: 'device', id }
  ws.openConsole(id)
  // Typing needs a free mouse and keyboard: leave FPS mode.
  scene?.unlock()
}

/** Rack the last drop asked for, so the watcher below can say if it was full. */
let droppedOn: number | undefined

/** Dropping a device from the list onto a rack mounts it there; anywhere else, the next free spot. */
function onDrop(e: DragEvent) {
  const type = e.dataTransfer?.getData('application/netsim-device') as DeviceType | ''
  if (!type) return
  const rack = onDesk({ type } as Device) ? undefined : (scene?.rackAt(e.clientX, e.clientY) ?? undefined)
  const n = ws.topo.devices.length
  droppedOn = rack
  ws.add(type, 120 + (n % 5) * 130, 80 + Math.floor(n / 5) * 120, rack)
}

// However a device was added (drop or double-click), open its rack and say where it went.
watch(
  () => ws.topo.devices.map((d) => d.id),
  (ids, old) => {
    const asked = droppedOn
    droppedOn = undefined
    // Exactly one device appended (not a mission or saved network being loaded).
    if (ids.length !== old.length + 1 || old.some((id, k) => ids[k] !== id)) return
    const d = ws.topo.devices[ids.length - 1]
    const placed = roomLayout(ws.topo).placements.find((p) => p.deviceId === d.id)
    if (placed?.station !== 'rack') return ws.notify(`${d.name} is on a new desk`)
    scene?.openDoor(placed.rack!)
    if (asked !== undefined && asked !== placed.rack) ws.notify(`Rack ${asked + 1} is full: ${d.name} went into rack ${placed.rack! + 1}`, 'err')
    else ws.notify(`${d.name} mounted in rack ${placed.rack! + 1}`)
  },
)

function setCarry(c: { deviceId: string; iface: string } | null) {
  carry.value = c
  scene?.setCarry(c)
}

onMounted(() => {
  scene = new RoomScene(el.value!, {
    hover: (t) => (hover.value = t),
    lock: (l) => {
      locked.value = l
      // Walking keys must not also type into a console window that still has focus.
      if (l) (document.activeElement as HTMLElement | null)?.blur()
    },
    primary,
    use,
    cancel: () => setCarry(null),
    dragging: (d) => (drag.value = d),
    move: (id, rack, index) => {
      const err = ws.moveInRack(id, rack, index)
      if (err) return ws.notify(err, 'err')
      scene?.openDoor(rack)
      ws.notify(`${name(id)} moved to rack ${rack + 1}, position ${index + 1}`)
    },
  })
  scene.sync(ws.topo)
  scene.setSelection(ws.selection)
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { room: scene })
})

onBeforeUnmount(() => {
  scene?.dispose()
  scene = null
})

watch(structure, () => scene?.sync(ws.topo))
watch(
  () => ws.flash,
  (f) => scene?.setFlash(f),
)
watch(
  () => ws.selection,
  (s) => scene?.setSelection(s),
  { deep: true },
)
watch(
  () => ws.anim,
  (a) => (a ? scene?.playPacket(a.linkId, a.forward, a.color, STEP_MS) : scene?.stopPacket()),
)

</script>

<template>
  <div class="relative h-full w-full overflow-hidden bg-bg select-none" @dragover.prevent @drop.prevent="onDrop">
    <div ref="el" class="absolute inset-0" />

    <!-- crosshair -->
    <div v-if="locked" class="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
      <div class="h-1.5 w-1.5 rounded-full" :class="hover ? 'bg-neon' : 'bg-text/70'" />
    </div>

    <!-- what you are looking at -->
    <div
      v-if="hint"
      class="pointer-events-none absolute left-1/2 max-w-[90%] -translate-x-1/2 border border-line bg-panel/90 px-3 py-1.5 text-center text-xs text-text"
      :class="!locked && showHelp ? 'bottom-24' : 'bottom-6'"
    >
      {{ hint }}
    </div>

    <div
      v-if="carry"
      class="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 border border-neon bg-panel/90 px-3 py-1.5 text-xs text-neon"
    >
      Holding a {{ cableName }} cable from {{ port(carry.deviceId, carry.iface) }} · click a free port to plug it in · Q / right-click to drop
    </div>

    <!-- mode switch -->
    <div class="absolute top-3 left-3 z-20 flex items-center gap-2 text-[11px]">
      <button
        class="border px-3 py-1 tracking-wider uppercase"
        :class="locked ? 'border-neon bg-neon text-bg' : 'border-line bg-panel text-dim hover:text-neon'"
        title="First-person mode: the mouse turns the camera (F)"
        @click="locked ? scene?.unlock() : scene?.lock()"
      >
        ◎ FPS mode <span class="opacity-60">F</span>
      </button>
      <button
        class="border border-line bg-panel px-3 py-1 tracking-wider text-dim uppercase hover:text-neon"
        title="Back to the starting view in front of rack 1 (R)"
        @click="scene?.resetView()"
      >
        ↺ Reset view <span class="opacity-60">R</span>
      </button>
      <span v-if="locked" class="border border-line bg-panel/90 px-2 py-1 text-dim">Esc to get the mouse back</span>
    </div>

    <!-- controls -->
    <div
      v-if="!locked && showHelp"
      class="absolute bottom-3 left-3 z-20 max-w-[calc(100%-1.5rem)] border border-line bg-panel/90 px-3 py-2 text-[11px] leading-relaxed text-dim"
    >
      <button class="float-right ml-3 text-dim hover:text-text" title="Hide" @click="hideHelp">✕</button>
      <span class="text-cyan">Right-drag</span> or <span class="text-cyan">Alt+drag</span> look ·
      <span class="text-cyan">WASD</span> / <span class="text-cyan">two-finger swipe</span> walk (Shift runs) ·
      <span class="text-cyan">Click</span> doors, ports, cables ·
      <span class="text-cyan">E</span> / <span class="text-cyan">double-click</span> console ·
      <span class="text-cyan">Q</span> drop cable ·
      <span class="text-cyan">R</span> reset view ·
      <span class="text-cyan">F</span> FPS mode
    </div>
  </div>
</template>
