<script setup lang="ts">
/**
 * Shown after dragging a cable between two devices on the 2D map: pick the port on
 * each end (and the cable), like walking up to the rack and choosing where to plug in.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CABLES, cableFor, copperFor, getDevice, isRadio, isVirtual, linkOn, peerOf, portKind, suggestPorts, type PortKind } from '../../engine/network'
import type { CableChoice, CableType, Device } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'

const ws = useWorkspace()

const a = computed(() => (ws.pendingLink ? getDevice(ws.topo, ws.pendingLink.a) : undefined))
const b = computed(() => (ws.pendingLink ? getDevice(ws.topo, ws.pendingLink.b) : undefined))
const pickA = ref<string | undefined>()
const pickB = ref<string | undefined>()

const CHOICES: { id: CableChoice; label: string; color: string }[] = [
  { id: 'auto', label: 'Auto', color: '#c9d6e8' },
  ...(Object.entries(CABLES) as [Exclude<CableChoice, 'auto'>, (typeof CABLES)['straight']][]).map(([id, c]) => ({ id, label: c.label, color: c.color })),
]

const KIND: Record<PortKind, { label: string; color: string }> = {
  copper: { label: 'copper RJ45', color: '#22d3ee' },
  fiber: { label: 'fiber SFP', color: CABLES.fiber.color },
  console: { label: 'console', color: CABLES.console.color },
  radio: { label: 'radio', color: '#8892a6' },
  virtual: { label: 'virtual', color: '#8892a6' },
}

interface Port {
  name: string
  kind: PortKind
  used: string | null
}

function portsOf(d: Device | undefined): { group: string; ports: Port[] }[] {
  if (!d) return []
  const list: Port[] = d.ifaces
    .filter((i) => !isVirtual(i.name) && !isRadio(i.name))
    .map((i) => {
      const l = linkOn(ws.topo, d.id, i.name)
      const peer = l && peerOf(l, d.id, i.name)
      return { name: i.name, kind: portKind(d, i.name), used: peer ? `${getDevice(ws.topo, peer.device)?.name ?? '?'} ${peer.iface}` : null }
    })
  if (d.type === 'patch')
    return [
      { group: 'front (patch cords to switches)', ports: list.filter((p) => !p.name.endsWith('r')) },
      { group: 'rear (cable runs from the offices)', ports: list.filter((p) => p.name.endsWith('r')) },
    ]
  const order: PortKind[] = ['copper', 'fiber', 'console']
  return order.map((k) => ({ group: KIND[k].label, ports: list.filter((p) => p.kind === k) })).filter((g) => g.ports.length)
}

const groupsA = computed(() => portsOf(a.value))
const groupsB = computed(() => portsOf(b.value))

function suggest() {
  if (!a.value || !b.value) return
  const [x, y] = suggestPorts(ws.topo, a.value, b.value, ws.cable)
  pickA.value = x
  pickB.value = y
}
watch(() => ws.pendingLink, suggest, { immediate: true })

function setCable(c: CableChoice) {
  ws.setCable(c)
  // Keep the picks if they still fit this cable, else suggest new ones.
  if (!pickA.value || !pickB.value || !(cableFor(c, a.value!, pickA.value, b.value!, pickB.value) in CABLES)) suggest()
}

/** What would be laid, or why it can't be. */
const verdict = computed((): { ok: boolean; text: string; warn?: string } => {
  if (!a.value || !b.value) return { ok: false, text: '' }
  if (!pickA.value || !pickB.value) return { ok: false, text: `Pick a free port on ${!pickA.value ? a.value.name : b.value.name}.` }
  const got = cableFor(ws.cable, a.value, pickA.value, b.value, pickB.value)
  // cableFor returns a cable type, or why the cable can't go there.
  if (!(got in CABLES)) return { ok: false, text: got }
  const r = got as CableType
  const text = `${CABLES[r].label} cable, $${CABLES[r].cost}: ${a.value.name} ${pickA.value} ↔ ${b.value.name} ${pickB.value}`
  const copper = r === 'straight' || r === 'crossover'
  const needs = copper ? copperFor(a.value, b.value, pickA.value, pickB.value) : r
  const warn = copper && needs !== r ? `These two ports need a ${CABLES[needs].label.toLowerCase()} cable: with ${CABLES[r].label.toLowerCase()} the link stays down.` : undefined
  return { ok: true, text, warn }
})

function connect() {
  if (verdict.value.ok && pickA.value && pickB.value) ws.confirmLink(pickA.value, pickB.value)
}
function cancel() {
  ws.pendingLink = null
}
function onKey(e: KeyboardEvent) {
  if (!ws.pendingLink) return
  if (e.key === 'Escape') cancel()
  else if (e.key === 'Enter') connect()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const sides = computed(() => [
  { dev: a.value, groups: groupsA.value, pick: pickA },
  { dev: b.value, groups: groupsB.value, pick: pickB },
])
</script>

<template>
  <div v-if="ws.pendingLink && a && b" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="cancel">
    <div class="flex max-h-[calc(100vh-2rem)] w-[min(720px,100%)] flex-col border border-line bg-panel text-xs shadow-2xl shadow-black">
      <div class="border-b border-line p-4 pb-3">
        <div class="text-sm font-semibold text-neon">Connect {{ a.name }} ↔ {{ b.name }}</div>
        <div class="mt-0.5 text-[10px] text-dim">Pick the port on each end, like choosing where to plug in at the rack.</div>
        <div class="mt-3 flex flex-wrap gap-1">
          <button
            v-for="c in CHOICES"
            :key="c.id"
            class="border px-2 py-1 text-[10px]"
            :class="ws.cable === c.id ? 'border-neon bg-panel-2 text-text' : 'border-line text-dim hover:text-text'"
            @click="setCable(c.id)"
          >
            <span class="mr-1 inline-block h-1.5 w-3 align-middle" :style="{ background: c.color }" />{{ c.label }}
          </button>
        </div>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2">
        <div v-for="(s, k) in sides" :key="k">
          <div class="mb-1 flex items-baseline justify-between">
            <span class="font-semibold text-text">{{ s.dev!.name }}</span>
            <span class="text-[10px] text-cyan">{{ s.pick.value ?? 'no port' }}</span>
          </div>
          <div v-for="g in s.groups" :key="g.group" class="mb-2">
            <div class="mb-1 text-[10px] uppercase tracking-wider text-dim">{{ g.group }}</div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="p in g.ports"
                :key="p.name"
                :disabled="!!p.used"
                :title="p.used ? `${p.name}: in use → ${p.used}` : `${p.name}: free (${KIND[p.kind].label})`"
                class="min-w-[3.25rem] border px-1.5 py-1 text-[10px] leading-none"
                :class="[
                  p.used ? 'cursor-not-allowed opacity-35 line-through' : 'hover:bg-panel-2',
                  s.pick.value === p.name ? 'bg-panel-2 text-text' : 'text-dim',
                  p.kind === 'fiber' ? 'rounded-full' : '',
                ]"
                :style="{ borderColor: s.pick.value === p.name ? '#39ff88' : KIND[p.kind].color, boxShadow: s.pick.value === p.name ? '0 0 0 1px #39ff88' : undefined }"
                @click="s.pick.value = p.name"
              >
                {{ p.name }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="border-t border-line p-4 pt-3">
        <div class="mb-2 flex flex-wrap gap-3 text-[10px] text-dim">
          <span v-for="k in ['copper', 'fiber', 'console'] as PortKind[]" :key="k">
            <span class="mr-1 inline-block h-2.5 w-4 border align-middle" :class="k === 'fiber' ? 'rounded-full' : ''" :style="{ borderColor: KIND[k].color }" />{{ KIND[k].label }}
          </span>
          <span><span class="mr-1 line-through opacity-50">fa0/1</span>in use</span>
        </div>
        <p :class="verdict.ok ? 'text-neon' : 'text-danger'">{{ verdict.text }}</p>
        <p v-if="verdict.warn" class="mt-0.5 text-warn">{{ verdict.warn }}</p>
        <div class="mt-3 flex justify-end gap-2">
          <button class="btn" @click="cancel">Cancel</button>
          <button class="btn btn-primary" :disabled="!verdict.ok" @click="connect">Connect</button>
        </div>
      </div>
    </div>
  </div>
</template>
