<script setup lang="ts">
import { computed, ref } from 'vue'
import { getDevice } from '../../engine/network'
import { roomColor, roomLabel, roomLayout } from '../../room/layout'
import { useWorkspace } from '../../stores/workspace'
import DeviceIcon from '../canvas/DeviceIcon.vue'

/** The selected rack: what's in it, show it in 3D, delete it (with a confirmation). */
const props = defineProps<{ index: number }>()
const ws = useWorkspace()

const rack = computed(() => roomLayout(ws.topo).racks.find((r) => r.index === props.index))
const devices = computed(() => (rack.value?.deviceIds ?? []).map((id) => getDevice(ws.topo, id)!).filter(Boolean))
const confirming = ref(false)

function remove() {
  confirming.value = false
  ws.deleteRack(props.index)
}
</script>

<template>
  <div v-if="rack">
    <div class="flex items-center gap-2">
      <span class="text-xl leading-none" :style="{ color: roomColor(ws.topo, rack.room) }">{{ rack.kind === 'wall' ? '▭' : '▥' }}</span>
      <div class="text-sm font-semibold text-text">{{ rack.name }}</div>
    </div>
    <p class="mt-2 text-[10px] text-dim">
      {{ rack.kind === 'wall' ? 'Wall-mounted mini rack (IDF)' : 'Floor rack (MDF)' }} in the {{ roomLabel(ws.topo, rack.room) }}.
      {{ rack.kind === 'wall' ? 'Holds a few devices, typically a switch and a patch panel.' : '2 m tall.' }}
    </p>

    <button class="btn mt-2 w-full" title="Stand in front of this rack in the 3D room" @click="ws.goToRack(rack.index)">📍 Show in 3D</button>

    <h3 class="section">mounted · {{ devices.length }}</h3>
    <p v-if="!devices.length" class="text-[11px] text-dim">Empty. Drag a device onto it in 3D, or pick it when adding a device.</p>
    <button
      v-for="d in devices"
      :key="d.id"
      class="flex w-full items-center gap-2 py-0.5 text-left hover:text-neon"
      @click="ws.selection = { kind: 'device', id: d.id }"
    >
      <DeviceIcon :type="d.type" :size="16" />
      <span>{{ d.name }}</span>
    </button>

    <button class="btn mt-5 w-full text-danger!" @click="confirming = true">delete rack</button>

    <!-- Confirmation -->
    <Teleport to="body">
      <div v-if="confirming" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="confirming = false">
        <div class="w-[min(380px,100%)] border border-line bg-panel p-4 text-xs shadow-2xl shadow-black" @keydown.esc="confirming = false">
          <div class="mb-2 text-sm font-semibold text-danger">Delete {{ rack.name }}?</div>
          <p class="text-text">
            The rack is removed from the {{ roomLabel(ws.topo, rack.room) }}.
            <template v-if="devices.length">
              Its {{ devices.length }} device{{ devices.length === 1 ? '' : 's' }}
              ({{ devices.map((d) => d.name).join(', ') }}) will move to the server room's other racks, cables and settings intact.
            </template>
          </p>
          <p v-if="rack.kind === 'floor'" class="mt-2 text-[10px] text-dim">The floor racks after it move up one place, so they stay numbered 1, 2, 3…</p>
          <div class="mt-4 flex justify-end gap-2">
            <button class="btn" @click="confirming = false">Cancel</button>
            <button class="btn border-danger! text-danger!" @click="remove">Delete rack</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.section {
  margin: 1rem 0 0.4rem;
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-dim);
}
.section::before {
  content: '// ';
}
</style>
