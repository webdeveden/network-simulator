<script setup lang="ts">
import { computed, ref } from 'vue'
import { emptySimState } from '../../engine/forwarding'
import { isIos, sshPreflight } from '../../engine/ios'
import { getDevice, linkOn } from '../../engine/network'
import { useWorkspace } from '../../stores/workspace'

/**
 * A PuTTY-style SSH/serial client on a PC or laptop: pick a saved session (every
 * Cisco-style device) or type a host, choose SSH or Serial, and Open. Opening types
 * the matching command into this PC's console, so the login happens there.
 */
const props = defineProps<{ deviceId: string }>()
const emit = defineEmits<{ open: [command: string] }>()
const ws = useWorkspace()

const me = computed(() => getDevice(ws.topo, props.deviceId))
const host = ref('')
const user = ref('admin')
const kind = ref<'ssh' | 'serial'>('ssh')
const selected = ref<string | null>(null)

/** What the console cable on COM1 leads to, if any. */
const serialTarget = computed(() => {
  const l = me.value && linkOn(ws.topo, me.value.id, 'com1')
  if (!l) return null
  const peer = l.a.device === me.value!.id ? l.b : l.a
  return getDevice(ws.topo, peer.device) ?? null
})

/** Saved sessions: every router, switch, firewall, AP and ISP, with whether SSH would get to a login prompt. */
const sessions = computed(() => {
  const from = me.value
  if (!from) return []
  return ws.topo.devices
    .filter(isIos)
    .map((d) => {
      const ip = d.ifaces.find((i) => i.ip && i.name !== 'lo0')?.ip
      if (!ip) return { id: d.id, name: d.name, ip: '', ready: false, why: 'no IP address yet' }
      const check = sshPreflight(ws.topo, emptySimState(), from, ip, true)
      const why = check.ok ? 'ready' : (check.lines.find((l) => l.text.trim().startsWith('↳'))?.text.replace(/^\s*↳\s*/, '') ?? check.lines[0]?.text ?? '')
      return { id: d.id, name: d.name, ip, ready: check.ok, why }
    })
})

function load(s: { id: string; name: string; ip: string }) {
  selected.value = s.id
  host.value = s.ip || s.name
  kind.value = 'ssh'
}

function open() {
  if (kind.value === 'serial') return emit('open', 'console')
  const h = host.value.trim()
  if (!h || !user.value.trim()) return ws.notify('Enter a host and a username', 'err')
  emit('open', `ssh ${user.value.trim()}@${h}`)
}
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto px-3 py-2 text-xs">
    <div class="mb-2 text-[10px] tracking-[0.2em] text-dim uppercase">// PuTTY · session from {{ me?.name }}</div>

    <div class="grid grid-cols-[1fr_auto] gap-2">
      <label class="flex flex-col gap-0.5">
        <span class="text-[10px] text-dim">Host name (or IP address)</span>
        <input v-model="host" class="input" :disabled="kind === 'serial'" placeholder="10.0.0.1 or R1" @keydown.enter="open" />
      </label>
      <label class="flex flex-col gap-0.5">
        <span class="text-[10px] text-dim">Port</span>
        <input class="input w-16" :value="kind === 'ssh' ? 22 : 'COM1'" disabled />
      </label>
    </div>

    <div class="mt-2 flex items-center gap-4">
      <span class="text-[10px] text-dim">Connection type:</span>
      <label class="flex cursor-pointer items-center gap-1"><input v-model="kind" type="radio" value="ssh" /> SSH</label>
      <label class="flex cursor-pointer items-center gap-1" :class="!serialTarget && 'opacity-50'">
        <input v-model="kind" type="radio" value="serial" :disabled="!serialTarget" />
        Serial {{ serialTarget ? `(COM1 → ${serialTarget.name})` : '(no console cable on COM1)' }}
      </label>
    </div>

    <label v-if="kind === 'ssh'" class="mt-2 flex flex-col gap-0.5">
      <span class="text-[10px] text-dim">Login as</span>
      <input v-model="user" class="input w-40" @keydown.enter="open" />
    </label>

    <div class="mt-3 text-[10px] text-dim">Saved sessions</div>
    <div class="mt-1 max-h-44 min-h-16 overflow-y-auto border border-line">
      <button
        v-for="s in sessions"
        :key="s.id"
        class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-panel-2"
        :class="selected === s.id && 'bg-panel-2'"
        :title="s.why"
        @click="load(s)"
        @dblclick="load(s), open()"
      >
        <span :class="s.ready ? 'text-neon' : 'text-warn'">●</span>
        <span class="w-20 shrink-0 font-semibold">{{ s.name }}</span>
        <span class="w-24 shrink-0 text-dim">{{ s.ip || '—' }}</span>
        <span class="truncate text-[10px]" :class="s.ready ? 'text-neon' : 'text-dim'">{{ s.ready ? 'SSH ready' : s.why }}</span>
      </button>
      <div v-if="!sessions.length" class="p-2 text-dim">No routers, switches, firewalls or APs yet.</div>
    </div>

    <div class="mt-3 flex justify-end">
      <button class="btn btn-primary" @click="open">Open</button>
    </div>
    <p class="mt-2 text-[10px] leading-relaxed text-dim">
      Double-click a saved session to connect. The login happens in the Console tab; type <code class="text-cyan">exit</code> there to disconnect.
      A device is SSH-ready once it has an IP you can reach, RSA keys, a local user, and <code class="text-cyan">login local</code> on its vty lines.
    </p>
  </div>
</template>
