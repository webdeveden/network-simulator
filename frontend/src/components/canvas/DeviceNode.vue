<script setup lang="ts">
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { computed } from 'vue'
import { DEVICE_CATALOG } from '../../engine/network'
import type { Device } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'
import DeviceIcon from './DeviceIcon.vue'

const props = defineProps<{ id: string; data: { device: Device }; selected?: boolean }>()
const ws = useWorkspace()

const dev = computed(() => props.data.device)
const ip = computed(() => {
  const i = dev.value.ifaces.find((x) => x.ip)
  return i ? `${i.ip}/${i.prefix}` : DEVICE_CATALOG[dev.value.type].layer === 2 ? 'L2' : 'no ip'
})
const flash = computed(() => ws.flash[props.id])
const color = computed(
  () =>
    ({ pc: 'text-cyan', laptop: 'text-cyan', server: 'text-magenta', switch: 'text-neon', ap: 'text-neon', router: 'text-warn', firewall: 'text-danger', patch: 'text-text', isp: 'text-cyan', modem: 'text-warn', printer: 'text-text', phone: 'text-cyan' })[
      dev.value.type
    ],
)
const isSelected = computed(() => ws.selection?.kind === 'device' && ws.selection.id === props.id)

// The ISP cloud can be enlarged by dragging its bottom-right corner.
const { viewport } = useVueFlow()
let resize: { x: number; y: number; w: number; h: number } | null = null
function startResize(e: PointerEvent) {
  resize = { x: e.clientX, y: e.clientY, w: dev.value.w ?? 170, h: dev.value.h ?? 110 }
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onResize(e: PointerEvent) {
  if (!resize) return
  const z = viewport.value.zoom
  dev.value.w = Math.round(Math.min(600, Math.max(120, resize.w + (e.clientX - resize.x) / z)))
  dev.value.h = Math.round(Math.min(400, Math.max(80, resize.h + (e.clientY - resize.y) / z)))
}
function endResize() {
  resize = null
}
</script>

<template>
  <!-- The ISP: a cloud, outside the building, that you can enlarge. -->
  <div
    v-if="dev.type === 'isp'"
    class="relative"
    :style="{ width: (dev.w ?? 170) + 'px', height: (dev.h ?? 110) + 'px' }"
  >
    <svg class="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 170 110" preserveAspectRatio="none">
      <path
        d="M40 95 C12 95 6 66 30 58 C24 34 52 22 70 34 C80 10 120 10 128 36 C150 30 166 50 156 66 C170 76 160 98 138 95 Z"
        :fill="isSelected ? '#22d3ee22' : '#0f1520'"
        :stroke="flash === 'err' ? '#ff4d5e' : flash === 'ok' || isSelected ? '#39ff88' : '#22d3ee'"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <div class="absolute inset-0 flex flex-col items-center justify-center pt-2 text-center">
      <div class="text-[12px] font-semibold text-cyan">{{ dev.name }}</div>
      <div class="text-[9px] text-dim">Internet · 8.8.8.8</div>
    </div>
    <div
      class="nodrag absolute right-1 bottom-1 h-3 w-3 cursor-nwse-resize border-r-2 border-b-2 border-cyan/70"
      title="Drag to resize"
      @pointerdown.stop="startResize"
      @pointermove="onResize"
      @pointerup="endResize"
    />
    <Handle id="t" type="source" :position="Position.Top" />
    <Handle id="r" type="source" :position="Position.Right" />
    <Handle id="b" type="source" :position="Position.Bottom" />
    <Handle id="l" type="source" :position="Position.Left" />
  </div>
  <div v-else class="contents">

  <div
    class="relative flex w-24 flex-col items-center gap-1 rounded border bg-panel px-2 py-2 transition-shadow"
    :class="[
      isSelected ? 'border-neon shadow-[0_0_14px_rgba(57,255,136,.45)]' : 'border-line',
      flash === 'ok' && 'shadow-[0_0_22px_rgba(57,255,136,.9)]! border-neon!',
      flash === 'err' && 'shadow-[0_0_22px_rgba(255,77,94,.9)]! border-danger!',
      flash === 'hit' && 'shadow-[0_0_16px_rgba(34,211,238,.7)]! border-cyan!',
    ]"
  >
    <span v-if="dev.locked" class="absolute top-0.5 right-1 text-[9px] text-dim" title="Mission device">⌂</span>
    <DeviceIcon :type="dev.type" :class="color" />
    <div class="w-full truncate text-center text-[11px] font-semibold text-text">{{ dev.name }}</div>
    <div class="w-full truncate text-center text-[9px]" :class="ip === 'no ip' ? 'text-danger/70' : 'text-dim'">
      {{ ip }}
    </div>
    <Handle id="t" type="source" :position="Position.Top" />
    <Handle id="r" type="source" :position="Position.Right" />
    <Handle id="b" type="source" :position="Position.Bottom" />
    <Handle id="l" type="source" :position="Position.Left" />
  </div>
  </div>
</template>
