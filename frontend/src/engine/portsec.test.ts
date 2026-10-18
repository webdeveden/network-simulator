import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from './forwarding'
import { buildTopology, connectPorts, disconnect, linkOn } from './network'
import { newSession, runLine } from './shell'

/** PC1 and a router on SW1; PC2 waits to be plugged into PC1's port. */
function lab() {
  const t = buildTopology(
    {
      devices: [
        { type: 'pc', name: 'PC1', x: 0, y: 0, ifaces: { eth0: '10.0.0.11/24' }, gateway: '10.0.0.1' },
        { type: 'pc', name: 'PC2', x: 0, y: 0, ifaces: { eth0: '10.0.0.12/24' }, gateway: '10.0.0.1' },
        { type: 'switch', name: 'SW1', x: 0, y: 0 },
        { type: 'router', name: 'R1', x: 0, y: 0, ifaces: { 'g0/0': '10.0.0.1/24' } },
      ],
    },
    false,
  )
  const id = (n: string) => t.devices.find((d) => d.name === n)!.id
  connectPorts(t, id('PC1'), 'eth0', id('SW1'), 'fa0/1')
  connectPorts(t, id('R1'), 'g0/0', id('SW1'), 'fa0/24')
  const state = emptySimState()
  const on = (name: string, ...lines: string[]) => {
    const s = newSession(id(name))
    return lines.flatMap((l) => runLine(t, state, s, l).lines.map((x) => x.text)).join('\n')
  }
  const cfg = (name: string, ...lines: string[]) => on(name, 'enable', 'configure terminal', ...lines, 'end')
  /** Unplug PC1 and plug PC2 into the same switch port (someone swaps the PC). */
  const swap = () => {
    disconnect(t, linkOn(t, id('PC1'), 'eth0')!.id)
    connectPorts(t, id('PC2'), 'eth0', id('SW1'), 'fa0/1')
  }
  const port = () => t.devices.find((d) => d.name === 'SW1')!.ifaces.find((i) => i.name === 'fa0/1')!
  return { t, state, id, on, cfg, swap, port }
}

describe('port security', () => {
  it('needs an explicit access port, like IOS', () => {
    const l = lab()
    expect(l.cfg('SW1', 'interface fa0/1', 'switchport port-security')).toMatch(/Command rejected: FastEthernet0\/1 is a dynamic port[\s\S]*switchport mode access/)
  })

  it('learns the first MAC, then err-disables the port when another device plugs in', () => {
    const l = lab()
    l.cfg('SW1', 'interface fa0/1', 'switchport mode access', 'switchport port-security')
    expect(ping(l.t, l.state, l.id('PC1'), '10.0.0.1').success).toBe(true)
    l.swap()
    const r = ping(l.t, l.state, l.id('PC2'), '10.0.0.1')
    expect(r.success).toBe(false)
    expect(r.message).toMatch(/SW1 fa0\/1 went err-disabled: port security saw MAC/)
    expect(l.port().errDisabled).toBe('psecure-violation')
    expect(l.on('SW1', 'show interfaces fa0/1')).toMatch(/FastEthernet0\/1 is down, line protocol is down \(err-disabled\)/)
    expect(l.on('SW1', 'show port-security interface fa0/1')).toMatch(/Secure-shutdown[\s\S]*Security Violation Count\s+: 1/)
    // Recover: shutdown / no shutdown. The learned MAC is forgotten, so PC2 is now the allowed one.
    l.cfg('SW1', 'interface fa0/1', 'shutdown', 'no shutdown')
    expect(l.port().errDisabled).toBeUndefined()
    expect(ping(l.t, l.state, l.id('PC2'), '10.0.0.1').success).toBe(true)
  })

  it('restrict drops and counts but keeps the port up; maximum 2 allows two devices', () => {
    const l = lab()
    l.cfg('SW1', 'interface fa0/1', 'switchport mode access', 'switchport port-security', 'switchport port-security violation restrict')
    ping(l.t, l.state, l.id('PC1'), '10.0.0.1')
    l.swap()
    expect(ping(l.t, l.state, l.id('PC2'), '10.0.0.1').message).toMatch(/dropped a frame from MAC .* \(restrict\)/)
    expect(l.port().errDisabled).toBeUndefined()
    l.cfg('SW1', 'interface fa0/1', 'switchport port-security maximum 2')
    expect(ping(l.t, l.state, l.id('PC2'), '10.0.0.1').success).toBe(true)
  })

  it('sticky MACs go into the running-config; a static MAC can be set by hand', () => {
    const l = lab()
    l.cfg('SW1', 'interface fa0/1', 'switchport mode access', 'switchport port-security', 'switchport port-security mac-address sticky')
    ping(l.t, l.state, l.id('PC1'), '10.0.0.1')
    const config = l.on('SW1', 'enable', 'show running-config')
    expect(config).toMatch(/interface FastEthernet0\/1\n switchport mode access\n switchport port-security\n switchport port-security mac-address sticky\n switchport port-security mac-address sticky [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/)
    expect(l.on('SW1', 'show port-security address')).toMatch(/SecureSticky\s+Fa0\/1/)
    expect(l.cfg('SW1', 'interface fa0/2', 'switchport mode access', 'switchport port-security mac-address 0011.2233.4455')).not.toMatch(/Invalid|rejected/)
    expect(l.on('SW1', 'show port-security')).toMatch(/Fa0\/1\s+1\s+1\s+0\s+shutdown/)
  })
})