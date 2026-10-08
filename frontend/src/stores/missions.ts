import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, errorMessage, type Mission, type ProgressEntry } from '../lib/api'
import { useAuth } from './auth'

const GUEST_PROGRESS_KEY = 'netsim.guestProgress'

export const useMissions = defineStore('missions', () => {
  const list = ref<Mission[]>([])
  const progress = ref<Record<string, ProgressEntry>>({})
  const error = ref<string | null>(null)

  async function load() {
    error.value = null
    try {
      list.value = (await api.get<Mission[]>('/missions')).data
    } catch (e) {
      error.value = errorMessage(e)
    }
    await loadProgress()
  }

  async function loadProgress() {
    const auth = useAuth()
    if (auth.user) {
      try {
        const entries = (await api.get<ProgressEntry[]>('/progress')).data
        progress.value = Object.fromEntries(entries.map((p) => [p.mission_id, p]))
      } catch {
        progress.value = {}
      }
    } else {
      try {
        progress.value = JSON.parse(localStorage.getItem(GUEST_PROGRESS_KEY) ?? '{}')
      } catch {
        progress.value = {}
      }
    }
  }

  async function get(id: string): Promise<Mission> {
    const cached = list.value.find((m) => m.id === id)
    if (cached) return cached
    return (await api.get<Mission>(`/missions/${id}`)).data
  }

  function unlocked(m: Mission): boolean {
    if (progress.value[m.id]) return true
    const prev = list.value.find((x) => x.order === m.order - 1)
    return !prev || !!progress.value[prev.id]
  }

  /** Records a completion; the server keeps the best result per mission. */
  async function complete(missionId: string, stars: number, time: number, cost: number, topology: unknown) {
    const auth = useAuth()
    if (auth.user) {
      const entry = (
        await api.post<ProgressEntry>(`/missions/${missionId}/complete`, { stars, time, cost, topology })
      ).data
      progress.value[missionId] = entry
    } else {
      const prev = progress.value[missionId]
      progress.value[missionId] = {
        mission_id: missionId,
        stars: Math.max(stars, prev?.stars ?? 0),
        best_time: Math.min(time, prev?.best_time ?? Infinity),
        best_cost: Math.min(cost, prev?.best_cost ?? Infinity),
      }
      localStorage.setItem(GUEST_PROGRESS_KEY, JSON.stringify(progress.value))
    }
  }

  return { list, progress, error, load, loadProgress, get, unlocked, complete }
})
