import { describe, expect, it } from 'vitest'
import { emptySimState } from '../engine/forwarding'
import { buildTopology, DEVICE_CATALOG } from '../engine/network'
import { newSession, runLine } from '../engine/shell'
import type { DeviceType } from '../engine/types'
import { describeSubnet, deviceFacts } from './facts'
import { topicsFor } from './lessons'

const TYPES = Object.keys(DEVICE_CATALOG) as DeviceType[]

/** Output that means the lesson taught a command this device doesn't understand. */
const BROKEN = /Invalid input|command not found|Ambiguous command|Incomplete command|Usage:|Unrecognized command|% NetSim/

describe('lessons', () => {
  it.each(TYPES)('has topics for %s', (type) => {
    const topics = topicsFor(type)
    expect(topics.length).toBeGreaterThanOrEqual(3)
    expect(new Set(topics.map((t) => t.id)).size).toBe(topics.length)
  })

  it.each(TYPES)('every %s example command is accepted by the console', (type) => {
    for (const topic of topicsFor(type))
      for (const ex of topic.examples ?? []) {
        // Each example starts from a fresh device, at the user prompt.
        const t = buildTopology({ devices: [{ type, name: 'DEV', x: 0, y: 0 }] }, false)
        const s = newSession(t.devices[0].id)
        for (const cmd of ex.commands) {
          const out = runLine(t, emptySimState(), s, cmd).lines.map((l) => l.text).join('\n')
          expect(out, `${type} › ${topic.title} › ${cmd}`).not.toMatch(BROKEN)
        }
      }
  })
})

describe('device facts', () => {
  it('explains a host address and a bad gateway', () => {
    const t = buildTopology({ devices: [{ type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '192.168.1.10/24' }, gateway: '10.0.0.1' }] })
    const f = deviceFacts(t, t.devices[0])
    expect(f.find((x) => x.label === 'subnet')?.value).toBe('192.168.1.0/24 · mask 255.255.255.0 · 254 hosts 192.168.1.1 – 192.168.1.254')
    expect(f.find((x) => x.label === 'gateway')).toMatchObject({ tone: 'warn', value: expect.stringMatching(/outside your subnet/) })
  })

  it('describes point-to-point links', () => {
    expect(describeSubnet('10.2.0.1', 30)).toBe('10.2.0.0/30 · mask 255.255.255.252 · 2 hosts 10.2.0.1 – 10.2.0.2')
  })

  it.each(TYPES)('produces facts for a blank %s', (type) => {
    const t = buildTopology({ devices: [{ type, name: 'DEV', x: 0, y: 0 }] })
    expect(deviceFacts(t, t.devices[0]).length).toBeGreaterThan(0)
  })
})
