<script setup lang="ts">
/** A device's ports as chips: colour by kind (copper, round orange fiber, console), used ones crossed out. */
import { computed } from 'vue'
import type { Device } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'
import { PORT_KIND, portGroups } from './cabling'

const props = defineProps<{ device: Device; picked?: string; /** A port on this device that counts as free (the one you're holding). */ holding?: string }>()
const emit = defineEmits<{ pick: [iface: string] }>()
const ws = useWorkspace()
const groups = computed(() => portGroups(ws.topo, props.device))
</script>

<template>
  <div>
    <div v-for="g in groups" :key="g.group" class="mb-2">
      <div class="mb-1 text-[10px] tracking-wider text-dim uppercase">{{ g.group }}</div>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="p in g.ports"
          :key="p.name"
          :disabled="!!p.used || p.name === holding"
          :title="p.name === holding ? `${p.name}: the cable starts here` : p.used ? `${p.name}: in use → ${p.used}` : `${p.name}: free (${PORT_KIND[p.kind].label})`"
          class="min-w-[3.25rem] border px-1.5 py-1 text-[10px] leading-none"
          :class="[
            p.used || p.name === holding ? 'cursor-not-allowed opacity-35' : 'hover:bg-panel-2',
            p.used ? 'line-through' : '',
            picked === p.name ? 'bg-panel-2 text-text' : 'text-dim',
            p.kind === 'fiber' ? 'rounded-full' : '',
          ]"
          :style="{ borderColor: picked === p.name ? '#39ff88' : PORT_KIND[p.kind].color, boxShadow: picked === p.name ? '0 0 0 1px #39ff88' : undefined }"
          @click="emit('pick', p.name)"
        >
          {{ p.name }}
        </button>
      </div>
    </div>
  </div>
</template>
