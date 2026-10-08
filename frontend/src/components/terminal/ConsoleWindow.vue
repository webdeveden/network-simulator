<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { isIos } from '../../engine/ios'
import { getDevice } from '../../engine/network'
import { useWorkspace, type ConsoleWin } from '../../stores/workspace'
import TerminalPane from './TerminalPane.vue'

const props = defineProps<{ win: ConsoleWin }>()
const ws = useWorkspace()
const root = ref<HTMLDivElement>()
const term = ref<InstanceType<typeof TerminalPane>>()
const device = computed(() => getDevice(ws.topo, props.win.deviceId))
const front = computed(() => Math.max(...ws.consoles.map((c) => c.z)) === props.win.z)

let drag: { dx: number; dy: number } | null = null

/** Keeps the title bar inside the canvas area so a window can't be lost off-screen. */
function clamp() {
  const area = root.value?.parentElement
  if (!area || !root.value) return
  props.win.x = Math.min(Math.max(0, props.win.x), Math.max(0, area.clientWidth - 120))
  props.win.y = Math.min(Math.max(0, props.win.y), Math.max(0, area.clientHeight - 32))
}

function startDrag(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button')) return
  ws.focusConsole(props.win.deviceId)
  drag = { dx: e.clientX - props.win.x, dy: e.clientY - props.win.y }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onDrag(e: PointerEvent) {
  if (!drag) return
  props.win.x = e.clientX - drag.dx
  props.win.y = e.clientY - drag.dy
  clamp()
}

function endDrag() {
  drag = null
  term.value?.focus()
}

function focus() {
  ws.focusConsole(props.win.deviceId)
  ws.selection = { kind: 'device', id: props.win.deviceId }
}

/** Esc inside a console closes that console. */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  ws.closeConsole(props.win.deviceId)
}

onMounted(() => {
  // Set once, not bound: a bound size would undo the user's resize on every re-render.
  const area = root.value!.parentElement!
  root.value!.style.width = `${Math.min(640, area.clientWidth - 16)}px`
  root.value!.style.height = `${Math.min(380, area.clientHeight - 16)}px`
  clamp()
  nextTick(() => term.value?.focus())
})
</script>

<template>
  <div
    ref="root"
    class="pointer-events-auto absolute flex min-h-[180px] min-w-[360px] resize flex-col overflow-hidden border bg-bg shadow-2xl shadow-black"
    :class="front ? 'border-neon/60' : 'border-line'"
    :style="{ left: win.x + 'px', top: win.y + 'px', zIndex: 30 + win.z }"
    @pointerdown="focus"
    @keydown.capture="onKey"
  >
    <div
      class="flex cursor-move items-center justify-between border-b border-line bg-panel-2 px-3 py-1.5 text-xs select-none"
      @pointerdown="startDrag"
      @pointermove="onDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <span class="truncate">
        <span :class="front ? 'text-neon' : 'text-dim'">●</span>
        {{ device && isIos(device) ? 'COM1 · serial console' : 'terminal' }} · {{ device?.name ?? '(deleted)' }}
      </span>
      <button class="px-1 text-dim hover:text-danger" title="Close (Esc)" @click="ws.closeConsole(win.deviceId)">✕</button>
    </div>
    <div class="min-h-0 flex-1">
      <TerminalPane ref="term" :device-id="win.deviceId" />
    </div>
    <div class="border-t border-line px-3 py-0.5 text-[10px] text-dim">
      drag the title to move · drag the corner to resize · Esc closes
    </div>
  </div>
</template>
