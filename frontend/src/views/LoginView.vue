<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { errorMessage } from '../lib/api'
import { useAuth } from '../stores/auth'
import { useMissions } from '../stores/missions'

const auth = useAuth()
const missions = useMissions()
const router = useRouter()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function submit() {
  error.value = null
  busy.value = true
  try {
    await auth.authenticate(mode.value, username.value.trim(), password.value)
    await missions.loadProgress()
    router.push('/missions')
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex h-full items-center justify-center">
    <form class="panel w-80 p-6" @submit.prevent="submit">
      <div class="text-[10px] tracking-[0.2em] text-cyan uppercase">// secure terminal</div>
      <h1 class="mt-1 text-lg font-bold text-neon glow">{{ mode === 'login' ? 'authenticate' : 'new operator' }}</h1>
      <label class="mt-5 block text-[10px] text-dim uppercase">username</label>
      <input v-model="username" class="input mt-1" autocomplete="username" required minlength="3" />
      <label class="mt-3 block text-[10px] text-dim uppercase">password</label>
      <input
        v-model="password"
        type="password"
        class="input mt-1"
        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
        required
        minlength="6"
      />
      <div v-if="error" class="mt-3 text-[11px] text-danger">! {{ error }}</div>
      <button class="btn btn-primary mt-5 w-full" :disabled="busy">&gt; {{ mode }}</button>
      <button
        type="button"
        class="mt-3 w-full text-center text-[11px] text-dim hover:text-cyan"
        @click="mode = mode === 'login' ? 'register' : 'login'"
      >
        {{ mode === 'login' ? 'no account? register' : 'have an account? login' }}
      </button>
    </form>
  </div>
</template>
