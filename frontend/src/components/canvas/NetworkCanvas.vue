<script setup lang="ts">
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { ConnectionMode, VueFlow, useVueFlow, type Connection, type NodeDragEvent } from '@vue-flow/core'
import { computed } from 'vue'
import { getDevice } from '../../engine/network'
import type { DeviceType } from '../../engine/types'
import { emptyRacks, groupAt, NODE, rackAt2d, rackGroups, roomGroups } from '../../room/groups'
import { deskRoomsFor, onDesk, roomColor, roomOf } from '../../room/layout'
import { useWorkspace } from '../../stores/workspace'
import CableEdge from './CableEdge.vue'
import DeviceNode from './DeviceNode.vue'
import RackBoxNode from './RackBoxNode.vue'
import RoomNode from './RoomNode.vue'

const ws = useWorkspace()
const { screenToFlowCoordinate } = useVueFlow()

const ROOM_PREFIX = 'room:'
const isDevice = (id: string) => !id.startsWith(ROOM_PREFIX) && !id.startsWith('rack:')

const nodes = computed(() => [
  // Room boxes first and underneath, so devices and cables draw on top.
  ...(ws.showRooms
    ? roomGroups(ws.topo).map((g) => ({
        id: ROOM_PREFIX + g.id,
        type: 'room',
        position: { x: g.x, y: g.y },
        data: { group: g },
        selectable: false,
        connectable: false,
        zIndex: -2,
        style: { pointerEvents: 'none' as const },
        dragHandle: '.room-header',
      }))
    : []),
  // Racks inside the rooms (same racks as the 3D building).
  ...(ws.showRooms
    ? rackGroups(ws.topo).map((r) => ({
        id: `rack:${r.index}`,
        type: 'rack',
        position: { x: r.x, y: r.y },
        data: { rack: r, color: roomColor(ws.topo, r.room) },
        selectable: false,
        connectable: false,
        draggable: false,
        zIndex: -1,
        style: { pointerEvents: 'none' as const },
      }))
    : []),
  ...ws.topo.devices.map((d) => ({
    id: d.id,
    type: 'device',
    position: { x: d.x, y: d.y },
    data: { device: d },
  })),
])
const edges = computed(() =>
  ws.topo.links.map((l) => ({
    id: l.id,
    type: 'cable',
    source: l.a.device,
    target: l.b.device,
    data: { link: l },
  })),
)

function onConnect(c: Connection) {
  ws.link(c.source, c.target)
}

/** Dragging a room box: where it and its devices started. */
let roomDrag: { x: number; y: number; members: { id: string; x: number; y: number }[]; racks: { index: number; x: number; y: number }[] } | null = null

function onDragStart(e: NodeDragEvent) {
  const n = e.node
  if (!n.id.startsWith(ROOM_PREFIX)) return
  const ids: string[] = n.data.group.deviceIds
  roomDrag = {
    x: n.position.x,
    y: n.position.y,
    members: ids.map((id) => ({ id, x: getDevice(ws.topo, id)!.x, y: getDevice(ws.topo, id)!.y })),
    // Empty racks in the room move with it too.
    racks: emptyRacks(ws.topo).filter((r) => r.room === n.data.group.id).map((r) => ({ index: r.index, x: r.x, y: r.y })),
  }
}

function onDrag(e: NodeDragEvent) {
  if (!roomDrag || !e.node.id.startsWith(ROOM_PREFIX)) return
  const dx = e.node.position.x - roomDrag.x
  const dy = e.node.position.y - roomDrag.y
  for (const m of roomDrag.members) ws.moveDevice(m.id, m.x + dx, m.y + dy)
  for (const r of roomDrag.racks) ws.topo.rackPos = { ...ws.topo.rackPos, [r.index]: { x: Math.round(r.x + dx), y: Math.round(r.y + dy) } }
}

function onDragStop(e: NodeDragEvent) {
  if (roomDrag) {
    onDrag(e)
    roomDrag = null
    return
  }
  for (const n of e.nodes) {
    if (!isDevice(n.id)) continue
    ws.moveDevice(n.id, n.position.x, n.position.y)
    // Dropped inside another room's box: move it to that room (desk devices only).
    const d = getDevice(ws.topo, n.id)
    const g = ws.showRooms && d ? groupAt(ws.topo, n.position.x + NODE.w / 2, n.position.y + NODE.h / 2, d.id) : undefined
    if (!d || !g || g.id === roomOf(d, ws.topo)) continue
    if (!onDesk(d)) ws.notify(`${d.name} is rack gear: it stays in its rack`, 'err')
    else if (!deskRoomsFor(ws.topo, d.type).some((r) => r.id === g.id))
      ws.notify(g.kind === 'balcony' ? `Only laptops and APs go out on the ${g.label}` : `The ${g.label} has racks, not desks`, 'err')
    else {
      ws.moveToRoom(d.id, g.id)
      ws.notify(`${d.name} moved to ${g.label}`)
    }
  }
}

function onDrop(e: DragEvent) {
  const type = e.dataTransfer?.getData('application/netsim-device') as DeviceType | undefined
  if (!type) return
  const p = screenToFlowCoordinate({ x: e.clientX, y: e.clientY })
  // Dropped on a rack box: offer that rack first. Inside a room's box: that room.
  const rack = ws.showRooms ? rackAt2d(ws.topo, p.x, p.y) : undefined
  const g = ws.showRooms ? groupAt(ws.topo, p.x, p.y) : undefined
  const preset = rack ? { rack: rack.index } : g && g.kind !== 'racks' ? { room: g.id } : undefined
  ws.requestAdd(type, p.x - 48, p.y - 40, preset)
}
</script>

<template>
  <div class="relative h-full w-full" @drop.prevent="onDrop" @dragover.prevent>
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :connection-mode="ConnectionMode.Loose"
      :connection-radius="40"
      :delete-key-code="null"
      :min-zoom="0.3"
      :max-zoom="2"
      :default-viewport="{ x: 40, y: 40, zoom: 1 }"
      @connect="onConnect"
      @node-drag-start="onDragStart"
      @node-drag="onDrag"
      @node-drag-stop="onDragStop"
      @node-click="({ node }) => isDevice(node.id) && (ws.selection = { kind: 'device', id: node.id })"
      @node-double-click="({ node }) => isDevice(node.id) && ws.openConsole(node.id)"
      @pane-click="ws.selection = null"
    >
      <template #node-room="p">
        <RoomNode :data="p.data" />
      </template>
      <template #node-rack="p">
        <RackBoxNode :data="p.data" />
      </template>
      <template #node-device="p">
        <DeviceNode :id="p.id" :data="p.data" />
      </template>
      <template #edge-cable="p">
        <CableEdge :id="p.id" :source-node="p.sourceNode" :target-node="p.targetNode" :data="p.data" />
      </template>
      <Background pattern-color="#1f2a3a" :gap="22" :size="1.2" />
      <Controls :show-interactive="false" />
    </VueFlow>
    <div v-if="ws.topo.devices.length" class="absolute top-3 left-3 z-10 flex gap-1 text-[11px]">
      <button
        class="border px-2 py-1 tracking-wider uppercase"
        :class="ws.showRooms ? 'border-neon bg-panel text-neon' : 'border-line bg-panel text-dim hover:text-text'"
        title="Show which room of the building each device is in"
        @click="ws.setShowRooms(!ws.showRooms)"
      >
        ▦ Rooms
      </button>
      <button
        v-if="ws.showRooms"
        class="border border-line bg-panel px-2 py-1 tracking-wider text-dim uppercase hover:text-text"
        title="Rearrange the map into one block per room"
        @click="ws.tidyRooms()"
      >
        Tidy by room
      </button>
    </div>
    <div
      v-if="ws.topo.devices.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-dim"
    >
      <div class="text-center">
        <div class="text-neon glow text-lg">// empty network</div>
        <div class="mt-1 text-xs">drag a device from the left panel onto the grid</div>
      </div>
    </div>
  </div>
</template>
