<script setup lang="ts">
/**
 * While carrying a cable in the 3D room: instead of walking it to the other end, pick
 * where it goes from a list (rooms → racks, desks with their PC and IP phone, printers,
 * APs) and the exact port, then plug it in.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CABLES, cableFor, getDevice, suggestPorts, type PortKind } from '../../engine/network'
import type { CableChoice } from '../../engine/types'
import { cablePlaces } from '../../room/places'
import { useWorkspace } from '../../stores/workspace'
import { CABLE_CHOICES, cableVerdict, PORT_KIND } from '../panels/cabling'
import PortGrid from '../panels/PortGrid.vue'

const props = defineProps<{ from: { deviceId: string; iface: string } }>()
const emit = defineEmits<{ close: []; done: [to: { deviceId: string; iface: string }] }>()
const ws = useWorkspace()

const source = computed(() => getDevice(ws.topo, props.from.deviceId))
const search = ref('')
const targetId = ref<string | null>(null)
const target = computed(() => (targetId.value ? getDevice(ws.topo, targetId.value) : undefined))
const port = ref<string | undefined>()

const groups = computed(() => {
  const q = search.value.trim().toLowerCase()
  const all = cablePlaces(ws.topo, props.from.deviceId)
  if (!q) return all
  return all
    .map((g) => ({
      ...g,
      places: g.places
        .map((p) => (p.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q) ? p : { ...p, items: p.items.filter((i) => i.name.toLowerCase().includes(q)) }))
        .filter((p) => p.items.length),
    }))
    .filter((g) => g.places.length)
})

/** Best free port on the target for this cable (the end we hold is fixed). */
function suggest() {
  const a = source.value
  const b = target.value
  if (!a || !b) return
  const [, y] = suggestPorts(ws.topo, a, b, ws.cable)
  port.value = y
}
watch(targetId, suggest)

function choose(id: string) {
  targetId.value = id
}

function setCable(c: CableChoice) {
  ws.setCable(c)
  if (!source.value || !target.value || !port.value || !(cableFor(c, source.value, props.from.iface, target.value, port.value) in CABLES)) suggest()
}

const verdict = computed(() => {
  if (!source.value) return { ok: false, text: '' }
  if (!target.value) return { ok: false, text: 'Pick where the cable goes on the left.' }
  return cableVerdict(ws.cable, source.value, props.from.iface, target.value, port.value)
})

function connect() {
  if (!verdict.value.ok || !target.value || !port.value) return
  if (ws.linkPorts(props.from.deviceId, props.from.iface, target.value.id, port.value)) emit('done', { deviceId: target.value.id, iface: port.value })
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  } else if (e.key === 'Enter') connect()
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

const ICON: Record<string, string> = { rack: '▤', desk: '▭', printer: '⎙', ap: '◉', outside: '☁' }
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="emit('close')">
    <div class="flex max-h-[calc(100vh-2rem)] w-[min(860px,100%)] flex-col border border-line bg-panel text-xs shadow-2xl shadow-black">
      <div class="border-b border-line p-4 pb-3">
        <div class="text-sm font-semibold text-neon">Connect {{ source?.name }} {{ from.iface }} to…</div>
        <div class="mt-0.5 text-[10px] text-dim">Choose the place and the port, instead of carrying the cable there yourself.</div>
        <div class="mt-3 flex flex-wrap gap-1">
          <button
            v-for="c in CABLE_CHOICES"
            :key="c.id"
            class="border px-2 py-1 text-[10px]"
            :class="ws.cable === c.id ? 'border-neon bg-panel-2 text-text' : 'border-line text-dim hover:text-text'"
            @click="setCable(c.id)"
          >
            <span class="mr-1 inline-block h-1.5 w-3 align-middle" :style="{ background: c.color }" />{{ c.label }}
          </button>
        </div>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[280px_1fr]">
        <!-- Where: rooms, racks, desks -->
        <div class="flex min-h-0 flex-col border-b border-line sm:border-r sm:border-b-0">
          <div class="p-3 pb-2"><input v-model="search" class="input w-full" placeholder="Search: PC3, SW1, Sales…" autofocus /></div>
          <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <div v-for="g in groups" :key="g.id" class="mb-3">
              <div class="mb-1 flex items-center gap-1.5 text-[10px] tracking-wider text-dim uppercase">
                <span class="inline-block h-2 w-2" :style="{ background: g.color }" />{{ g.label }}
              </div>
              <div v-for="p in g.places" :key="p.id" class="mb-1.5 border border-line/70 bg-panel-2/40">
                <div class="px-2 pt-1 text-[10px] text-dim"><span class="mr-1">{{ ICON[p.kind] }}</span>{{ p.label }}</div>
                <button
                  v-for="i in p.items"
                  :key="i.deviceId"
                  class="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-panel-2"
                  :class="targetId === i.deviceId ? 'bg-panel-2 text-neon' : 'text-text'"
                  @click="choose(i.deviceId)"
                >
                  <span>{{ i.name }} <span class="text-dim">· {{ i.type }}</span></span>
                  <span class="text-[10px]" :class="i.free ? 'text-dim' : 'text-danger'">{{ i.free }}/{{ i.total }} free</span>
                </button>
              </div>
            </div>
            <p v-if="!groups.length" class="text-dim">Nothing matches.</p>
          </div>
        </div>

        <!-- Which port -->
        <div class="min-h-0 overflow-y-auto p-4">
          <template v-if="target">
            <div class="mb-2 flex items-baseline justify-between">
              <span class="font-semibold text-text">{{ target.name }}</span>
              <span class="text-[10px] text-cyan">{{ port ?? 'no port' }}</span>
            </div>
            <PortGrid :device="target" :picked="port" @pick="(p) => (port = p)" />
          </template>
          <p v-else class="text-dim">← Pick a device: racks in the server room, desks (a PC with its IP phone) in the offices, printers and APs.</p>
        </div>
      </div>

      <div class="border-t border-line p-4 pt-3">
        <div class="mb-2 flex flex-wrap gap-3 text-[10px] text-dim">
          <span v-for="k in ['copper', 'fiber', 'console'] as PortKind[]" :key="k">
            <span class="mr-1 inline-block h-2.5 w-4 border align-middle" :class="k === 'fiber' ? 'rounded-full' : ''" :style="{ borderColor: PORT_KIND[k].color }" />{{ PORT_KIND[k].label }}
          </span>
          <span><span class="mr-1 line-through opacity-50">fa0/1</span>in use</span>
        </div>
        <p :class="verdict.ok ? 'text-neon' : 'text-dim'">{{ verdict.text }}</p>
        <p v-if="verdict.warn" class="mt-0.5 text-warn">{{ verdict.warn }}</p>
        <div class="mt-3 flex justify-end gap-2">
          <button class="btn" @click="emit('close')">Keep carrying</button>
          <button class="btn btn-primary" :disabled="!verdict.ok" @click="connect">Plug in</button>
        </div>
      </div>
    </div>
  </div>
</template>
