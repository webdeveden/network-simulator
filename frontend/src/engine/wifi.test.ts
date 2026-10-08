import { describe, expect, it } from 'vitest'
import { emptySimState, ping } from './forwarding'
import { buildTopology, connect, linkOn, topologyCost } from './network'
import { evaluate, type Objective } from './objectives'
import { newSession, promptOf, runLine, type Session } from './shell'
import type { Topology } from './types'

const dev = (t: Topology, name: string) => t.devices.find((d) => d.name === name)!

function office() {
  const topo = buildTopology(
    {
      devices: [
        { type: 'server', name: 'FILES', x: 0, y: 0, ifaces: { eth0: '192.168.1.10/24' } },
        { type: 'switch', name: 'SW1', x: 0, y: 0 },
        { type: 'ap', name: 'AP1', x: 0, y: 0 },
        { type: 'laptop', name: 'LT1', x: 0, y: 0, ifaces: { wlan0: '192.168.1.21/24' } },
        { type: 'laptop', name: 'LT2', x: 0, y: 0, ifaces: { wlan0: '192.168.1.22/24' } },
      ],
      links: [['SW1', 'FILES'], ['SW1', 'AP1']],
    },
    false,
  )
  const state = emptySimState()
  const on = (s: Session, ...lines: string[]) =>
    lines.flatMap((l) => runLine(topo, state, s, l).lines.map((x) => x.text)).join('\n')
  const session = (name: string) => newSession(dev(topo, name).id)
  return { topo, state, on, session }
}

const SECURE = [
  'enable',
  'conf t',
  'dot11 ssid OFFICE',
  'authentication open',
  'authentication key-management wpa version 2',
  'wpa-psk ascii Sup3rSecret',
  'guest-mode',
  'exit',
  'interface Dot11Radio0',
  'encryption mode ciphers aes-ccm',
  'ssid OFFICE',
  'end',
]

describe('access point and laptops', () => {
  it('laptops cannot be cabled and radios take no cables', () => {
    const { topo } = office()
    expect(connect(topo, dev(topo, 'SW1').id, dev(topo, 'LT1').id)).toMatch(/Wi-Fi/)
    expect(linkOn(topo, dev(topo, 'AP1').id, 'g0/0')).toBeDefined()
    expect(linkOn(topo, dev(topo, 'AP1').id, 'd0')).toBeUndefined()
  })

  it('uses the Aironet config modes', () => {
    const { on, session, topo } = office()
    const ap = session('AP1')
    on(ap, 'enable', 'conf t', 'dot11 ssid OFFICE')
    expect(promptOf(topo, ap).text).toBe('AP1(config-ssid)#')
    expect(on(ap, 'wpa-psk ascii short')).toMatch(/8 to 63/)
    on(ap, 'exit', 'int dot11radio0')
    expect(promptOf(topo, ap).text).toBe('AP1(config-if)#')
    expect(on(ap, 'ssid NOPE')).toMatch(/does not exist/)
    on(ap, 'ssid OFFICE', 'end')
    expect(on(ap, 'sh run')).toMatch(/dot11 ssid OFFICE[\s\S]*interface Dot11Radio0\n ssid OFFICE/)
  })

  it('plays the Office Wi-Fi mission', () => {
    const { topo, state, on, session } = office()
    const objectives: Objective[] = [
      { type: 'ios', label: '', device: 'AP1', check: 'wpa2' },
      { type: 'wifi', label: '', device: 'LT1', ssid: 'OFFICE' },
      { type: 'wifi', label: '', device: 'LT2', ssid: 'OFFICE' },
      { type: 'ping', label: '', from: 'LT1', to: 'FILES', expect: 'success' },
      { type: 'ping', label: '', from: 'LT2', to: 'LT1', expect: 'success' },
    ]
    const lt1 = session('LT1')
    expect(on(lt1, 'wifi scan')).toMatch(/No networks/)

    const ap = session('AP1')
    on(ap, ...SECURE)
    expect(on(lt1, 'wifi scan')).toMatch(/OFFICE\s+\S+\s+WPA2-PSK/)
    expect(on(lt1, 'wifi connect OFFICE')).toMatch(/secured with WPA2/)
    expect(on(lt1, 'wifi connect OFFICE wrongpass')).toMatch(/wrong password/)
    expect(on(lt1, 'wifi connect OFFICE Sup3rSecret')).toMatch(/Connected to "OFFICE" via AP1/)
    const cost = topologyCost(topo)
    on(session('LT2'), 'wifi connect OFFICE Sup3rSecret')
    expect(topologyCost(topo)).toBe(cost) // joining Wi-Fi is free

    expect(ping(topo, state, dev(topo, 'LT1').id, '192.168.1.10').success).toBe(true)
    expect(evaluate(topo, objectives).map((o) => o.done)).toEqual([true, true, true, true, true])
    expect(on(ap, 'show dot11 associations')).toMatch(/LT1[\s\S]*Assoc[\s\S]*LT2/)

    // Changing the Wi-Fi password kicks existing clients off.
    on(ap, 'conf t', 'dot11 ssid OFFICE', 'wpa-psk ascii N3wPassword!', 'end')
    expect(ping(topo, state, dev(topo, 'LT1').id, '192.168.1.10').success).toBe(false)
    expect(on(lt1, 'wifi status')).toMatch(/DISCONNECTED[\s\S]*wrong password/)
    on(lt1, 'wifi connect OFFICE N3wPassword!')
    expect(ping(topo, state, dev(topo, 'LT1').id, '192.168.1.10').success).toBe(true)

    // Shutting the radio drops everyone.
    on(ap, 'conf t', 'int d0', 'shut', 'end')
    expect(ping(topo, state, dev(topo, 'LT1').id, '192.168.1.10').success).toBe(false)
  })

  it('explains a half-configured WPA2 SSID', () => {
    const { on, session } = office()
    on(session('AP1'), ...SECURE.filter((l) => !l.startsWith('encryption')))
    expect(on(session('LT1'), 'wifi connect OFFICE Sup3rSecret')).toMatch(/rejected[\s\S]*encryption mode ciphers aes-ccm/)
  })

  it('PCs have no Wi-Fi', () => {
    const t = buildTopology({ devices: [{ type: 'pc', name: 'PC1', x: 0, y: 0 }] })
    const out = runLine(t, emptySimState(), newSession(t.devices[0].id), 'wifi scan').lines[0].text
    expect(out).toMatch(/no wireless adapter/)
  })
})
