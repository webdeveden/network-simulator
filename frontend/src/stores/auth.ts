import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, TOKEN_KEY, type User } from '../lib/api'

export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false)

  async function init() {
    if (ready.value) return
    if (localStorage.getItem(TOKEN_KEY)) {
      try {
        user.value = (await api.get<User>('/auth/me')).data
      } catch {
        localStorage.removeItem(TOKEN_KEY)
      }
    }
    ready.value = true
  }

  async function authenticate(mode: 'login' | 'register', username: string, password: string) {
    const { data } = await api.post<{ access_token: string; user: User }>(`/auth/${mode}`, {
      username,
      password,
    })
    localStorage.setItem(TOKEN_KEY, data.access_token)
    user.value = data.user
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    user.value = null
  }

  return { user, ready, init, authenticate, logout }
})
