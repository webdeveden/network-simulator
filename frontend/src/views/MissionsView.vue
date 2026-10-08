<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import type { Mission } from '../lib/api'
import { useMissions } from '../stores/missions'

const missions = useMissions()
const router = useRouter()

onMounted(() => missions.load())

function open(m: Mission) {
  if (missions.unlocked(m)) router.push(`/missions/${m.id}`)
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1 class="text-lg font-bold text-neon glow">&gt; missions</h1>
      <p class="mt-1 text-xs text-dim">Complete a mission to unlock the next one. Stars: complete it, stay under par cost, beat par time.</p>

      <div v-if="missions.error" class="mt-6 border border-danger p-3 text-xs text-danger">{{ missions.error }}</div>

      <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <button
          v-for="m in missions.list"
          :key="m.id"
          class="panel group p-4 text-left transition"
          :class="missions.unlocked(m) ? 'hover:border-neon hover:shadow-[0_0_14px_rgba(57,255,136,.25)]' : 'cursor-not-allowed opacity-40'"
          @click="open(m)"
        >
          <div class="flex items-center justify-between text-[10px] text-dim">
            <span>MISSION {{ String(m.order).padStart(2, '0') }}</span>
            <span class="text-warn">{{ '◆'.repeat(m.difficulty) }}<span class="text-line">{{ '◆'.repeat(3 - m.difficulty) }}</span></span>
          </div>
          <div class="mt-2 font-semibold text-text group-hover:text-neon">{{ m.title }}</div>
          <div class="mt-1 text-[11px] text-dim">{{ m.tagline }}</div>
          <div class="mt-3 flex items-center justify-between text-[11px]">
            <span v-if="!missions.unlocked(m)" class="text-dim">🔒 locked</span>
            <span v-else class="text-warn">
              {{ '★'.repeat(missions.progress[m.id]?.stars ?? 0) }}<span class="text-line">{{ '★'.repeat(3 - (missions.progress[m.id]?.stars ?? 0)) }}</span>
            </span>
            <span class="text-dim">budget ${{ m.budget }}</span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
