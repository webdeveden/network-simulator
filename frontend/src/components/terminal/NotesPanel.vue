<script setup lang="ts">
import { computed } from 'vue'
import { emptySimState } from '../../engine/forwarding'
import { isIos, longName, sshPreflight } from '../../engine/ios'
import { getDevice, netIfaces } from '../../engine/network'
import { roomLabel, roomLayout, roomOf } from '../../room/layout'
import { useWorkspace } from '../../stores/workspace'

/**
 * The admin's notebook: every network device's IPs (always current), a log of IP
 * changes as they happen, and free-text notes saved on this PC.
 */
const props = defineProps<{ deviceId: string }>()
const emit = defineEmits<{ ssh: [host: string] }>()
const ws = useWorkspace()
const me = computed(() => getDevice(ws.topo, props.deviceId))

const NOTED = ['router', 'firewall', 'switch', 'ap', 'modem', 'isp']
const rows = computed(() => {
  const racks = roomLayout(ws.topo).racks
  return ws.topo.devices
    .filter((d) => NOTED.includes(d.type))
    .sort((a, b) => NOTED.indexOf(a.type) - NOTED.indexOf(b.type) || a.name.localeCompare(b.name))
    .map((d) => {
      const rack = racks.find((r) => r.deviceIds.includes(d.id))
      const ips = netIfaces(d).filter((i) => i.ip)
      const first = ips.find((i) => i.name !== 'lo0')?.ip
      const ready = !!me.value && !!first && isIos(d) && sshPreflight(ws.topo, emptySimState(), me.value, first, true).ok
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        where: d.type === 'isp' ? 'outside' : rack ? `${rack.name} · ${roomLabel(ws.topo, rack.room)}` : roomLabel(ws.topo, roomOf(d, ws.topo)),
        ips: ips.map((i) => ({ iface: longName(i.name), cidr: `${i.ip}/${i.prefix}` })),
        sshHost: first,
        ready,
      }
    })
})

const log = computed(() => [...(ws.topo.ipLog ?? [])].reverse())
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function copyAll() {
  const text = rows.value.map((r) => `${r.name}\t${r.type}\t${r.ips.map((i) => `${i.iface} ${i.cidr}`).join(', ') || 'no IP'}`).join('\n')
  navigator.clipboard?.writeText(text).then(() => ws.notify('IP list copied'))
}

function setNotes(e: Event) {
  if (me.value) me.value.notes = (e.target as HTMLTextAreaElement).value
}
</script>

<template>
  <div class="h-full overflow-y-auto px-3 py-2 text-xs">
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[10px] tracking-[0.2em] text-dim uppercase">// network devices · IP addresses</span>
      <button class="text-[10px] text-dim hover:text-neon" title="Copy as text" @click="copyAll">copy</button>
    </div>
    <table class="w-full border-collapse">
      <tbody>
        <tr v-for="r in rows" :key="r.id" class="border-b border-line align-top">
          <td class="py-1 pr-2">
            <div class="font-semibold text-text">{{ r.name }}</div>
            <div class="text-[10px] text-dim">{{ r.type }} · {{ r.where }}</div>
          </td>
          <td class="py-1 pr-2">
            <div v-for="ip in r.ips" :key="ip.iface" class="font-mono">
              <span class="text-cyan">{{ ip.cidr }}</span> <span class="text-[10px] text-dim">{{ ip.iface }}</span>
            </div>
            <div v-if="!r.ips.length" class="text-[10px] text-warn">no IP yet</div>
          </td>
          <td class="py-1 text-right">
            <button
              v-if="r.sshHost && r.type !== 'isp'"
              class="border px-1.5 text-[10px]"
              :class="r.ready ? 'border-neon text-neon hover:bg-neon hover:text-bg' : 'border-line text-dim hover:text-text'"
              :title="r.ready ? `ssh admin@${r.sshHost}` : 'Not SSH-ready yet: the PuTTY tab says what is missing'"
              @click="emit('ssh', r.sshHost!)"
            >
              SSH
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!rows.length" class="text-dim">No routers, switches, firewalls or APs yet.</p>

    <div class="mt-4 mb-1 text-[10px] tracking-[0.2em] text-dim uppercase">// changes (added automatically)</div>
    <div class="max-h-36 overflow-y-auto border border-line p-1.5 font-mono text-[11px]">
      <div v-for="(e, k) in log" :key="k">
        <span class="text-dim">{{ time(e.t) }}</span>
        {{ e.device }} <span class="text-dim">{{ longName(e.iface) }}</span>
        <template v-if="e.ip">→ <span class="text-neon">{{ e.ip }}</span></template>
        <template v-else>→ <span class="text-danger">removed</span></template>
        <span v-if="e.was" class="text-dim"> (was {{ e.was }})</span>
      </div>
      <div v-if="!log.length" class="text-dim">Nothing yet: assign an IP on a router, switch, firewall or AP and it shows up here.</div>
    </div>

    <div class="mt-4 mb-1 text-[10px] tracking-[0.2em] text-dim uppercase">// my notes</div>
    <textarea
      class="input h-24 w-full resize-y font-mono"
      placeholder="Usernames, subnets, what's left to configure…"
      :value="me?.notes ?? ''"
      @input="setNotes"
    />
  </div>
</template>
