<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { RoomGroup } from '../../room/groups'
import { useWorkspace } from '../../stores/workspace'

const props = defineProps<{ data: { group: RoomGroup } }>()
const ws = useWorkspace()
const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement>()
const header = ref<HTMLDivElement>()
/** Screen position for the editor: it lives on top of the page, not under the devices. */
const at = ref({ x: 0, y: 0 })

const SWATCHES = ['#22d3ee', '#39ff88', '#ffc94d', '#ff6bd6', '#a5b4fc', '#ff8a4d', '#ff4d5e', '#c9d6e8']

function edit() {
  draft.value = props.data.group.label
  const r = header.value!.getBoundingClientRect()
  at.value = { x: Math.min(r.left, window.innerWidth - 270), y: r.bottom + 4 }
  editing.value = true
  nextTick(() => input.value?.select())
}

function save() {
  if (!editing.value) return
  editing.value = false
  ws.editRoom(props.data.group.id, { label: draft.value })
}

/** Colour applies right away (2D box and 3D door sign), no need to press Enter. */
function pick(color: string) {
  ws.editRoom(props.data.group.id, { color })
}
</script>

<template>
  <!-- Only the header takes the mouse: clicks inside the box still reach the canvas and the devices. -->
  <div
    class="pointer-events-none rounded-md border border-dashed"
    :style="{
      width: data.group.w + 'px',
      height: data.group.h + 'px',
      borderColor: data.group.color + '99',
      background: data.group.color + '0d',
    }"
  >
    <div
      ref="header"
      class="room-header pointer-events-auto relative flex h-[26px] cursor-move items-center gap-2 rounded-t-md px-2 text-[11px] font-semibold tracking-wider uppercase"
      :style="{ color: data.group.color, background: data.group.color + '1f' }"
      title="Drag to move the room · double-click the name to rename it"
    >
      <span>{{ data.group.kind === 'racks' ? '▤' : '▦' }}</span>
      <span class="truncate" @dblclick.stop="edit">{{ data.group.label }}</span>
      <span class="ml-auto font-normal text-dim normal-case">{{ data.group.deviceIds.length }}</span>
      <button class="nodrag font-normal text-dim normal-case hover:text-text" title="Rename / recolour" @click.stop="editing ? save() : edit()">✎</button>

      <!-- Editor: name and colour. Both show up in the 3D building too. Teleported so devices can't cover it. -->
      <Teleport to="body">
      <div
        v-if="editing"
        class="fixed z-[60] w-64 border border-line bg-panel p-2 text-xs font-normal tracking-normal text-text normal-case shadow-xl shadow-black"
        :style="{ left: at.x + 'px', top: at.y + 'px' }"
      >
        <input
          ref="input"
          v-model="draft"
          class="input w-full"
          maxlength="40"
          placeholder="room name"
          @keydown.enter="save"
          @keydown.esc="editing = false"
        />
        <div class="mt-2 flex flex-wrap items-center gap-1">
          <button
            v-for="c in SWATCHES"
            :key="c"
            class="h-5 w-5 rounded-sm border"
            :class="c === data.group.color ? 'border-text' : 'border-transparent'"
            :style="{ background: c }"
            :title="c"
            @click="pick(c)"
          />
          <input type="color" class="h-5 w-7 cursor-pointer border-0 bg-transparent p-0" :value="data.group.color" title="Custom colour" @input="pick(($event.target as HTMLInputElement).value)" />
        </div>
        <div class="mt-2 flex justify-end gap-1">
          <button class="btn" @click="editing = false">Close</button>
          <button class="btn btn-primary" @click="save">Save name</button>
        </div>
      </div>
      </Teleport>
    </div>
  </div>
</template>
