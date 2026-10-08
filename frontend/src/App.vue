<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { useAuth } from './stores/auth'
import { useMissions } from './stores/missions'

const auth = useAuth()
const missions = useMissions()
const router = useRouter()

function logout() {
  auth.logout()
  missions.loadProgress()
  router.push('/')
}
</script>

<template>
  <div class="scanlines flex h-full flex-col">
    <header class="flex h-11 shrink-0 items-center gap-6 border-b border-line bg-panel px-4">
      <RouterLink to="/" class="font-extrabold tracking-widest text-neon glow">NETSIM<span class="text-magenta">_</span></RouterLink>
      <nav class="flex gap-4 text-[11px] tracking-[0.15em] uppercase">
        <RouterLink to="/missions" class="text-dim hover:text-neon" active-class="text-neon!">missions</RouterLink>
        <RouterLink to="/sandbox" class="text-dim hover:text-neon" active-class="text-neon!">sandbox</RouterLink>
      </nav>
      <div class="ml-auto text-[11px]">
        <template v-if="auth.user">
          <span class="text-dim">operator:</span> <span class="text-cyan">{{ auth.user.username }}</span>
          <button class="ml-3 text-dim hover:text-danger" @click="logout">[logout]</button>
        </template>
        <RouterLink v-else to="/login" class="text-dim hover:text-neon">[login]</RouterLink>
      </div>
    </header>
    <main class="min-h-0 flex-1">
      <RouterView />
    </main>
  </div>
</template>
