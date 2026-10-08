<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Line, LineKind } from '../../engine/commands'
import { useWorkspace } from '../../stores/workspace'

/** Pinned to one device (console windows). Without it, follows the selected device. */
const props = defineProps<{ deviceId?: string }>()
const ws = useWorkspace()
const el = ref<HTMLDivElement>()
const id = () => props.deviceId

const ANSI: Record<LineKind, string> = {
  out: '\x1b[0m',
  ok: '\x1b[38;2;57;255;136m',
  err: '\x1b[38;2;255;77;94m',
  info: '\x1b[38;2;34;211;238m',
  muted: '\x1b[38;2;107;122;144m',
}

let term: Terminal
let fit: FitAddon
let observer: ResizeObserver
let buffer = ''
const history: string[] = []
let histIdx = 0

const prompt = () => {
  const p = ws.prompt(id())
  if (p.secret || p.text === '(no device)>') return `\x1b[38;2;107;122;144m${p.text}\x1b[0m `
  return `\x1b[38;2;57;255;136m${p.text}\x1b[0m `
}

/** Password prompts do not echo what is typed. */
const shown = (text: string) => (ws.prompt(id()).secret ? '' : text)

function writeLines(lines: Line[]) {
  for (const l of lines) term.writeln(ANSI[l.kind] + l.text + '\x1b[0m')
}

function redrawInput() {
  term.write('\r\x1b[2K' + prompt() + shown(buffer))
}

function submit() {
  term.write('\r\n')
  const line = buffer
  const secret = ws.prompt(id()).secret
  const promptLen = ws.prompt(id()).text.length + 1
  buffer = ''
  if (line.trim() && !secret) {
    history.push(line)
    histIdx = history.length
  }
  if (line.trim() || secret || ws.termIsIos(id())) {
    const r = ws.run(line, promptLen, id())
    if (r.clear) term.clear()
    writeLines(r.lines)
    buffer = r.refill ?? ''
  }
  term.write(prompt() + shown(buffer))
}

/** IOS answers `?` immediately, without Enter, then puts the line back. */
function contextHelp() {
  term.write('?\r\n')
  const r = ws.run(buffer + '?', 0, id())
  writeLines(r.lines)
  buffer = r.refill ?? buffer
  term.write(prompt() + buffer)
}

function onData(data: string) {
  for (const ch of data) {
    const code = ch.charCodeAt(0)
    if (ch === '\r') submit()
    else if (code === 127) {
      if (buffer.length) {
        buffer = buffer.slice(0, -1)
        if (!ws.prompt(id()).secret) term.write('\b \b')
      }
    } else if (code === 3) {
      buffer = ''
      term.write('^C\r\n' + prompt())
    } else if (code === 12) {
      term.clear()
      redrawInput()
    } else if (code === 26) {
      const r = ws.termCtrlZ(id())
      if (!r) continue
      buffer = ''
      term.write('^Z\r\n')
      writeLines(r.lines)
      term.write(prompt())
    } else if (code === 9) {
      const next = ws.termComplete(buffer, id())
      if (next !== buffer) {
        buffer = next
        redrawInput()
      }
    } else if (ch === '?' && ws.termIsIos(id())) {
      contextHelp()
    } else if (code >= 32) {
      buffer += ch
      term.write(shown(ch))
    }
  }
}

onMounted(() => {
  term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: '#0a0e14', foreground: '#c9d6e8', cursor: '#39ff88', selectionBackground: '#39ff8855' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value!)
  fit.fit()
  writeLines([
    { text: 'NetSim terminal. PCs/servers: type "help". Routers, switches, firewalls: Cisco-style IOS, type "?".', kind: 'info' },
    { text: 'Tab completes IOS keywords, ↑/↓ history, Ctrl+Z leaves config mode, Ctrl+L clears.', kind: 'muted' },
  ])
  term.write(prompt())
  term.onData(onData)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return true
    if (!history.length) return false
    histIdx = Math.max(0, Math.min(history.length, histIdx + (e.key === 'ArrowUp' ? -1 : 1)))
    buffer = history[histIdx] ?? ''
    redrawInput()
    return false
  })
  observer = new ResizeObserver(() => fit.fit())
  observer.observe(el.value!)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  term?.dispose()
})

watch(
  () => ws.selectedDevice?.id,
  (sel, old) => {
    if (!term || props.deviceId || sel === old) return
    if (sel) term.write(`\r\x1b[2K\x1b[38;2;107;122;144m--- session: ${ws.selectedDevice!.name} (${ws.selectedDevice!.type}) ---\x1b[0m\r\n`)
    buffer = ''
    redrawInput()
  },
)

watch(
  () => ws.termFeed.seq,
  () => {
    const target = ws.termFeed.deviceId
    if (props.deviceId && target !== props.deviceId) return
    if (!props.deviceId && target && target !== ws.selectedDevice?.id) return
    term.write('\r\x1b[2K')
    writeLines(ws.termFeed.lines)
    redrawInput()
  },
)

/** Puts text on the input line without running it (Learn tab examples). */
function setInput(text: string) {
  buffer = text
  redrawInput()
  term.focus()
}

defineExpose({ focus: () => term?.focus(), setInput })
</script>

<template>
  <div ref="el" class="h-full w-full px-2 pt-1" @click="term?.focus()" />
</template>
