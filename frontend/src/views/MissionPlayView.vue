<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import Workspace from '../components/Workspace.vue'
import { buildTopology } from '../engine/network'
import { evaluate, fmtTime as fmt, starRules, type ObjectiveStatus, type StarRule } from '../engine/objectives'
import { errorMessage, type Mission } from '../lib/api'
import { useAuth } from '../stores/auth'
import { useMissions } from '../stores/missions'
import { useWorkspace } from '../stores/workspace'

const props = defineProps<{ id: string }>()
const auth = useAuth()
const missions = useMissions()
const ws = useWorkspace()

const mission = ref<Mission | null>(null)
const error = ref<string | null>(null)
const showBriefing = ref(true)
const hintsShown = ref(0)
const seconds = ref(0)
const result = ref<{ stars: number; rules: StarRule[]; time: number; cost: number; saveError?: string } | null>(null)
/** Set means the mission failed: why, and the objectives that didn't work at that moment. */
const failed = ref<{ reason: 'done' | 'time'; unmet: ObjectiveStatus[] } | null>(null)
/** The briefing was accepted once: reopening it from the HUD then reads "resume". */
const accepted = ref(false)
const confirmingDone = ref(false)
/** The player closed the result/failure screen to look at their network; the HUD can reopen it. */
const outcomeHidden = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

const status = computed(() => (mission.value ? evaluate(ws.topo, mission.value.objectives) : []))
const timeLeft = computed(() => (mission.value ? Math.max(0, mission.value.time_limit - seconds.value) : 0))
const nextMission = computed(() =>
  mission.value ? missions.list.find((m) => m.order === mission.value!.order + 1) : undefined,
)

function start() {
  const m = mission.value!
  ws.load(buildTopology(m.start), { palette: m.palette, budget: m.budget })
  seconds.value = 0
  hintsShown.value = 0
  result.value = null
  failed.value = null
  confirmingDone.value = false
  outcomeHidden.value = false
  clearInterval(timer)
  timer = setInterval(() => {
    if (showBriefing.value || confirmingDone.value || result.value || failed.value) return
    seconds.value++
    // Out of time: grade what's there, as if the player had clicked done
    if (seconds.value >= m.time_limit) finish('time')
  }, 1000)
}

async function load() {
  error.value = null
  mission.value = null
  showBriefing.value = true
  accepted.value = false
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

/** Escape closes whichever overlay is open: the confirm, or the result (to look at the finished network). */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (showBriefing.value && accepted.value) showBriefing.value = false
  else if (confirmingDone.value) confirmingDone.value = false
  else if (result.value || failed.value) outcomeHidden.value = true
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function accept() {
  accepted.value = true
  showBriefing.value = false
}

function submitDone() {
  confirmingDone.value = false
  finish('done')
}

/** Grades the network as it is now: every objective must work, or the mission fails. */
async function finish(reason: 'done' | 'time') {
  if (result.value || failed.value || !mission.value) return
  const m = mission.value
  const unmet = status.value.filter((s) => !s.done)
  if (unmet.length) {
    failed.value = { reason, unmet }
    return
  }
  const rules = starRules(ws.spent, m.par_cost, seconds.value, m.par_time)
  const r = { stars: rules.filter((s) => s.earned).length, rules, time: seconds.value, cost: ws.spent }
  result.value = r
  try {
    await missions.complete(m.id, r.stars, r.time, r.cost, ws.topo)
  } catch (e) {
    // A 401 logs us out (see the auth store), so the message can say why
    const saveError = auth.user ? errorMessage(e) : 'your login expired. Log in again and it will be saved.'
    result.value = { ...r, saveError }
  }
}
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
            time left
            <span :class="timeLeft <= 30 ? 'text-danger' : seconds > mission.par_time ? 'text-warn' : 'text-neon'">{{ fmt(timeLeft) }}</span>
            <span class="text-dim"> (par: done in {{ fmt(mission.par_time) }})</span>
          </span>
          <div class="ml-auto flex gap-2">
            <button class="btn" @click="showBriefing = true">briefing</button>
            <button class="btn" @click="start">restart</button>
            <button v-if="result || failed" class="btn btn-primary" @click="outcomeHidden = false">show result</button>
            <button v-else class="btn btn-primary" @click="confirmingDone = true">done</button>
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
        <div class="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          <p>
            You have <span class="text-neon">{{ fmt(mission.time_limit) }}</span>. Click
            <span class="text-neon">done</span> when your network is ready: if every objective works you pass, if not the
            mission fails. When time runs out, your network is graded as it stands.
          </p>
          <p class="mt-1">
            ★ complete it · ★ finish within {{ fmt(mission.par_time) }} · ★ spend no more than ${{ mission.par_cost }}
          </p>
        </div>
        <div class="mt-6 flex gap-2">
          <RouterLink to="/missions" class="btn">&lt; back to missions</RouterLink>
          <button class="btn btn-primary" @click="accept">{{ accepted ? '> resume' : '> accept mission' }}</button>
        </div>
      </div>
    </div>

    <!-- Confirm done -->
    <div
      v-if="confirmingDone"
      class="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      @click.self="confirmingDone = false"
    >
      <div class="panel max-w-sm p-6 text-center">
        <div class="text-sm font-bold text-neon">Submit for grading?</div>
        <p class="mt-3 text-xs leading-relaxed text-dim">
          Your network is checked as it is now. If every objective works you pass; if any fails, the mission fails.
        </p>
        <p class="mt-2 text-[11px] text-dim">The clock is paused while you decide.</p>
        <div class="mt-6 flex justify-center gap-2">
          <button class="btn" @click="confirmingDone = false">keep working</button>
          <button class="btn btn-primary" @click="submitDone">submit</button>
        </div>
      </div>
    </div>

    <!-- Result -->
    <div
      v-if="result && !outcomeHidden"
      class="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      @click.self="outcomeHidden = true"
    >
      <div class="panel relative min-w-80 border-neon! p-6 text-center shadow-[0_0_30px_rgba(57,255,136,.3)]">
        <button class="absolute top-2 right-3 text-dim hover:text-neon" title="Close (Esc)" @click="outcomeHidden = true">✕</button>
        <div class="text-lg font-bold text-neon glow">MISSION COMPLETE</div>
        <div class="mt-3 text-3xl tracking-widest text-warn">
          {{ '★'.repeat(result.stars) }}<span class="text-line">{{ '★'.repeat(3 - result.stars) }}</span>
        </div>
        <div class="mt-3 text-xs text-dim">
          time {{ fmt(result.time) }} · cost ${{ result.cost }}
        </div>
        <ul class="mx-auto mt-3 w-fit space-y-0.5 text-left text-[11px]">
          <li v-for="s in result.rules" :key="s.label" :class="s.earned ? 'text-warn' : 'text-dim'">
            {{ s.earned ? '★' : '☆' }} {{ s.label }}
          </li>
        </ul>
        <div v-if="result.saveError" class="mt-2 text-[11px] text-danger">
          Progress not saved: {{ result.saveError }}
          <RouterLink v-if="!auth.user" to="/login" class="underline">log in</RouterLink>
        </div>
        <div class="mt-6 flex justify-center gap-2">
          <button class="btn" @click="start">play again</button>
          <RouterLink to="/missions" class="btn">all missions</RouterLink>
          <RouterLink v-if="nextMission" :to="`/missions/${nextMission.id}`" class="btn btn-primary">next mission &gt;</RouterLink>
        </div>
      </div>
    </div>

    <!-- Failed: graded with objectives still broken -->
    <div
      v-if="failed && !outcomeHidden"
      class="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      @click.self="outcomeHidden = true"
    >
      <div class="panel relative max-w-md min-w-80 border-danger! p-6 text-center">
        <button class="absolute top-2 right-3 text-dim hover:text-danger" title="Close (Esc)" @click="outcomeHidden = true">✕</button>
        <div class="text-lg font-bold text-danger">MISSION FAILED</div>
        <div class="mt-2 text-xs text-dim">
          {{ failed.reason === 'time' ? `Time's up (${fmt(mission.time_limit)}).` : `Submitted at ${fmt(seconds)}.` }}
          These objectives didn't work:
        </div>
        <ul class="mt-3 space-y-1.5 text-left text-xs">
          <li v-for="s in failed.unmet" :key="s.objective.label">
            <span class="text-danger">[ ]</span> {{ s.objective.label }}
            <div class="ml-6 text-[11px] text-dim">{{ s.detail }}</div>
          </li>
        </ul>
        <div class="mt-6 flex justify-center gap-2">
          <button class="btn btn-primary" @click="start">try again</button>
          <RouterLink to="/missions" class="btn">all missions</RouterLink>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="p-10 text-dim">loading mission…</div>
</template>
