<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { isIos } from '../../engine/ios'
import { getDevice } from '../../engine/network'
import { useWorkspace, type ConsoleWin } from '../../stores/workspace'
import LearnPanel from './LearnPanel.vue'
import NotesPanel from './NotesPanel.vue'
import PuttyPanel from './PuttyPanel.vue'
import { roomOf } from '../../room/layout'
import TerminalPane from './TerminalPane.vue'

const props = defineProps<{ win: ConsoleWin }>()
const ws = useWorkspace()
const root = ref<HTMLDivElement>()
const term = ref<InstanceType<typeof TerminalPane>>()
const device = computed(() => getDevice(ws.topo, props.win.deviceId))
type Tab = 'console' | 'putty' | 'notes' | 'learn'
const tab = ref<Tab>('console')
/** PCs and laptops get a PuTTY tab for SSH/serial sessions to network devices. */
/** The admin PC (a PC or laptop at the server room desk) also keeps Notes with every device's IP. */
const isAdminPc = computed(() => !!device.value && (device.value.type === 'pc' || device.value.type === 'laptop') && roomOf(device.value, ws.topo) === 'server')
const tabs = computed<Tab[]>(() =>
  device.value?.type === 'pc' || device.value?.type === 'laptop'
    ? isAdminPc.value
      ? ['console', 'putty', 'notes', 'learn']
      : ['console', 'putty', 'learn']
    : ['console', 'learn'],
)

function openSession(cmd: string) {
  tab.value = 'console'
  nextTick(() => term.value?.runCommand(cmd))
}

/** A command clicked in the Learn tab goes onto the console's input line. */
function typeCommand(cmd: string) {
  tab.value = 'console'
  nextTick(() => term.value?.setInput(cmd))
}

function selectTab(t: Tab) {
  tab.value = t
  if (t === 'console') nextTick(() => term.value?.focus())
}

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
    <div class="flex border-b border-line bg-panel text-[11px]">
      <button
        v-for="t in tabs"
        :key="t"
        class="px-3 py-1 tracking-wider uppercase"
        :class="tab === t ? 'border-b-2 border-neon text-neon' : 'text-dim hover:text-text'"
        @click="selectTab(t)"
      >
        {{ t === 'console' ? 'Console' : t === 'putty' ? 'PuTTY' : t === 'notes' ? 'Notes' : 'Learn' }}
      </button>
    </div>
    <!-- v-show keeps the terminal session and scrollback while reading lessons -->
    <div v-show="tab === 'console'" class="min-h-0 flex-1">
      <TerminalPane ref="term" :device-id="win.deviceId" />
    </div>
    <!-- kept alive too, so returning to Learn keeps your place in the lesson -->
    <div v-if="tab === 'notes'" class="min-h-0 flex-1">
      <NotesPanel :device-id="win.deviceId" @ssh="(h) => openSession(`ssh admin@${h}`)" />
    </div>
    <div v-if="tab === 'putty'" class="min-h-0 flex-1">
      <PuttyPanel :device-id="win.deviceId" @open="openSession" />
    </div>
    <div v-show="tab === 'learn'" class="min-h-0 flex-1">
      <LearnPanel :device-id="win.deviceId" @type="typeCommand" />
    </div>
    <div class="border-t border-line px-3 py-0.5 text-[10px] text-dim">
      drag the title to move · drag the corner to resize · Esc closes
    </div>
  </div>
</template>
