<script setup lang="ts">
import type { RackGroup } from '../../room/groups'

defineProps<{ data: { rack: RackGroup; color: string } }>()
</script>

<template>
  <!-- A rack inside a room box: just a frame and a label, it never takes the mouse. -->
  <div
    class="pointer-events-none rounded border"
    :style="{ width: data.rack.w + 'px', height: data.rack.h + 'px', borderColor: data.color + '55' }"
  >
    <div class="px-1.5 pt-0.5 text-[9px] tracking-wider uppercase" :style="{ color: data.color + 'cc' }">▥ {{ data.rack.name }}</div>
    <div v-if="data.rack.empty" class="flex h-[calc(100%-18px)] flex-col items-center justify-center text-center text-[9px] text-dim">
      <span class="text-lg leading-none opacity-40">▤</span>
      empty<br />drop a device here
    </div>
  </div>
</template>
