<script setup lang="ts">
/**
 * Shown after dragging a cable between two devices on the 2D map: pick the port on
 * each end (and the cable), like walking up to the rack and choosing where to plug in.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CABLES, cableFor, getDevice, suggestPorts, type PortKind } from '../../engine/network'
import type { CableChoice } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'
import { CABLE_CHOICES, cableVerdict, PORT_KIND } from './cabling'
import PortGrid from './PortGrid.vue'

const ws = useWorkspace()

const a = computed(() => (ws.pendingLink ? getDevice(ws.topo, ws.pendingLink.a) : undefined))
const b = computed(() => (ws.pendingLink ? getDevice(ws.topo, ws.pendingLink.b) : undefined))
const pickA = ref<string | undefined>()
const pickB = ref<string | undefined>()

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
const verdict = computed(() => (a.value && b.value ? cableVerdict(ws.cable, a.value, pickA.value, b.value, pickB.value) : { ok: false, text: '' }))

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
  { dev: a.value, pick: pickA },
  { dev: b.value, pick: pickB },
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

      <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2">
        <div v-for="(s, k) in sides" :key="k">
          <div class="mb-1 flex items-baseline justify-between">
            <span class="font-semibold text-text">{{ s.dev!.name }}</span>
            <span class="text-[10px] text-cyan">{{ s.pick.value ?? 'no port' }}</span>
          </div>
          <PortGrid :device="s.dev!" :picked="s.pick.value" @pick="(p) => (s.pick.value = p)" />
        </div>
      </div>

      <div class="border-t border-line p-4 pt-3">
        <div class="mb-2 flex flex-wrap gap-3 text-[10px] text-dim">
          <span v-for="k in ['copper', 'fiber', 'console'] as PortKind[]" :key="k">
            <span class="mr-1 inline-block h-2.5 w-4 border align-middle" :class="k === 'fiber' ? 'rounded-full' : ''" :style="{ borderColor: PORT_KIND[k].color }" />{{ PORT_KIND[k].label }}
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
