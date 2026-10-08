import { describe, expect, it } from 'vitest'
import { execute } from './commands'
import { emptySimState, ping, sendPacket } from './forwarding'
import { inSubnet, isValidIp, networkOf, parseCidr } from './ip'
import { addDevice, buildTopology, connect, emptyTopology, setIfaceIp } from './network'
import { evaluate } from './objectives'
import type { Topology } from './types'

const state = () => emptySimState()
const dev = (t: Topology, name: string) => t.devices.find((d) => d.name === name)!

describe('ip', () => {
  it('parses and compares subnets', () => {
    expect(isValidIp('10.0.0.256')).toBe(false)
    expect(parseCidr('192.168.1.10/24')).toEqual({ ip: '192.168.1.10', prefix: 24 })
    expect(networkOf('172.16.0.70', 26)).toBe('172.16.0.64')
    expect(inSubnet('10.0.1.5', '10.0.0.0', 16)).toBe(true)
    expect(inSubnet('10.1.1.5', '10.0.0.0', 16)).toBe(false)
  })
})

describe('forwarding', () => {
  it('pings across a direct cable', () => {
    const t = buildTopology({
      devices: [
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '192.168.0.1/24' } },
        { type: 'pc', name: 'B', x: 0, y: 0, ifaces: { eth0: '192.168.0.2/24' } },
      ],
      links: [['A', 'B']],
    })
    const r = ping(t, state(), dev(t, 'A').id, '192.168.0.2')
    expect(r.success).toBe(true)
    expect(r.hops.some((h) => h.reply)).toBe(true)
  })

  it('fails when not cabled', () => {
    const t = buildTopology({
      devices: [
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '192.168.0.1/24' } },
        { type: 'pc', name: 'B', x: 0, y: 0, ifaces: { eth0: '192.168.0.2/24' } },
      ],
    })
    const r = ping(t, state(), dev(t, 'A').id, '192.168.0.2')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/not cabled/)
  })

  it('switches frames inside a LAN and learns MACs', () => {
    const t = buildTopology({
      devices: [
        { type: 'switch', name: 'SW', x: 0, y: 0 },
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '10.0.0.1/24' } },
        { type: 'pc', name: 'B', x: 0, y: 0, ifaces: { eth0: '10.0.0.2/24' } },
        { type: 'pc', name: 'C', x: 0, y: 0, ifaces: { eth0: '10.0.0.3/24' } },
      ],
      links: [['SW', 'A'], ['SW', 'B'], ['SW', 'C']],
    })
    const s = state()
    const r = ping(t, s, dev(t, 'A').id, '10.0.0.3')
    expect(r.success).toBe(true)
    expect(r.hops.filter((h) => h.action === 'switch')).toHaveLength(2)
    expect(Object.keys(s.mac[dev(t, 'SW').id])).toHaveLength(2)
    expect(s.arp[dev(t, 'A').id]['10.0.0.3']).toBe(dev(t, 'C').ifaces[0].mac)
  })

  const routed = (): Topology =>
    buildTopology({
      devices: [
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.1.1/24', 'g0/1': '10.0.2.1/24' } },
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '10.0.1.10/24' }, gateway: '10.0.1.1' },
        { type: 'pc', name: 'B', x: 0, y: 0, ifaces: { eth0: '10.0.2.10/24' }, gateway: '10.0.2.1' },
      ],
      links: [['R1', 'A'], ['R1', 'B']],
    })

  it('routes between two subnets', () => {
    const t = routed()
    expect(ping(t, state(), dev(t, 'A').id, '10.0.2.10').success).toBe(true)
  })

  it('explains a missing gateway', () => {
    const t = routed()
    delete dev(t, 'A').gateway
    const r = ping(t, state(), dev(t, 'A').id, '10.0.2.10')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/no default gateway/)
  })

  it('loses the reply when the far side has no gateway', () => {
    const t = routed()
    delete dev(t, 'B').gateway
    const r = ping(t, state(), dev(t, 'A').id, '10.0.2.10')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/reply .* lost/)
  })

  it('needs static routes across two routers', () => {
    const t = buildTopology({
      devices: [
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.1.0.1/24', 'g0/1': '10.2.0.1/30' } },
        { type: 'router', name: 'R2', x: 0, y: 0, ifaces: { 'g0/0': '10.3.0.1/24', 'g0/1': '10.2.0.2/30' } },
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '10.1.0.10/24' }, gateway: '10.1.0.1' },
        { type: 'pc', name: 'B', x: 0, y: 0, ifaces: { eth0: '10.3.0.10/24' }, gateway: '10.3.0.1' },
      ],
      links: [['R1', 'A'], ['R2', 'B'], ['R1', 'R2']],
    })
    // Links are assigned to the first free port, so the R1-R2 cable lands on g0/1.
    const a = dev(t, 'A').id
    expect(ping(t, state(), a, '10.3.0.10').message).toMatch(/No route to 10.3.0.10 on R1/)
    execute(t, state(), dev(t, 'R1').id, 'route add 10.3.0.0/24 via 10.2.0.2')
    expect(ping(t, state(), a, '10.3.0.10').message).toMatch(/No route to 10.1.0.10 on R2/)
    execute(t, state(), dev(t, 'R2').id, 'route add default via 10.2.0.1')
    expect(ping(t, state(), a, '10.3.0.10').success).toBe(true)
  })

  it('detects routing loops via TTL', () => {
    const t = buildTopology({
      devices: [
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.1.0.1/24', 'g0/1': '10.2.0.1/30' } },
        { type: 'router', name: 'R2', x: 0, y: 0, ifaces: { 'g0/0': '10.2.0.2/30' } },
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '10.1.0.10/24' }, gateway: '10.1.0.1' },
      ],
      links: [['R1', 'A'], ['R1', 'R2']],
    })
    dev(t, 'R1').routes.push({ network: '0.0.0.0', prefix: 0, via: '10.2.0.2' })
    dev(t, 'R2').routes.push({ network: '0.0.0.0', prefix: 0, via: '10.2.0.1' })
    const r = ping(t, state(), dev(t, 'A').id, '8.8.8.8')
    expect(r.message).toMatch(/TTL expired/)
  })

  it('filters with a stateful firewall', () => {
    const t = buildTopology({
      devices: [
        { type: 'firewall', name: 'FW1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.1.1/24', 'g0/1': '10.0.2.1/24', 'g0/2': '10.0.3.1/24' } },
        { type: 'pc', name: 'STAFF', x: 0, y: 0, ifaces: { eth0: '10.0.1.10/24' }, gateway: '10.0.1.1' },
        { type: 'pc', name: 'GUEST', x: 0, y: 0, ifaces: { eth0: '10.0.2.10/24' }, gateway: '10.0.2.1' },
        { type: 'server', name: 'SRV', x: 0, y: 0, ifaces: { eth0: '10.0.3.10/24' }, gateway: '10.0.3.1' },
      ],
      links: [['FW1', 'STAFF'], ['FW1', 'GUEST'], ['FW1', 'SRV']],
    })
    const fw = dev(t, 'FW1').id
    expect(execute(t, state(), fw, 'fw rule add deny 10.0.2.0/24 10.0.3.10').mutated).toBe(true)
    expect(ping(t, state(), dev(t, 'GUEST').id, '10.0.3.10').message).toMatch(/Blocked by FW1 rule #1/)
    expect(ping(t, state(), dev(t, 'STAFF').id, '10.0.3.10').success).toBe(true)
    // Server can still answer staff even with default deny, thanks to stateful replies.
    execute(t, state(), fw, 'fw rule add allow 10.0.1.0/24 any')
    execute(t, state(), fw, 'fw default deny')
    expect(ping(t, state(), dev(t, 'STAFF').id, '10.0.3.10').success).toBe(true)
    expect(sendPacket(t, state(), dev(t, 'SRV').id, '10.0.1.10').success).toBe(false)
  })
})

describe('network editing', () => {
  it('connects on free ports and refuses duplicates', () => {
    const t = emptyTopology()
    const a = addDevice(t, 'pc')
    const b = addDevice(t, 'pc')
    expect(a.name).toBe('PC1')
    expect(b.name).toBe('PC2')
    expect(typeof connect(t, a.id, b.id)).toBe('object')
    expect(connect(t, a.id, b.id)).toMatch(/already connected/)
    const c = addDevice(t, 'pc')
    expect(connect(t, a.id, c.id)).toMatch(/no free copper ports/)
    expect(setIfaceIp(a, 'eth0', '10.0.0.1')).toMatch(/CIDR/)
  })
})

describe('objectives', () => {
  it('evaluates subnet objectives', () => {
    const t = buildTopology({
      devices: [
        { type: 'pc', name: 'A', x: 0, y: 0, ifaces: { eth0: '172.16.0.10/26' } },
        { type: 'pc', name: 'B', x: 0, y: 0, ifaces: { eth0: '172.16.0.70/26' } },
        { type: 'pc', name: 'C', x: 0, y: 0, ifaces: { eth0: '172.16.0.20/24' } },
      ],
    })
    const [inNet, distinct, overlap] = evaluate(t, [
      { type: 'inSubnet', label: '', devices: ['A', 'B'], subnet: '172.16.0.0/24', minPrefix: 26 },
      { type: 'distinctSubnets', label: '', devices: ['A', 'B'] },
      { type: 'distinctSubnets', label: '', devices: ['A', 'C'] },
    ])
    expect(inNet.done).toBe(true)
    expect(distinct.done).toBe(true)
    expect(overlap.done).toBe(false)
  })
})
