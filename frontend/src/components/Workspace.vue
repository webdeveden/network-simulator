<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspace } from '../stores/workspace'
import NetworkCanvas from './canvas/NetworkCanvas.vue'
import RoomView from './room/RoomView.vue'
import ConsoleWindow from './terminal/ConsoleWindow.vue'
import { getDevice } from '../engine/network'
import DeviceConfigPanel from './panels/DeviceConfigPanel.vue'
import DevicePalette from './panels/DevicePalette.vue'
import TerminalPane from './terminal/TerminalPane.vue'

const ws = useWorkspace()
const termOpen = ref(true)
const toastVisible = ref(false)
let toastTimer: ReturnType<typeof setTimeout>

watch(
  () => ws.toast?.key,
  () => {
    toastVisible.value = true
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastVisible.value = false), 2600)
  },
)

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, .xterm')) return
  ws.removeSelected()
}

// A deleted device takes its console window with it.
watch(
  () => ws.topo.devices.length,
  () => ws.consoles.filter((c) => !getDevice(ws.topo, c.deviceId)).forEach((c) => ws.closeConsole(c.deviceId)),
)

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="flex h-full flex-col">
    <slot name="hud" />
    <div class="flex min-h-0 flex-1">
      <div class="w-44 shrink-0 border-r border-line bg-panel">
        <DevicePalette />
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="relative min-h-0 flex-1">
          <NetworkCanvas v-if="ws.view === '2d'" />
          <RoomView v-else />
          <div class="pointer-events-none absolute inset-0 z-30 overflow-hidden">
            <ConsoleWindow v-for="c in ws.consoles" :key="c.deviceId" :win="c" />
          </div>
          <div class="absolute top-3 right-3 z-20 flex border border-line bg-panel text-[11px]">
            <button
              v-for="v in (['2d', '3d'] as const)"
              :key="v"
              class="px-3 py-1 uppercase tracking-wider"
              :class="ws.view === v ? 'bg-neon text-bg' : 'text-dim hover:text-neon'"
              @click="ws.setView(v)"
            >
              {{ v === '2d' ? '2D map' : '3D room' }}
            </button>
          </div>
          <transition name="fade">
            <div
              v-if="toastVisible && ws.toast"
              class="absolute top-3 left-1/2 z-10 -translate-x-1/2 border bg-panel px-3 py-1.5 text-xs"
              :class="ws.toast.kind === 'err' ? 'border-danger text-danger' : 'border-neon text-neon'"
            >
              {{ ws.toast.text }}
            </div>
          </transition>
        </div>
        <div v-if="ws.view === '2d'" class="border-t border-line bg-bg">
          <button
            class="flex w-full items-center justify-between px-3 py-1 text-[10px] tracking-[0.2em] text-dim uppercase hover:text-neon"
            @click="termOpen = !termOpen"
          >
            <span>// terminal {{ ws.selectedDevice ? '— ' + ws.selectedDevice.name : '' }}</span>
            <span>{{ termOpen ? '▾' : '▴' }}</span>
          </button>
          <div v-show="termOpen" class="h-56">
            <TerminalPane />
          </div>
        </div>
      </div>
      <div class="flex w-72 shrink-0 flex-col border-l border-line bg-panel">
        <div class="min-h-0 flex-1">
          <DeviceConfigPanel />
        </div>
        <slot name="side" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
