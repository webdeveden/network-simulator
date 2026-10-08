export type DeviceType = 'pc' | 'laptop' | 'server' | 'switch' | 'ap' | 'router' | 'firewall'

export interface Iface {
  name: string
  mac: string
  ip?: string
  prefix?: number
  /** Administratively down (IOS `shutdown`). */
  shutdown?: boolean
  description?: string
}

export interface Route {
  network: string
  prefix: number
  via: string
}

export type Proto = 'any' | 'icmp' | 'tcp' | 'udp'

export interface FwRule {
  action: 'allow' | 'deny'
  /** 'any', a host IP, or a CIDR network */
  src: string
  dst: string
  proto: Proto
  port?: number
}

export interface Device {
  id: string
  name: string
  type: DeviceType
  ifaces: Iface[]
  gateway?: string
  routes: Route[]
  fwRules: FwRule[]
  fwDefault: 'allow' | 'deny'
  x: number
  y: number
  /** Prebuilt by a mission: can be configured but not deleted. */
  locked?: boolean
  /** 3D room: preferred rack (0-based) for rack-mounted devices. */
  rack?: number
  /** 3D room: position inside that rack, top first. Set when devices are rearranged by dragging. */
  slot?: number
  /** Cisco-style settings for routers, switches and firewalls. */
  ios?: IosConfig
}

export interface IosSecret {
  value: string
  /** `secret` is hashed in the running-config, `password` is plain text unless service password-encryption is on. */
  kind: 'secret' | 'password'
}

export type VtyLogin = 'local' | 'password' | 'none'
export type VtyTransport = 'all' | 'ssh' | 'telnet' | 'none'

export interface IosConfig {
  enable?: IosSecret
  users?: Record<string, IosSecret>
  domain?: string
  /** RSA modulus size. Present once `crypto key generate rsa` has run: the SSH server needs it. */
  rsaBits?: number
  sshVersion?: 2
  banner?: string
  passwordEncryption?: boolean
  /** Defaults match IOS: `login` with no password, transport input all. */
  vty?: { login?: VtyLogin; password?: string; transport?: VtyTransport }
  /** Saved by `write memory`. */
  startup?: string
  /** Access point wireless settings. */
  wlan?: WlanConfig
}

export interface SsidConfig {
  /** 802.11 open authentication: needed for every SSID, WPA2 runs on top of it. */
  open?: boolean
  /** `authentication key-management wpa version 2` */
  wpa2?: boolean
  psk?: string
  /** `guest-mode`: the SSID is broadcast and shows up in scans. */
  broadcast?: boolean
}

export interface WlanConfig {
  ssids: Record<string, SsidConfig>
  /** SSID bound to Dot11Radio0. */
  radioSsid?: string
  /** `encryption mode ciphers aes-ccm` on the radio: required for WPA2. */
  aes?: boolean
}

export type CableType = 'straight' | 'crossover' | 'fiber' | 'console'
/** What the player picked: a cable type, or let NetSim choose straight vs crossover. */
export type CableChoice = CableType | 'auto'

export interface LinkEnd {
  device: string
  iface: string
}

export interface Link {
  id: string
  a: LinkEnd
  b: LinkEnd
  up: boolean
  /** Physical cable. Missing on links saved before cable types existed: those always work. */
  cable?: CableType
  /** Set on Wi-Fi associations (a = the AP radio, b = the client). Stays active only while the AP still accepts these credentials. */
  wifi?: { ssid: string; key?: string }
}

export interface Topology {
  devices: Device[]
  links: Link[]
}

export type HopAction = 'send' | 'switch' | 'route' | 'deliver' | 'drop'

export interface Hop {
  deviceId: string
  deviceName: string
  action: HopAction
  detail: string
  /** Link traversed to reach this hop (undefined for the first hop). */
  linkId?: string
  /** True when this hop is part of the echo reply leg. */
  reply?: boolean
}

export interface PingResult {
  success: boolean
  hops: Hop[]
  message: string
}
