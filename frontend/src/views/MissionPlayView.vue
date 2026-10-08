<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import Workspace from '../components/Workspace.vue'
import { buildTopology } from '../engine/network'
import { evaluate, stars } from '../engine/objectives'
import { errorMessage, type Mission } from '../lib/api'
import { useMissions } from '../stores/missions'
import { useWorkspace } from '../stores/workspace'

const props = defineProps<{ id: string }>()
const missions = useMissions()
const ws = useWorkspace()

const mission = ref<Mission | null>(null)
const error = ref<string | null>(null)
const showBriefing = ref(true)
const hintsShown = ref(0)
const seconds = ref(0)
const result = ref<{ stars: number; time: number; cost: number; saveError?: string } | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

const status = computed(() => (mission.value ? evaluate(ws.topo, mission.value.objectives) : []))
const allDone = computed(() => status.value.length > 0 && status.value.every((s) => s.done))
const nextMission = computed(() =>
  mission.value ? missions.list.find((m) => m.order === mission.value!.order + 1) : undefined,
)

function start() {
  const m = mission.value!
  ws.load(buildTopology(m.start), { palette: m.palette, budget: m.budget })
  seconds.value = 0
  hintsShown.value = 0
  result.value = null
  clearInterval(timer)
  timer = setInterval(() => {
    if (!showBriefing.value && !result.value) seconds.value++
  }, 1000)
}

async function load() {
  error.value = null
  mission.value = null
  showBriefing.value = true
  try {
    if (!missions.list.length) await missions.load()
    mission.value = await missions.get(props.id)
    start()
  } catch (e) {
    error.value = errorMessage(e)
  }
}

onMounted(load)
watch(() => props.id, load)
onBeforeUnmount(() => clearInterval(timer))

watch(allDone, async (done) => {
  if (!done || result.value || !mission.value) return
  const m = mission.value
  const r = { stars: stars(ws.spent, m.par_cost, seconds.value, m.par_time), time: seconds.value, cost: ws.spent }
  // Let the packet animation that triggered the win finish before covering the canvas.
  await new Promise((res) => setTimeout(res, 2200))
  if (!allDone.value || result.value || mission.value !== m) return
  result.value = r
  try {
    await missions.complete(m.id, r.stars, r.time, r.cost, ws.topo)
  } catch (e) {
    result.value = { ...r, saveError: errorMessage(e) }
  }
})

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
</script>

<template>
  <div v-if="error" class="p-10 text-danger">{{ error }}</div>
  <div v-else-if="mission" class="relative h-full">
    <Workspace>
      <template #hud>
        <div class="flex items-center gap-6 border-b border-line bg-panel-2 px-4 py-2 text-xs">
          <span class="font-semibold text-neon">M{{ String(mission.order).padStart(2, '0') }} // {{ mission.title }}</span>
          <span>
            budget
            <span :class="ws.spent > mission.par_cost ? 'text-warn' : 'text-neon'">${{ ws.spent }}</span>
            <span class="text-dim"> / ${{ mission.budget }} (par ${{ mission.par_cost }})</span>
          </span>
          <span>
            time <span :class="seconds > mission.par_time ? 'text-warn' : 'text-neon'">{{ fmt(seconds) }}</span>
            <span class="text-dim"> (par {{ fmt(mission.par_time) }})</span>
          </span>
          <div class="ml-auto flex gap-2">
            <button class="btn" @click="showBriefing = true">briefing</button>
            <button class="btn" @click="start">restart</button>
          </div>
        </div>
      </template>

      <template #side>
        <div class="max-h-[45%] overflow-y-auto border-t border-line p-3 text-xs">
          <div class="mb-2 text-[10px] tracking-[0.2em] text-dim uppercase">// objectives</div>
          <div v-for="(s, i) in status" :key="i" class="mb-1.5 flex gap-2" :title="s.detail">
            <span :class="s.done ? 'text-neon' : 'text-dim'">{{ s.done ? '[x]' : '[ ]' }}</span>
            <span :class="s.done ? 'text-neon' : ''">{{ s.objective.label }}</span>
          </div>
          <div class="mt-3 text-[10px] tracking-[0.2em] text-dim uppercase">// hints</div>
          <p v-for="h in mission.hints.slice(0, hintsShown)" :key="h" class="mt-1 text-[11px] text-warn">› {{ h }}</p>
          <button v-if="hintsShown < mission.hints.length" class="btn mt-2" @click="hintsShown++">
            reveal hint ({{ hintsShown }}/{{ mission.hints.length }})
          </button>
        </div>
      </template>
    </Workspace>

    <!-- Briefing -->
    <div v-if="showBriefing" class="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 backdrop-blur-sm">
      <div class="panel max-w-lg border-cyan! p-6">
        <div class="text-[10px] tracking-[0.2em] text-cyan uppercase">incoming transmission // mission {{ mission.order }}</div>
        <h2 class="mt-2 text-lg font-bold text-neon glow">{{ mission.title }}</h2>
        <p class="mt-3 text-xs leading-relaxed whitespace-pre-line">{{ mission.briefing }}</p>
        <ul class="mt-4 space-y-1 text-xs text-dim">
          <li v-for="o in mission.objectives" :key="o.label">› {{ o.label }}</li>
        </ul>
        <button class="btn btn-primary mt-6" @click="showBriefing = false">&gt; accept mission</button>
      </div>
    </div>

    <!-- Result -->
    <div v-if="result" class="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 backdrop-blur-sm">
      <div class="panel min-w-80 border-neon! p-6 text-center shadow-[0_0_30px_rgba(57,255,136,.3)]">
        <div class="text-lg font-bold text-neon glow">MISSION COMPLETE</div>
        <div class="mt-3 text-3xl tracking-widest text-warn">
          {{ '★'.repeat(result.stars) }}<span class="text-line">{{ '★'.repeat(3 - result.stars) }}</span>
        </div>
        <div class="mt-3 text-xs text-dim">
          time {{ fmt(result.time) }} · cost ${{ result.cost }}
        </div>
        <div v-if="result.saveError" class="mt-2 text-[11px] text-danger">Progress not saved: {{ result.saveError }}</div>
        <div class="mt-6 flex justify-center gap-2">
          <button class="btn" @click="start">retry</button>
          <RouterLink to="/missions" class="btn">missions</RouterLink>
          <RouterLink v-if="nextMission" :to="`/missions/${nextMission.id}`" class="btn btn-primary">next &gt;</RouterLink>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="p-10 text-dim">loading mission…</div>
</template>
