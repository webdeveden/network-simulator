<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEVICE_CATALOG, getDevice } from '../../engine/network'
import { deskRoomsFor, officesOf, onDesk, panelHeight, rackHasRoom, roomColor, roomLabel, roomLayout, roomOf, type RoomId } from '../../room/layout'
import { useWorkspace } from '../../stores/workspace'

/**
 * "Where does it go?" — shown when a device is added (rack or office), and for
 * adding an empty rack from the device list (`ws.rackDialog`).
 */
const ws = useWorkspace()
const p = computed(() => ws.pendingAdd)
const desk = computed(() => (p.value ? onDesk({ type: p.value.type } as never) : false))
const layout = computed(() => roomLayout(ws.topo))

/** Racks this device could go into, with how full they are. */
const racks = computed(() => {
  if (!p.value || desk.value) return []
  const h = panelHeight(p.value.type)
  return layout.value.racks.map((r) => {
    const heights = r.deviceIds.map((id) => panelHeight(getDevice(ws.topo, id)!.type))
    return {
      index: r.index,
      label: r.name,
      room: roomLabel(ws.topo, r.room),
      color: roomColor(ws.topo, r.room),
      kind: r.kind,
      count: r.deviceIds.length,
      fits: rackHasRoom([...heights, h], r.index),
    }
  })
})

/** Rooms this desk device may go in (balconies too for laptops and APs). */
const deskRooms = computed(() => (p.value ? deskRoomsFor(ws.topo, p.value.type) : []))
/** For a phone: PC and laptop desks that don't have a phone yet. */
const freeDesks = computed(() => {
  const taken = new Set(ws.topo.devices.filter((d) => d.type === 'phone' && d.deskOf).map((d) => d.deskOf))
  return ws.topo.devices.filter((d) => (d.type === 'pc' || d.type === 'laptop') && !taken.has(d.id))
})

/** Phones: the desks ticked (several at once). */
const picked = ref<string[]>([])
const allPicked = computed(() => freeDesks.value.length > 0 && picked.value.length === freeDesks.value.length)
function toggleAll() {
  picked.value = allPicked.value ? [] : freeDesks.value.map((d) => d.id)
  choice.value = 'desks'
}
/** Ticking a desk switches away from the "own desk in a room" choice. */
watch(picked, (v) => {
  if (v.length) choice.value = 'desks'
})
const phoneCount = computed(() => (p.value?.type === 'phone' && choice.value === 'desks' ? picked.value.length : 1))
const cost = computed(() => {
  if (!p.value) return 0
  // A new PC comes with an IP phone on its desk.
  const phone = p.value.type === 'pc' && ws.palette.includes('phone') ? DEVICE_CATALOG.phone.cost : 0
  return (DEVICE_CATALOG[p.value.type].cost + phone) * phoneCount.value
})

// The choice: 'rack:N', 'floor', 'wall:<office>', 'room:<office>', or 'desks' (phones on the ticked desks).
const choice = ref('')
const wallRoom = ref<RoomId>('it')
const rackName = ref('')

watch(
  p,
  (v) => {
    if (!v) return
    picked.value = []
    if (v.type === 'phone' && freeDesks.value.length && !v.preset?.room) {
      choice.value = 'desks'
      picked.value = [freeDesks.value[0].id]
    }
    else if (desk.value) choice.value = `room:${v.preset?.room && deskRooms.value.some((r) => r.id === v.preset!.room) ? v.preset.room : 'it'}`
    else if (v.preset?.rack !== undefined) choice.value = `rack:${v.preset.rack}`
    else {
      const first = racks.value.find((r) => r.fits && r.kind === 'floor')
      choice.value = first ? `rack:${first.index}` : 'floor'
    }
  },
  { immediate: true },
)

function confirm() {
  if (ws.roomDialog) return confirmRoom()
  if (ws.rackDialog) return confirmRack()
  const c = choice.value
  if (c === 'desks') {
    if (picked.value.length) ws.addPhones(picked.value)
    return
  }
  if (c.startsWith('rack:')) ws.confirmAdd({ rack: Number(c.slice(5)) })
  else if (c === 'floor') ws.confirmAdd({ newFloorRack: true })
  else if (c === 'wall') ws.confirmAdd({ newWallRack: wallRoom.value })
  else if (c.startsWith('room:')) ws.confirmAdd({ room: c.slice(5) })
}

// ----- adding an empty rack -----
const rackKind = ref<'floor' | 'wall'>('floor')
function confirmRack() {
  if (rackKind.value === 'floor') {
    const k = ws.addFloorRack()
    ws.notify(`Rack ${k + 1} added to the ${roomLabel(ws.topo, 'server')}`)
  } else {
    ws.addWallRack(wallRoom.value, rackName.value)
    ws.notify(`Wall rack added in ${roomLabel(ws.topo, wallRoom.value)}`)
  }
  ws.rackDialog = false
  rackName.value = ''
}

// ----- adding a room -----
const roomKind = ref<'office' | 'balcony'>('office')
const roomName = ref('')
const roomColorPick = ref('#a5b4fc')
const SWATCHES = ['#a5b4fc', '#ff8a4d', '#7dd3fc', '#c084fc', '#facc15', '#f87171', '#39ff88', '#22d3ee']
// Each "add a room" starts fresh: an office, no name.
watch(
  () => ws.roomDialog,
  (open) => {
    if (!open) return
    roomKind.value = 'office'
    roomName.value = ''
  },
)

function confirmRoom() {
  const id = ws.addRoom(roomName.value, roomKind.value, roomColorPick.value)
  if (roomKind.value === 'balcony') {
    const n = ws.addBalconyPeople()
    ws.notify(`${roomLabel(ws.topo, id)} added off the corridor with ${n} people out there, each with a laptop or smartphone`)
  } else ws.notify(`${roomLabel(ws.topo, id)} added at the east end of the building`)
  ws.roomDialog = false
  roomName.value = ''
}

function cancel() {
  ws.pendingAdd = null
  ws.rackDialog = false
  ws.roomDialog = false
}

function onKey(e: KeyboardEvent) {
  if (!p.value && !ws.rackDialog && !ws.roomDialog) return
  if (e.key === 'Escape') cancel()
  else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') confirm()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="p || ws.rackDialog || ws.roomDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="cancel">
    <!-- Scrolls when the content is taller than the screen; the buttons stay visible at the bottom. -->
    <div class="max-h-[calc(100vh-2rem)] w-[min(440px,100%)] overflow-y-auto border border-line bg-panel p-4 text-xs shadow-2xl shadow-black">
      <!-- Adding a room -->
      <template v-if="ws.roomDialog">
        <div class="mb-3 text-sm font-semibold text-neon">Add a room</div>
        <label class="mb-2 flex cursor-pointer items-start gap-2">
          <input v-model="roomKind" type="radio" value="office" class="mt-0.5" />
          <span><b>Office</b><span class="block text-[10px] text-dim">Cubicles for PCs, laptops and APs, a printer corner, room for a wall rack. Added at the east end of the building.</span></span>
        </label>
        <label class="mb-3 flex cursor-pointer items-start gap-2">
          <input v-model="roomKind" type="radio" value="balcony" class="mt-0.5" />
          <span><b>Balcony</b><span class="block text-[10px] text-dim">Outdoor terrace off the corridor, facing the city. People work there on laptops; put an AP out there for Wi-Fi.</span></span>
        </label>
        <input v-model="roomName" class="input" maxlength="40" :placeholder="roomKind === 'balcony' ? 'Balcony' : 'e.g. Marketing'" />
        <p v-if="roomKind === 'balcony'" class="mt-2 text-[10px] text-dim">
          Every lounge chair gets a person with a laptop and every railing spot a person with a smartphone: real devices you can configure ($120 and $80 each).
        </p>
        <div class="mt-2 flex flex-wrap gap-1">
          <button
            v-for="c in SWATCHES"
            :key="c"
            class="h-5 w-5 rounded-sm border"
            :class="c === roomColorPick ? 'border-text' : 'border-transparent'"
            :style="{ background: c }"
            @click="roomColorPick = c"
          />
        </div>
      </template>

      <!-- Adding a rack -->
      <template v-else-if="ws.rackDialog">
        <div class="mb-3 text-sm font-semibold text-neon">Add a rack</div>
        <label class="mb-2 flex cursor-pointer items-start gap-2">
          <input v-model="rackKind" type="radio" value="floor" class="mt-0.5" />
          <span>
            <b>Floor rack (MDF)</b> in the {{ roomLabel(ws.topo, 'server') }}
            <span class="block text-[10px] text-dim">2 m tall: room for routers, switches, firewalls, servers and patch panels.</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-2">
          <input v-model="rackKind" type="radio" value="wall" class="mt-0.5" />
          <span>
            <b>Wall rack (IDF)</b>: a mini rack on an office wall
            <span class="block text-[10px] text-dim">Fits a few devices, typically a switch and a patch panel for that floor.</span>
          </span>
        </label>
        <div v-if="rackKind === 'wall'" class="mt-3 ml-5 flex gap-2">
          <select v-model="wallRoom" class="input">
            <option v-for="o in officesOf(ws.topo)" :key="o.id" :value="o.id">{{ roomLabel(ws.topo, o.id) }}</option>
          </select>
          <input v-model="rackName" class="input" placeholder="name, e.g. IDF-A" maxlength="20" />
        </div>
      </template>

      <!-- Adding a device -->
      <template v-else-if="p">
        <div class="mb-1 text-sm font-semibold text-neon">
          Add {{ DEVICE_CATALOG[p.type].label }}<span v-if="p.type === 'pc' && ws.palette.includes('phone')" class="font-normal text-dim"> + IP phone</span>
        </div>
        <div class="mb-3 text-[10px] text-dim">
          {{ p.type === 'phone' ? 'Which desks get a phone? Tick as many as you like.' : desk ? 'Which room does it go in?' : 'Which rack does it go in?' }}
        </div>

        <template v-if="p.type === 'phone' && freeDesks.length">
          <label class="mb-1 flex cursor-pointer items-center gap-2 font-semibold">
            <input type="checkbox" :checked="allPicked" @change="toggleAll" />
            All desks ({{ freeDesks.length }})
          </label>
          <div class="max-h-48 overflow-y-auto border-y border-line py-1 pl-2">
            <label v-for="h in freeDesks" :key="h.id" class="mb-1 flex cursor-pointer items-center gap-2">
              <input v-model="picked" type="checkbox" :value="h.id" />
              <span class="h-2.5 w-2.5 rounded-sm" :style="{ background: roomColor(ws.topo, roomOf(h, ws.topo)) }" />
              {{ h.name }}'s desk <span class="text-dim">· {{ roomLabel(ws.topo, roomOf(h, ws.topo)) }}</span>
            </label>
          </div>
          <p class="mt-2 text-[10px] text-dim">You cable them yourself: PC → phone's pc port, phone's eth0 → the network.</p>
          <div class="mt-3 mb-1 border-t border-line pt-2 text-[10px] text-dim">or one phone on its own desk in</div>
        </template>
        <template v-if="desk">
          <label v-for="o in deskRooms" :key="o.id" class="mb-1 flex cursor-pointer items-center gap-2">
            <input v-model="choice" type="radio" :value="`room:${o.id}`" @change="picked = []" />
            <span class="h-2.5 w-2.5 rounded-sm" :style="{ background: roomColor(ws.topo, o.id) }" />
            {{ roomLabel(ws.topo, o.id) }}
          </label>
        </template>

        <template v-else>
          <div class="max-h-56 overflow-y-auto">
            <label
              v-for="r in racks"
              :key="r.index"
              class="mb-1 flex items-center gap-2"
              :class="r.fits ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'"
            >
              <input v-model="choice" type="radio" :value="`rack:${r.index}`" :disabled="!r.fits" />
              <span class="h-2.5 w-2.5 rounded-sm" :style="{ background: r.color }" />
              <span class="flex-1">
                {{ r.label }} <span class="text-dim">· {{ r.room }}{{ r.kind === 'wall' ? ' (wall)' : '' }}</span>
              </span>
              <span class="text-[10px] text-dim">{{ r.fits ? `${r.count} device${r.count === 1 ? '' : 's'}` : 'full' }}</span>
            </label>
          </div>
          <label class="mt-2 mb-1 flex cursor-pointer items-center gap-2 border-t border-line pt-2">
            <input v-model="choice" type="radio" value="floor" />
            New floor rack in the {{ roomLabel(ws.topo, 'server') }}
          </label>
          <label class="flex cursor-pointer items-center gap-2">
            <input v-model="choice" type="radio" value="wall" />
            New wall rack in
            <select v-model="wallRoom" class="input w-auto py-0" @focus="choice = 'wall'">
              <option v-for="o in officesOf(ws.topo)" :key="o.id" :value="o.id">{{ roomLabel(ws.topo, o.id) }}</option>
            </select>
          </label>
        </template>
      </template>

      <div class="sticky -bottom-4 -mx-4 mt-4 -mb-4 flex justify-end gap-2 border-t border-line bg-panel px-4 py-3">
        <button class="btn" @click="cancel">Cancel</button>
        <button class="btn btn-primary" @click="confirm">
          {{ ws.roomDialog ? 'Add room' : ws.rackDialog ? 'Add rack' : phoneCount > 1 ? `Add ${phoneCount} phones ($${cost})` : `Add ($${cost})` }}
        </button>
      </div>
    </div>
  </div>
</template>
