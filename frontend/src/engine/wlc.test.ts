import { describe, expect, it } from 'vitest'
import { emptySimState } from './forwarding'
import { buildTopology, connectPorts, getDevice, linkOn } from './network'
import { newSession, runLine } from './shell'
import { controllerFor, servedWlans } from './wlc'

/** WLC + AP + switch + laptop. The WLC defines WLANs; the AP joins over the wired net. */
function lab() {
  const t = buildTopology(
    {
      devices: [
        { type: 'wlc', name: 'WLC1', x: 0, y: 0 },
        { type: 'ap', name: 'AP1', x: 0, y: 0 },
        { type: 'switch', name: 'SW1', x: 0, y: 0 },
        { type: 'laptop', name: 'LT1', x: 0, y: 0 },
      ],
    },
    false,
  )
  const id = (n: string) => t.devices.find((d) => d.name === n)!.id
  connectPorts(t, id('WLC1'), 'g0/0', id('SW1'), 'fa0/1')
  connectPorts(t, id('AP1'), 'g0/0', id('SW1'), 'fa0/2')
  const wlc = () => getDevice(t, id('WLC1'))!
  const ap = () => getDevice(t, id('AP1'))!
  const lt = (line: string) => {
    const s = newSession(id('LT1'))
    return runLine(t, emptySimState(), s, line).lines.map((x) => x.text).join('\n')
  }
  const defineWlan = (w: object) => ((wlc().wlc ??= { wlans: [] }).wlans.push({ id: 1, profile: 'w1', enabled: true, broadcast: true, security: 'open', ...w } as never))
  return { t, id, wlc, ap, lt, defineWlan }
}

describe('wireless LAN controller', () => {
  it('an AP reachable to the WLC joins it (lightweight) and broadcasts its WLANs', () => {
    const l = lab()
    expect(controllerFor(l.t, l.ap())?.name).toBe('WLC1')
    l.defineWlan({ ssid: 'CORP', security: 'wpa2', psk: 'netsim-corp' })
    const served = servedWlans(l.t, l.ap())
    expect(served.map((w) => w.ssid)).toEqual(['CORP'])
    expect(served[0]).toMatchObject({ wpa2: true, psk: 'netsim-corp', open: true, aes: true })
  })

  it('a laptop scans and joins a WLC WLAN with the right password', () => {
    const l = lab()
    l.defineWlan({ ssid: 'CORP', security: 'wpa2', psk: 'netsim-corp' })
    expect(l.lt('wifi scan')).toMatch(/CORP\s+.*WPA2-PSK/)
    expect(l.lt('wifi connect CORP wrong')).toMatch(/wrong password|Authentication failed/)
    expect(l.lt('wifi connect CORP netsim-corp')).toMatch(/[Cc]onnected|associated|CORP/)
    expect(linkOn(l.t, l.id('LT1'), 'wlan0')).toBeDefined()
  })

  it('a disabled or SSID-less WLAN is not broadcast; an open one needs no password', () => {
    const l = lab()
    l.defineWlan({ id: 1, ssid: 'GUEST', security: 'open' })
    l.defineWlan({ id: 2, ssid: 'HIDDEN', security: 'wpa2', psk: 'secret12', enabled: false })
    expect(servedWlans(l.t, l.ap()).map((w) => w.ssid)).toEqual(['GUEST'])
    expect(l.lt('wifi connect GUEST')).toMatch(/[Cc]onnected|associated|GUEST/)
  })

  it('without a reachable WLC the AP stays autonomous and uses its local dot11 config', () => {
    const l = lab()
    // Unplug the WLC: AP falls back to autonomous (no local SSID yet → serves nothing).
    l.t.links = l.t.links.filter((x) => !(x.a.device === l.id('WLC1') || x.b.device === l.id('WLC1')))
    expect(controllerFor(l.t, l.ap())).toBeNull()
    expect(servedWlans(l.t, l.ap())).toEqual([])
    // Configure it autonomously and it works the old way.
    const s = newSession(l.id('AP1'))
    for (const c of ['enable', 'configure terminal', 'dot11 ssid LOCAL', 'authentication open', 'guest-mode', 'exit', 'interface dot11radio0', 'ssid LOCAL', 'no shutdown', 'end'])
      runLine(l.t, emptySimState(), s, c)
    expect(servedWlans(l.t, l.ap()).map((w) => w.ssid)).toEqual(['LOCAL'])
  })
})
