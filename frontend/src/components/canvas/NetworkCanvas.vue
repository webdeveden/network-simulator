<script setup lang="ts">
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { ConnectionMode, VueFlow, useVueFlow, type Connection, type NodeDragEvent } from '@vue-flow/core'
import { computed } from 'vue'
import type { DeviceType } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'
import CableEdge from './CableEdge.vue'
import DeviceNode from './DeviceNode.vue'

const ws = useWorkspace()
const { screenToFlowCoordinate } = useVueFlow()

const nodes = computed(() =>
  ws.topo.devices.map((d) => ({
    id: d.id,
    type: 'device',
    position: { x: d.x, y: d.y },
    data: { device: d },
  })),
)
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

function onDragStop(e: NodeDragEvent) {
  for (const n of e.nodes) ws.moveDevice(n.id, n.position.x, n.position.y)
}

function onDrop(e: DragEvent) {
  const type = e.dataTransfer?.getData('application/netsim-device') as DeviceType | undefined
  if (!type) return
  const p = screenToFlowCoordinate({ x: e.clientX, y: e.clientY })
  ws.add(type, p.x - 48, p.y - 40)
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
      @node-drag-stop="onDragStop"
      @node-click="({ node }) => (ws.selection = { kind: 'device', id: node.id })"
      @node-double-click="({ node }) => ws.openConsole(node.id)"
      @pane-click="ws.selection = null"
    >
      <template #node-device="p">
        <DeviceNode :id="p.id" :data="p.data" />
      </template>
      <template #edge-cable="p">
        <CableEdge :id="p.id" :source-node="p.sourceNode" :target-node="p.targetNode" :data="p.data" />
      </template>
      <Background pattern-color="#1f2a3a" :gap="22" :size="1.2" />
      <Controls :show-interactive="false" />
    </VueFlow>
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
