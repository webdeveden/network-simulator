<script setup lang="ts">
/**
 * The Wireless LAN Controller dashboard, Cisco WLC style: a list of WLANs you create
 * and edit (SSID, security, VLAN, enabled), plus which access points have joined. APs
 * that can reach this WLC over the wired network auto-join and broadcast its WLANs.
 */
import { computed } from 'vue'
import { getDevice } from '../../engine/network'
import { controllerFor, newWlan } from '../../engine/wlc'
import { useWorkspace } from '../../stores/workspace'

const props = defineProps<{ deviceId: string }>()
const ws = useWorkspace()
const dev = computed(() => getDevice(ws.topo, props.deviceId))
const wlans = computed(() => {
  const d = dev.value
  if (!d) return []
  if (!d.wlc) d.wlc = { wlans: [] }
  return d.wlc.wlans
})
/** APs that have joined this controller (so you can see it's working). */
const joined = computed(() => ws.topo.devices.filter((d) => d.type === 'ap' && controllerFor(ws.topo, d)?.id === props.deviceId))

function add() {
  dev.value!.wlc!.wlans.push(newWlan(dev.value!))
}
function remove(id: number) {
  dev.value!.wlc!.wlans = wlans.value.filter((w) => w.id !== id)
}
</script>

<template>
  <div v-if="dev">
    <h3 class="section flex items-center justify-between">
      <span>WLC dashboard · WLANs</span>
      <button class="btn px-2 py-0.5 text-[10px]" @click="add">+ Create</button>
    </h3>

    <div v-if="!wlans.length" class="mb-2 text-[10px] text-dim">No WLANs yet. Create one, give it an SSID and security, and enable it — joined APs will broadcast it.</div>

    <div v-for="w in wlans" :key="w.id" class="mb-2 border border-line bg-panel-2/40 p-2">
      <div class="mb-1 flex items-center justify-between text-[10px] text-dim">
        <span>WLAN {{ w.id }}</span>
        <label class="flex cursor-pointer items-center gap-1 text-text">
          <input v-model="w.enabled" type="checkbox" /> enabled
        </label>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-dim">SSID</span>
          <input v-model="w.ssid" class="input" placeholder="CORP" />
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-dim">Client VLAN</span>
          <input :value="w.vlan ?? ''" class="input" placeholder="e.g. 10" @input="w.vlan = Number(($event.target as HTMLInputElement).value) || undefined" />
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="text-[10px] text-dim">Security</span>
          <select v-model="w.security" class="input">
            <option value="open">Open</option>
            <option value="wpa2">WPA2-PSK</option>
          </select>
        </label>
        <label v-if="w.security === 'wpa2'" class="flex flex-col gap-0.5">
          <span class="text-[10px] text-dim">Passphrase (8–63)</span>
          <input v-model="w.psk" class="input" placeholder="pre-shared key" />
        </label>
      </div>
      <div class="mt-1 flex items-center justify-between text-[10px]">
        <label class="flex cursor-pointer items-center gap-1 text-dim"><input v-model="w.broadcast" type="checkbox" /> broadcast SSID</label>
        <button class="text-danger hover:glow" @click="remove(w.id)">✕ delete</button>
      </div>
      <p v-if="w.security === 'wpa2' && w.psk && (w.psk.length < 8 || w.psk.length > 63)" class="mt-0.5 text-[10px] text-warn">WPA2 passphrase must be 8–63 characters.</p>
      <p v-if="w.enabled && !w.ssid" class="mt-0.5 text-[10px] text-warn">Set an SSID or this WLAN is ignored.</p>
    </div>

    <h3 class="section">access points joined</h3>
    <div class="text-[10px]">
      <div v-if="!joined.length" class="text-dim">None yet. Cable an access point into the same switched network as this controller; it joins automatically (CAPWAP) and goes lightweight.</div>
      <div v-for="ap in joined" :key="ap.id" class="flex items-center justify-between py-0.5">
        <span class="text-neon">● {{ ap.name }}</span>
        <span class="text-dim">lightweight · serving {{ wlans.filter((w) => w.enabled && w.ssid).length }} WLAN(s)</span>
      </div>
    </div>
  </div>
</template>
