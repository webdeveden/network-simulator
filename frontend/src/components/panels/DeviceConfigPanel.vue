<script setup lang="ts">
import { deskRoomsFor, onDesk, roomLabel, roomOf } from '../../room/layout'
import { ref, watch } from 'vue'
import { parseRule } from '../../engine/commands'
import { formatRule } from '../../engine/forwarding'
import { isValidIp, parseCidr } from '../../engine/ip'
import { cableProblem, CABLES, DEVICE_CATALOG, getDevice, isConsolePort, isHost, isPhonePcPort, linkActive, linkOn, peerOf, portKind, setIfaceIp } from '../../engine/network'
import { useWorkspace } from '../../stores/workspace'
import DeviceIcon from '../canvas/DeviceIcon.vue'
import RackPanel from './RackPanel.vue'

const ws = useWorkspace()

const drafts = ref<Record<string, string>>({})
const gwDraft = ref('')
const nameDraft = ref('')
const routeNet = ref('')
const routeVia = ref('')
const ruleDraft = ref('deny any any any')
const pingTarget = ref('')

// Re-sync drafts when the selection changes or the CLI edits the device.
watch(
  () => {
    const d = ws.selectedDevice
    return d && [d.id, d.name, d.gateway, ...d.ifaces.map((i) => `${i.ip}/${i.prefix}`)].join('|')
  },
  () => {
    const d = ws.selectedDevice
    if (!d) return
    drafts.value = Object.fromEntries(d.ifaces.map((i) => [i.name, i.ip ? `${i.ip}/${i.prefix}` : '']))
    gwDraft.value = d.gateway ?? ''
    nameDraft.value = d.name
  },
  { immediate: true },
)

function peerLabel(iface: string): string {
  const d = ws.selectedDevice!
  const l = linkOn(ws.topo, d.id, iface)
  if (!l) return '—'
  const p = peerOf(l, d.id, iface)
  return `${getDevice(ws.topo, p.device)?.name ?? '?'} ${p.iface}`
}

function applyIp(iface: string) {
  const d = ws.selectedDevice!
  const value = drafts.value[iface].trim()
  const current = d.ifaces.find((i) => i.name === iface)
  if (value === (current?.ip ? `${current.ip}/${current.prefix}` : '')) return
  const e = setIfaceIp(d, iface, value || 'none')
  if (e) ws.notify(e, 'err')
  else ws.notify(value ? `${d.name} ${iface} = ${value}` : `${d.name} ${iface} cleared`)
}

function applyGateway() {
  const d = ws.selectedDevice!
  const g = gwDraft.value.trim()
  if (g === (d.gateway ?? '')) return
  if (g === '') delete d.gateway
  else if (!isValidIp(g)) return ws.notify(`Invalid gateway "${g}"`, 'err')
  else d.gateway = g
  ws.notify(`${d.name} gateway = ${g || '(none)'}`)
}

function applyName() {
  const d = ws.selectedDevice!
  const n = nameDraft.value.trim()
  if (n === d.name) return
  if (!/^[\w-]{1,16}$/.test(n) || ws.topo.devices.some((x) => x !== d && x.name.toLowerCase() === n.toLowerCase())) {
    nameDraft.value = d.name
    return ws.notify('Invalid or duplicate name', 'err')
  }
  d.name = n
}

function addRoute() {
  const d = ws.selectedDevice!
  const net = routeNet.value.trim() === 'default' ? { ip: '0.0.0.0', prefix: 0 } : parseCidr(routeNet.value, -1)
  if (!net || net.prefix < 0) return ws.notify('Network must be CIDR, e.g. 10.0.2.0/24, or "default"', 'err')
  if (!isValidIp(routeVia.value.trim())) return ws.notify('Next hop must be an IP address', 'err')
  d.routes.push({ network: net.ip, prefix: net.prefix, via: routeVia.value.trim() })
  routeNet.value = ''
  routeVia.value = ''
}

function addRule() {
  const r = parseRule(ruleDraft.value.trim().split(/\s+/))
  if (typeof r === 'string') return ws.notify('Rule format: allow|deny <src> <dst> [proto[/port]]', 'err')
  ws.selectedDevice!.fwRules.push(r)
}

function moveRule(i: number, delta: number) {
  const rules = ws.selectedDevice!.fwRules
  const j = i + delta
  if (j < 0 || j >= rules.length) return
  ;[rules[i], rules[j]] = [rules[j], rules[i]]
}

function doPing() {
  const t = pingTarget.value.trim()
  const ip = isValidIp(t) ? t : getDevice(ws.topo, t)?.ifaces.find((i) => i.ip)?.ip
  if (!ip) return ws.notify(`Unknown target "${t}"`, 'err')
  ws.pingFromGui(ws.selectedDevice!.id, ip)
}
</script>

<template>
  <aside class="h-full overflow-y-auto p-3 text-xs">
    <!-- Device -->
    <template v-if="ws.selectedDevice">
      <div class="flex items-center gap-2">
        <DeviceIcon :type="ws.selectedDevice.type" :size="26" class="text-neon" />
        <input
          v-model="nameDraft"
          class="input font-semibold"
          :disabled="ws.selectedDevice.locked"
          @keydown.enter="applyName"
          @blur="applyName"
        />
      </div>
      <p class="mt-2 text-[10px] text-dim">{{ DEVICE_CATALOG[ws.selectedDevice.type].description }}</p>
      <button
        v-if="ws.selectedDevice.type !== 'isp'"
        class="btn mt-2 w-full"
        title="Walk up to this device in the 3D room"
        @click="ws.goToDevice(ws.selectedDevice.id)"
      >
        📍 Show in 3D
      </button>

      <template v-if="onDesk(ws.selectedDevice)">
        <h3 class="section">room</h3>
        <select
          class="input"
          :value="roomOf(ws.selectedDevice, ws.topo)"
          @change="ws.moveToRoom(ws.selectedDevice.id, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="o in deskRoomsFor(ws.topo, ws.selectedDevice.type)" :key="o.id" :value="o.id">{{ roomLabel(ws.topo, o.id) }}</option>
        </select>
      </template>

      <h3 class="section">interfaces</h3>
      <div v-for="i in ws.selectedDevice.ifaces" :key="i.name" class="mb-2">
        <div class="flex justify-between text-[10px]">
          <span class="text-cyan">
            {{ i.name }}
            <span v-if="portKind(ws.selectedDevice, i.name) !== 'copper'" class="text-dim">· {{ portKind(ws.selectedDevice, i.name) }}</span>
          </span>
          <span class="text-dim">{{ peerLabel(i.name) }}</span>
        </div>
        <input
          v-if="DEVICE_CATALOG[ws.selectedDevice.type].layer === 3 && !isConsolePort(i.name) && !isPhonePcPort(ws.selectedDevice, i.name)"
          v-model="drafts[i.name]"
          class="input mt-0.5"
          placeholder="ip/prefix e.g. 192.168.1.10/24"
          @keydown.enter="applyIp(i.name)"
          @blur="applyIp(i.name)"
        />
      </div>

      <p v-if="ws.selectedDevice.type === 'ap'" class="mt-1 text-[10px] text-dim">
        Configure Wi-Fi from the console: dot11 ssid, then interface Dot11Radio0.
      </p>
      <template v-if="isHost(ws.selectedDevice)">
        <h3 class="section">default gateway</h3>
        <input v-model="gwDraft" class="input" placeholder="router IP on this subnet" @keydown.enter="applyGateway" @blur="applyGateway" />
      </template>

      <template v-if="ws.selectedDevice.type === 'router' || ws.selectedDevice.type === 'firewall'">
        <h3 class="section">static routes</h3>
        <div v-for="(r, n) in ws.selectedDevice.routes" :key="n" class="flex items-center justify-between py-0.5">
          <span>{{ r.network }}/{{ r.prefix }} → {{ r.via }}</span>
          <button class="text-danger hover:glow" @click="ws.selectedDevice.routes.splice(n, 1)">✕</button>
        </div>
        <div class="mt-1 flex gap-1">
          <input v-model="routeNet" class="input" placeholder="net/prefix" />
          <input v-model="routeVia" class="input" placeholder="via" @keydown.enter="addRoute" />
          <button class="btn" @click="addRoute">+</button>
        </div>
      </template>

      <template v-if="ws.selectedDevice.type === 'firewall'">
        <h3 class="section">firewall rules <span class="normal-case tracking-normal">(first match wins)</span></h3>
        <div v-for="(r, n) in ws.selectedDevice.fwRules" :key="n" class="flex items-center gap-1 py-0.5">
          <span class="w-5 text-dim">#{{ n + 1 }}</span>
          <span class="flex-1" :class="r.action === 'allow' ? 'text-neon' : 'text-danger'">{{ formatRule(r) }}</span>
          <button class="text-dim hover:text-text" @click="moveRule(n, -1)">↑</button>
          <button class="text-dim hover:text-text" @click="moveRule(n, 1)">↓</button>
          <button class="text-danger" @click="ws.selectedDevice.fwRules.splice(n, 1)">✕</button>
        </div>
        <div class="mt-1 flex gap-1">
          <input v-model="ruleDraft" class="input" placeholder="deny 10.0.2.0/24 10.0.3.10 tcp/22" @keydown.enter="addRule" />
          <button class="btn" @click="addRule">+</button>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <span class="text-dim">default:</span>
          <button
            v-for="p in ['allow', 'deny'] as const"
            :key="p"
            class="btn"
            :class="ws.selectedDevice.fwDefault === p && 'btn-primary'"
            @click="ws.selectedDevice.fwDefault = p"
          >
            {{ p }}
          </button>
        </div>
      </template>

      <template v-if="DEVICE_CATALOG[ws.selectedDevice.type].layer === 3">
        <h3 class="section">quick ping</h3>
        <div class="flex gap-1">
          <input v-model="pingTarget" class="input" placeholder="ip or device name" @keydown.enter="doPing" />
          <button class="btn btn-primary" @click="doPing">ping</button>
        </div>
      </template>

      <button v-if="!ws.selectedDevice.locked" class="btn mt-5 w-full text-danger!" @click="ws.removeSelected()">
        delete device
      </button>
    </template>

    <!-- Rack -->
    <RackPanel v-else-if="ws.selection?.kind === 'rack'" :index="Number(ws.selection.id)" />

    <!-- Link -->
    <template v-else-if="ws.selectedLink">
      <div class="text-sm font-semibold" :style="{ color: ws.selectedLink.wifi ? '#22d3ee' : CABLES[ws.selectedLink.cable ?? 'straight'].color }">
        {{ ws.selectedLink.wifi ? `Wi-Fi · ${ws.selectedLink.wifi.ssid}` : `${CABLES[ws.selectedLink.cable ?? 'straight'].label} cable` }}
      </div>
      <p v-if="!ws.selectedLink.wifi" class="mt-1 text-[10px] text-dim">{{ CABLES[ws.selectedLink.cable ?? 'straight'].description.replace(/`/g, '') }}</p>
      <p class="mt-2">
        {{ getDevice(ws.topo, ws.selectedLink.a.device)?.name }} <span class="text-dim">{{ ws.selectedLink.a.iface }}</span>
        ⟷
        {{ getDevice(ws.topo, ws.selectedLink.b.device)?.name }} <span class="text-dim">{{ ws.selectedLink.b.iface }}</span>
      </p>
      <p v-if="ws.selectedLink.cable === 'console'" class="mt-2">
        status: <span class="text-cyan">management only</span>
        <span class="block text-[10px] text-dim">Carries no network traffic. On the PC, type console.</span>
      </p>
      <p v-else class="mt-2">
        status:
        <span :class="linkActive(ws.topo, ws.selectedLink) ? 'text-neon' : 'text-danger'">{{ linkActive(ws.topo, ws.selectedLink) ? 'UP' : 'DOWN' }}</span>
        <span v-if="cableProblem(ws.topo, ws.selectedLink)" class="mt-1 block text-[11px] text-danger">{{ cableProblem(ws.topo, ws.selectedLink) }}</span>
      </p>
      <div class="mt-3 flex gap-2">
        <button class="btn" @click="ws.selectedLink.up = !ws.selectedLink.up">
          {{ ws.selectedLink.up ? 'shut down' : 'bring up' }}
        </button>
        <button class="btn text-danger!" @click="ws.removeSelected()">cut cable</button>
      </div>
    </template>

    <div v-else class="mt-10 text-center text-dim">
      <div class="text-neon glow">&gt;_</div>
      <p class="mt-2">Select a device or a cable</p>
    </div>
  </aside>
</template>

<style scoped>
.section {
  margin: 1rem 0 0.4rem;
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-dim);
}
.section::before {
  content: '// ';
}
</style>
