<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
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
    ({ pc: 'text-cyan', laptop: 'text-cyan', server: 'text-magenta', switch: 'text-neon', ap: 'text-neon', router: 'text-warn', firewall: 'text-danger' })[
      dev.value.type
    ],
)
const isSelected = computed(() => ws.selection?.kind === 'device' && ws.selection.id === props.id)
</script>

<template>
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
</template>
