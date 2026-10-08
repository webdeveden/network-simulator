<script setup lang="ts">
import type { GraphNode } from '@vue-flow/core'
import { computed } from 'vue'
import { linkActive } from '../../engine/network'
import type { Link } from '../../engine/types'
import { useWorkspace } from '../../stores/workspace'

const props = defineProps<{
  id: string
  sourceNode: GraphNode
  targetNode: GraphNode
  data: { link: Link }
}>()
const ws = useWorkspace()

function center(n: GraphNode) {
  return {
    x: n.computedPosition.x + (n.dimensions.width || 96) / 2,
    y: n.computedPosition.y + (n.dimensions.height || 80) / 2,
  }
}

const s = computed(() => center(props.sourceNode))
const t = computed(() => center(props.targetNode))
const path = computed(() => `M ${s.value.x} ${s.value.y} L ${t.value.x} ${t.value.y}`)
// Interface labels sit just outside each device box, wherever the cable leaves it.
const labelF = computed(() => {
  const len = Math.hypot(t.value.x - s.value.x, t.value.y - s.value.y) || 1
  return Math.min(0.45, 64 / len)
})
const at = (f: number) => ({ x: s.value.x + (t.value.x - s.value.x) * f, y: s.value.y + (t.value.y - s.value.y) * f })

const up = computed(() => linkActive(ws.topo, props.data.link))
const isSelected = computed(() => ws.selection?.kind === 'link' && ws.selection.id === props.id)
const packet = computed(() => (ws.anim?.linkId === props.id ? ws.anim : null))
</script>

<template>
  <g class="cursor-pointer" @click.stop="ws.selection = { kind: 'link', id }">
    <path :d="path" stroke="transparent" stroke-width="14" fill="none" />
    <path
      :d="path"
      fill="none"
      :stroke="isSelected ? '#39ff88' : up ? '#22d3ee' : '#ff4d5e'"
      :stroke-opacity="isSelected ? 1 : 0.55"
      :stroke-width="isSelected ? 2.5 : 1.8"
      :stroke-dasharray="data.link.wifi ? '2 5' : up ? undefined : '6 4'"
    />
    <text :x="at(labelF).x" :y="at(labelF).y - 4" class="fill-dim text-[9px]" text-anchor="middle">
      {{ data.link.a.iface }}
    </text>
    <text :x="at(1 - labelF).x" :y="at(1 - labelF).y - 4" class="fill-dim text-[9px]" text-anchor="middle">
      {{ data.link.b.iface }}
    </text>
    <circle v-if="packet" :key="packet.key" r="5" :fill="packet.color" :style="{ filter: `drop-shadow(0 0 6px ${packet.color})` }">
      <animateMotion
        :path="path"
        dur="0.36s"
        fill="freeze"
        calcMode="linear"
        :keyPoints="packet.forward ? '0;1' : '1;0'"
        keyTimes="0;1"
      />
    </circle>
  </g>
</template>
