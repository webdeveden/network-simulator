import axios from 'axios'
import type { TopologySpec } from '../engine/network'
import type { Objective } from '../engine/objectives'
import type { DeviceType, Topology } from '../engine/types'

export const TOKEN_KEY = 'netsim.token'

export const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export function errorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const detail = e.response?.data?.detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d) => d.msg).join(', ')
    if (!e.response) return 'Backend unreachable — is the API running?'
    return e.message
  }
  return String(e)
}

export interface User {
  id: number
  username: string
}

export interface Mission {
  id: string
  order: number
  title: string
  tagline: string
  difficulty: 1 | 2 | 3
  briefing: string
  start: TopologySpec
  palette: DeviceType[]
  budget: number
  par_cost: number
  par_time: number
  objectives: Objective[]
  hints: string[]
}

export interface ProgressEntry {
  mission_id: string
  stars: number
  best_time: number
  best_cost: number
}

export interface SavedTopology {
  id: number
  name: string
  data: Topology
  updated_at: string
}
