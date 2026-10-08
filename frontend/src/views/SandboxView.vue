<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Workspace from '../components/Workspace.vue'
import { emptyTopology } from '../engine/network'
import type { Topology } from '../engine/types'
import { api, errorMessage, type SavedTopology } from '../lib/api'
import { useAuth } from '../stores/auth'
import { useWorkspace } from '../stores/workspace'

const AUTOSAVE_KEY = 'netsim.sandbox'

const ws = useWorkspace()
const auth = useAuth()
const saved = ref<SavedTopology[]>([])
const currentId = ref<number | null>(null)
const name = ref('my-network')
const showLoad = ref(false)

function restoreAutosave(): Topology {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore corrupt autosave */
  }
  return emptyTopology()
}

onMounted(async () => {
  ws.load(restoreAutosave())
  if (auth.user) await refresh()
})

const stop = watch(
  () => ws.topo,
  (t) => localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(t)),
  { deep: true },
)
onBeforeUnmount(stop)

async function refresh() {
  try {
    saved.value = (await api.get<SavedTopology[]>('/topologies')).data
  } catch (e) {
    ws.notify(errorMessage(e), 'err')
  }
}

async function save() {
  try {
    const body = { name: name.value.trim() || 'untitled', data: ws.topo }
    const r = currentId.value
      ? await api.put<SavedTopology>(`/topologies/${currentId.value}`, body)
      : await api.post<SavedTopology>('/topologies', body)
    currentId.value = r.data.id
    ws.notify(`Saved "${r.data.name}"`)
    await refresh()
  } catch (e) {
    ws.notify(errorMessage(e), 'err')
  }
}

function open(t: SavedTopology) {
  ws.load(t.data)
  currentId.value = t.id
  name.value = t.name
  showLoad.value = false
}

async function remove(t: SavedTopology) {
  if (!confirm(`Delete "${t.name}"?`)) return
  await api.delete(`/topologies/${t.id}`)
  if (currentId.value === t.id) currentId.value = null
  await refresh()
}

function clearAll() {
  if (!confirm('Clear the whole network?')) return
  ws.load(emptyTopology())
  currentId.value = null
}
</script>

<template>
  <div class="relative h-full">
    <Workspace>
      <template #hud>
        <div class="flex items-center gap-3 border-b border-line bg-panel-2 px-4 py-2 text-xs">
          <span class="font-semibold text-neon">SANDBOX</span>
          <span class="text-dim">{{ ws.topo.devices.length }} devices · {{ ws.topo.links.length }} cables · ${{ ws.spent }}</span>
          <div class="ml-auto flex items-center gap-2">
            <template v-if="auth.user">
              <input v-model="name" class="input w-40!" />
              <button class="btn btn-primary" @click="save">{{ currentId ? 'save' : 'save as' }}</button>
              <button class="btn" @click="(showLoad = true), refresh()">load</button>
              <button v-if="currentId" class="btn" @click="currentId = null">new copy</button>
            </template>
            <span v-else class="text-dim">autosaved locally · log in to keep several networks</span>
            <button class="btn text-danger!" @click="clearAll">clear</button>
          </div>
        </div>
      </template>
    </Workspace>

    <div v-if="showLoad" class="absolute inset-0 z-20 flex items-center justify-center bg-bg/80" @click.self="showLoad = false">
      <div class="panel w-96 p-5">
        <div class="mb-3 text-sm font-semibold text-neon">&gt; saved networks</div>
        <div v-if="!saved.length" class="text-xs text-dim">Nothing saved yet.</div>
        <div v-for="t in saved" :key="t.id" class="flex items-center justify-between border-b border-line py-2 text-xs">
          <button class="text-left hover:text-neon" @click="open(t)">
            {{ t.name }}
            <span class="block text-[10px] text-dim">{{ t.data.devices.length }} devices · {{ new Date(t.updated_at).toLocaleString() }}</span>
          </button>
          <button class="text-danger" @click="remove(t)">✕</button>
        </div>
        <button class="btn mt-4" @click="showLoad = false">close</button>
      </div>
    </div>
  </div>
</template>
