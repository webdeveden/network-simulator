<script setup lang="ts">
import { computed, ref } from 'vue'
import { CABLE_COST, CABLES, DEVICE_CATALOG } from '../../engine/network'
import type { CableChoice, DeviceType } from '../../engine/types'
import { roomColor, roomLabel, roomOf, roomsOf } from '../../room/layout'
import { useWorkspace } from '../../stores/workspace'
import DeviceIcon from '../canvas/DeviceIcon.vue'

const ws = useWorkspace()

const CABLE_CHOICES: { id: CableChoice; label: string; cost: number; color: string; description: string }[] = [
  { id: 'auto', label: 'Auto', cost: CABLES.straight.cost, color: '#c9d6e8', description: 'Picks straight-through or crossover for you, and tells you which.' },
  ...(Object.entries(CABLES) as [Exclude<CableChoice, 'auto'>, (typeof CABLES)['straight']][]).map(([id, c]) => ({ id, ...c })),
]

type Section = 'devices' | 'building' | 'cable' | 'howto'

/** Which sections are folded; remembered per browser. */
function savedClosed(): Section[] {
  try {
    return JSON.parse(localStorage.getItem('netsim.paletteClosed') ?? '[]')
  } catch {
    return []
  }
}
const closed = ref<Section[]>(savedClosed())
function toggle(s: Section) {
  closed.value = closed.value.includes(s) ? closed.value.filter((x) => x !== s) : [...closed.value, s]
  try {
    localStorage.setItem('netsim.paletteClosed', JSON.stringify(closed.value))
  } catch {
    // Storage blocked: sections just reopen next time.
  }
}
const open = (s: Section) => !closed.value.includes(s)

const rooms = computed(() =>
  roomsOf(ws.topo).map((r) => ({
    id: r.id,
    kind: r.kind,
    label: roomLabel(ws.topo, r.id),
    color: roomColor(ws.topo, r.id),
    count: ws.topo.devices.filter((d) => d.type !== 'isp' && roomOf(d, ws.topo) === r.id).length,
  })),
)

function remove(r: { id: string; label: string; count: number }) {
  const what = r.count ? ` Its ${r.count} device${r.count === 1 ? '' : 's'} will move to another office.` : ''
  if (!window.confirm(`Delete ${r.label}?${what}`)) return
  const err = ws.deleteRoom(r.id)
  if (err) ws.notify(err, 'err')
}

function onDragStart(e: DragEvent, type: DeviceType) {
  e.dataTransfer?.setData('application/netsim-device', type)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

function addCentered(type: DeviceType) {
  const n = ws.topo.devices.length
  ws.requestAdd(type, 120 + (n % 5) * 130, 80 + Math.floor(n / 5) * 120)
}
</script>

<template>
  <aside class="flex h-full flex-col gap-2 overflow-y-auto p-3">
    <button class="section-head" @click="toggle('devices')">
      <span>// devices</span><span>{{ open('devices') ? '▾' : '▸' }}</span>
    </button>
    <template v-if="open('devices')">
      <div
        v-for="type in ws.palette"
        :key="type"
        draggable="true"
        class="group cursor-grab border border-line bg-panel-2 px-2 py-1.5 transition hover:border-neon active:cursor-grabbing"
        :title="DEVICE_CATALOG[type].description"
        @dragstart="onDragStart($event, type)"
        @dblclick="addCentered(type)"
      >
        <div class="flex items-center gap-2">
          <DeviceIcon :type="type" :size="22" class="text-text group-hover:text-neon" />
          <div class="flex-1 text-xs font-semibold">{{ DEVICE_CATALOG[type].label }}</div>
          <div class="text-[10px] text-dim">${{ DEVICE_CATALOG[type].cost }}</div>
        </div>
      </div>
      <div v-if="ws.palette.length === 0" class="text-[11px] text-dim">No devices to buy for this mission. Use what's already here.</div>
    </template>

    <button class="section-head mt-1" @click="toggle('building')">
      <span>// building</span><span>{{ open('building') ? '▾' : '▸' }}</span>
    </button>
    <template v-if="open('building')">
      <div class="flex flex-col">
        <div v-for="r in rooms" :key="r.id" class="group flex items-center gap-1.5 py-0.5 text-[11px]">
          <span class="h-2.5 w-2.5 shrink-0 rounded-sm" :style="{ background: r.color }" />
          <button class="flex-1 truncate text-left text-text hover:text-neon" :title="`Go to ${r.label} in the 3D room`" @click="ws.goToRoom(r.id)">
            {{ r.label }}
          </button>
          <span class="text-[10px] text-dim">{{ r.count }}</span>
          <button
            v-if="r.kind !== 'racks'"
            class="px-0.5 text-dim opacity-0 group-hover:opacity-100 hover:text-danger"
            :title="`Delete ${r.label}`"
            @click="remove(r)"
          >
            🗑
          </button>
        </div>
      </div>
      <button
        class="border border-line px-2 py-1 text-left text-[11px] text-dim hover:border-dim hover:text-text"
        title="Another office, or a balcony off the corridor"
        @click="ws.roomDialog = true"
      >
        ＋ Add a room (office / balcony)
      </button>
      <button
        class="border border-line px-2 py-1 text-left text-[11px] text-dim hover:border-dim hover:text-text"
        title="A floor rack (MDF) in the server room, or a wall-mounted mini rack (IDF) in an office"
        @click="ws.rackDialog = true"
      >
        ＋ Add a rack (MDF / IDF)
      </button>
    </template>

    <button class="section-head mt-1" @click="toggle('cable')">
      <span>// cable · {{ CABLE_CHOICES.find((c) => c.id === ws.cable)?.label }}</span><span>{{ open('cable') ? '▾' : '▸' }}</span>
    </button>
    <template v-if="open('cable')">
      <div class="flex flex-col gap-1">
        <button
          v-for="c in CABLE_CHOICES"
          :key="c.id"
          class="flex items-center gap-2 border px-2 py-1 text-left text-[11px] transition"
          :class="ws.cable === c.id ? 'border-neon bg-panel-2 text-text' : 'border-line text-dim hover:border-dim hover:text-text'"
          :title="c.description.replace(/`/g, '')"
          @click="ws.setCable(c.id)"
        >
          <span class="h-0.5 w-5 shrink-0" :style="{ background: c.color }" />
          <span class="flex-1">{{ c.label }}</span>
          <span class="text-dim">${{ c.cost }}</span>
        </button>
      </div>
      <p class="text-[10px] leading-relaxed text-dim">{{ CABLE_CHOICES.find((c) => c.id === ws.cable)?.description.replace(/`/g, '') }}</p>
    </template>

    <button class="section-head mt-1 border-t border-line pt-3" @click="toggle('howto')">
      <span>// how to</span><span>{{ open('howto') ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open('howto')" class="text-[10px] leading-relaxed text-dim">
      <template v-if="ws.view === '3d'">
        <p>Drag a device onto a rack to mount it there, or double-click it to choose. Drag a mounted device up, down or into another rack to rearrange it.</p>
        <p class="mt-1">W/S walk, A/D turn, right-drag (or Alt+drag) to look around, or swipe with two fingers. F for FPS mode, O for the overview, "Go to" to jump to a room.</p>
        <p class="mt-1">Open a rack door, click a free port to take a cable (${{ CABLE_COST }}), then click another port to plug it in.</p>
        <p class="mt-1">Click a used port to unplug it. Press <kbd class="text-text">E</kbd> to open a device's console. Each device gets its own window.</p>
      </template>
      <template v-else>
        <p>Drag a device onto the grid, or double-click it.</p>
        <p class="mt-1">Cable (${{ CABLE_COST }}): drag from a device's edge dot to another device.</p>
        <p class="mt-1">Click a device to configure it. Double-click it, or select it and press <kbd class="text-text">E</kbd>, to open its console in a window you can move; open several to configure devices side by side.</p>
      </template>
      <p class="mt-1"><kbd class="text-text">Del</kbd> removes the selection.</p>
    </div>
  </aside>
</template>

<style scoped>
.section-head {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-dim);
  text-align: left;
}
.section-head:hover {
  color: var(--color-text);
}
</style>
