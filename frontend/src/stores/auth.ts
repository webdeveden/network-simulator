import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, TOKEN_KEY, type User } from '../lib/api'

export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false)

  // The token can stop working mid-session (expired, or the server's secret key changed).
  // Drop it so the UI stops claiming we're logged in. /auth/* 401s are just wrong passwords.
  api.interceptors.response.use(undefined, (e) => {
    if (e.response?.status === 401 && !e.config?.url?.startsWith('/auth/')) logout()
    return Promise.reject(e)
  })

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
