<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getDevice } from '../../engine/network'
import { deviceFacts } from '../../learn/facts'
import { topicsFor } from '../../learn/lessons'
import { useWorkspace } from '../../stores/workspace'

const props = defineProps<{ deviceId: string }>()
const emit = defineEmits<{ type: [command: string] }>()
const ws = useWorkspace()

const device = computed(() => getDevice(ws.topo, props.deviceId))
const topics = computed(() => (device.value ? topicsFor(device.value.type) : []))
const facts = computed(() => (device.value ? deviceFacts(ws.topo, device.value) : []))
const open = ref<string | null>(null)
watch(topics, (t) => (open.value = t[0]?.id ?? null), { immediate: true })

/** Splits "use `ping` here" into text and code parts. */
const parts = (text: string) => text.split('`').map((t, k) => ({ t, code: k % 2 === 1 }))
</script>

<template>
  <div v-if="device" class="h-full overflow-y-auto px-3 py-2 text-xs leading-relaxed">
    <div class="mb-3 border border-line bg-panel-2 p-2">
      <div class="mb-1 text-[10px] tracking-[0.2em] text-dim uppercase">// this device · {{ device.name }}</div>
      <div v-for="f in facts" :key="f.label + f.value" class="flex gap-2">
        <span class="w-20 shrink-0 text-dim">{{ f.label }}</span>
        <span :class="f.tone === 'ok' ? 'text-neon' : f.tone === 'warn' ? 'text-warn' : 'text-text'">{{ f.value }}</span>
      </div>
    </div>

    <p class="mb-2 text-[10px] text-dim">Click a command to type it into the console, then press Enter.</p>

    <div v-for="t in topics" :key="t.id" class="mb-1 border border-line">
      <button
        class="flex w-full items-center justify-between px-2 py-1.5 text-left hover:text-neon"
        :class="open === t.id ? 'bg-panel-2 text-neon' : 'text-text'"
        @click="open = open === t.id ? null : t.id"
      >
        <span class="font-semibold">{{ t.title }}</span>
        <span class="text-dim">{{ open === t.id ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open === t.id" class="px-2 pt-1 pb-2">
        <p v-for="(b, k) in t.body" :key="k" class="mb-1.5">
          <template v-for="(p, j) in parts(b)" :key="j">
            <code v-if="p.code" class="bg-bg px-1 text-cyan">{{ p.t }}</code>
            <template v-else>{{ p.t }}</template>
          </template>
        </p>
        <pre v-if="t.diagram" class="my-2 overflow-x-auto border border-line bg-bg p-2 text-[11px] text-cyan">{{ t.diagram }}</pre>
        <div v-for="(ex, k) in t.examples ?? []" :key="k" class="mt-2">
          <div class="text-[10px] tracking-wider text-dim uppercase">example · {{ ex.title }}</div>
          <button
            v-for="(c, n) in ex.commands"
            :key="n"
            class="block w-full truncate border-l-2 border-transparent px-2 py-0.5 text-left font-mono text-neon hover:border-neon hover:bg-bg"
            :title="`Type “${c}” into the console`"
            @click="emit('type', c)"
          >
            <span class="text-dim">{{ n + 1 }}.</span> {{ c }}
          </button>
          <p v-if="ex.note" class="mt-1 text-[11px] text-dim">
            <template v-for="(p, j) in parts(ex.note)" :key="j">
              <code v-if="p.code" class="bg-bg px-1 text-cyan">{{ p.t }}</code>
              <template v-else>{{ p.t }}</template>
            </template>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
