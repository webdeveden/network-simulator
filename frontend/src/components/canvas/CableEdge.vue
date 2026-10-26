<script setup lang="ts">
import type { GraphNode } from '@vue-flow/core'
import { computed } from 'vue'
import { CABLES, linkActive } from '../../engine/network'
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
const isConsole = computed(() => props.data.link.cable === 'console')
/** Colour by cable type; red when the link can't carry traffic (except console cables, which never do). */
const color = computed(() => {
  const l = props.data.link
  if (isSelected.value) return '#39ff88'
  if (l.wifi) return up.value ? '#22d3ee' : '#ff4d5e'
  if (isConsole.value) return CABLES.console.color
  return up.value ? CABLES[l.cable ?? 'straight'].color : '#ff4d5e'
})
const dash = computed(() => {
  const l = props.data.link
  if (l.wifi) return '2 5'
  if (isConsole.value) return '1 4'
  return up.value ? undefined : '6 4'
})
const packet = computed(() => (ws.anim?.linkId === props.id ? ws.anim : null))
</script>

<template>
  <g class="cursor-pointer" @click.stop="ws.selection = { kind: 'link', id }">
    <path :d="path" stroke="transparent" stroke-width="14" fill="none" />
    <path
      :d="path"
      fill="none"
      :stroke="color"
      :stroke-opacity="isSelected ? 1 : 0.7"
      :stroke-width="isSelected ? 2.5 : data.link.cable === 'fiber' ? 2.4 : 1.8"
      :stroke-dasharray="dash"
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
