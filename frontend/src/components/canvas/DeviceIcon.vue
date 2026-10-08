<script setup lang="ts">
import type { DeviceType } from '../../engine/types'

defineProps<{ type: DeviceType; size?: number }>()
</script>

<template>
  <svg :width="size ?? 34" :height="size ?? 34" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
    <template v-if="type === 'pc'">
      <rect x="4" y="5" width="24" height="16" rx="1.5" />
      <path d="M12 26h8M16 21v5" />
      <path d="M8 10h6M8 14h10" stroke-width="1.2" opacity=".6" />
    </template>
    <template v-else-if="type === 'laptop'">
      <rect x="7" y="7" width="18" height="12" rx="1" />
      <path d="M3 23h26l-2-4H5z" />
      <path d="M13 13.5a4 4 0 0 1 6 0M14.6 15.6a1.6 1.6 0 0 1 2.8 0" stroke-width="1.1" />
    </template>
    <template v-else-if="type === 'ap'">
      <rect x="5" y="19" width="22" height="7" rx="1.5" />
      <path d="M10 19v-8M22 19v-8" />
      <path d="M11.5 12.5a6 6 0 0 1 9 0M9 9.5a10 10 0 0 1 14 0" stroke-width="1.2" />
      <circle cx="9" cy="22.5" r=".8" fill="currentColor" />
    </template>
    <template v-else-if="type === 'server'">
      <rect x="7" y="3" width="18" height="8" rx="1" />
      <rect x="7" y="12" width="18" height="8" rx="1" />
      <rect x="7" y="21" width="18" height="8" rx="1" />
      <circle cx="11" cy="7" r=".8" fill="currentColor" />
      <circle cx="11" cy="16" r=".8" fill="currentColor" />
      <circle cx="11" cy="25" r=".8" fill="currentColor" />
    </template>
    <template v-else-if="type === 'switch'">
      <rect x="2" y="10" width="28" height="12" rx="1.5" />
      <path d="M6 18h2M10 18h2M14 18h2M18 18h2M22 18h2" stroke-width="2" />
      <path d="M9 14h14M20 12.5l3 1.5-3 1.5M12 12.5l-3 1.5 3 1.5" stroke-width="1.1" />
    </template>
    <template v-else-if="type === 'router'">
      <ellipse cx="16" cy="16" rx="13" ry="9" />
      <path d="M16 9v5M14 12l2 2 2-2M16 23v-5M14 20l2-2 2 2M8 16h5M11 14l2 2-2 2M24 16h-5M21 14l-2 2 2 2" stroke-width="1.3" />
    </template>
    <template v-else>
      <rect x="3" y="6" width="26" height="20" rx="1" />
      <path d="M3 12.5h26M3 19h26M10 6v6.5M20 6v6.5M15 12.5V19M25 12.5V19M10 19v7M20 19v7" stroke-width="1.2" />
    </template>
  </svg>
</template>
