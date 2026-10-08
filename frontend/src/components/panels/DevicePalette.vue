<script setup lang="ts">
import { CABLE_COST, DEVICE_CATALOG } from '../../engine/network'
import type { DeviceType } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'
import DeviceIcon from '../canvas/DeviceIcon.vue'

const ws = useWorkspace()

function onDragStart(e: DragEvent, type: DeviceType) {
  e.dataTransfer?.setData('application/netsim-device', type)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

function addCentered(type: DeviceType) {
  const n = ws.topo.devices.length
  ws.add(type, 120 + (n % 5) * 130, 80 + Math.floor(n / 5) * 120)
}
</script>

<template>
  <aside class="flex h-full flex-col gap-2 overflow-y-auto p-3">
    <div class="text-[10px] tracking-[0.2em] text-dim uppercase">// devices</div>
    <div
      v-for="type in ws.palette"
      :key="type"
      draggable="true"
      class="group cursor-grab border border-line bg-panel-2 p-2 transition hover:border-neon active:cursor-grabbing"
      :title="DEVICE_CATALOG[type].description"
      @dragstart="onDragStart($event, type)"
      @dblclick="addCentered(type)"
    >
      <div class="flex items-center gap-2">
        <DeviceIcon :type="type" :size="24" class="text-text group-hover:text-neon" />
        <div class="flex-1">
          <div class="text-xs font-semibold">{{ DEVICE_CATALOG[type].label }}</div>
          <div class="text-[10px] text-dim">${{ DEVICE_CATALOG[type].cost }}</div>
        </div>
      </div>
    </div>
    <div v-if="ws.palette.length === 0" class="text-[11px] text-dim">No devices to buy for this mission. Use what's already here.</div>

    <div class="mt-3 border-t border-line pt-3 text-[10px] leading-relaxed text-dim">
      <div class="mb-1 tracking-[0.2em] uppercase">// how to</div>
      <template v-if="ws.view === '3d'">
        <p>Drag a device onto a rack to mount it there, or double-click it to use the first rack with space. PCs, laptops and APs go on desks. Drag a mounted device up, down or into another rack to rearrange it.</p>
        <p class="mt-1">Right-drag (or Alt+drag) to look around. WASD, arrow keys or a two-finger swipe to walk. Press F for first-person mode.</p>
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
