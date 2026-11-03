import axios from 'axios'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, errorMessage, type Mission, type ProgressEntry } from '../lib/api'
import { useAuth } from './auth'

const GUEST_PROGRESS_KEY = 'netsim.guestProgress'
const PENDING_KEY = 'netsim.pendingCompletions'

/** A completion the server refused because the login expired, sent again after the next login. */
interface PendingCompletion {
  userId: number
  missionId: string
  stars: number
  time: number
  cost: number
  topology: unknown
}

function readPending(): PendingCompletion[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')
  } catch {
    return []
  }
}

function writePending(list: PendingCompletion[]) {
  if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list))
  else localStorage.removeItem(PENDING_KEY)
}

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
      await flushPending(auth.user.id)
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
      // Read before the request: a 401 logs us out (see the auth store) before the catch runs
      const userId = auth.user.id
      try {
        const entry = (
          await api.post<ProgressEntry>(`/missions/${missionId}/complete`, { stars, time, cost, topology })
        ).data
        progress.value[missionId] = entry
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401) {
          writePending([...readPending(), { userId, missionId, stars, time, cost, topology }])
        }
        throw e
      }
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

  /** Sends queued completions for this user; any that fail stay queued for the next login. */
  async function flushPending(userId: number) {
    const left: PendingCompletion[] = []
    for (const p of readPending()) {
      if (p.userId !== userId) {
        left.push(p)
        continue
      }
      try {
        const { stars, time, cost, topology } = p
        await api.post(`/missions/${p.missionId}/complete`, { stars, time, cost, topology })
      } catch {
        left.push(p)
      }
    }
    writePending(left)
  }

  return { list, progress, error, load, loadProgress, get, unlocked, complete }
})
