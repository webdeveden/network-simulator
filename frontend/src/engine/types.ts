export type DeviceType = 'pc' | 'laptop' | 'server' | 'switch' | 'ap' | 'router' | 'firewall' | 'patch' | 'isp' | 'modem' | 'printer' | 'phone' | 'mobile'

export interface Iface {
  name: string
  mac: string
  ip?: string
  prefix?: number
  /** Administratively down (IOS `shutdown`). */
  shutdown?: boolean
  description?: string
  /** Address learned from a DHCP server (`ip address dhcp` on IOS, `dhcp` on a PC). */
  dhcp?: boolean
  /** Default router handed out with a DHCP lease (IOS installs it as a default route). */
  dhcpGateway?: string
  /** Subinterface (`g0/0.10`) or SVI (`vlan10`): the 802.1Q VLAN it lives in. */
  vlan?: number
  /** Subinterface: `encapsulation dot1Q N native` (sent untagged). */
  nativeVlan?: boolean
  /** Switch port settings. Missing = access port in VLAN 1. */
  switchport?: Switchport
  /** Shut down by the switch itself (port security, BPDU guard) until `shutdown` / `no shutdown`. */
  errDisabled?: 'psecure-violation' | 'bpduguard'
  /** Per-port spanning-tree settings on a switch. */
  stp?: { portfast?: boolean; bpduguard?: boolean; cost?: number }
  /** `ip helper-address`: relay DHCP broadcasts to this server. */
  helper?: string
  /** `ip nat inside` / `ip nat outside`. */
  nat?: 'inside' | 'outside'
  /** `ip ospf cost N`. */
  ospfCost?: number
  /** `ip access-group <acl> in|out`. */
  aclIn?: string
  aclOut?: string
  /** `ip dhcp snooping trust`: DHCP server replies are allowed in on this port (the uplink). */
  snoopTrust?: boolean
  /** `ip arp inspection trust`: ARP is not checked on this port (the uplink or a router). */
  daiTrust?: boolean
}

/** `switchport port-security …` on an access port. */
export interface PortSecurity {
  /** Most MACs allowed on the port (default 1). */
  max?: number
  /** What happens to a frame from one MAC too many (default shutdown = err-disabled). */
  violation?: 'shutdown' | 'restrict' | 'protect'
  /** `mac-address sticky`: learned MACs are written into the running-config. */
  sticky?: boolean
  /** Secure MACs in the config: typed by hand, or learned while sticky. */
  macs: { mac: string; sticky?: boolean }[]
}

export interface Switchport {
  mode: 'access' | 'trunk'
  portSecurity?: PortSecurity
  /** Access VLAN (default 1). */
  vlan?: number
  /** Trunk: VLANs allowed (missing = all). */
  allowed?: number[]
  /** Trunk: native (untagged) VLAN, default 1. */
  native?: number
}

export interface Route {
  network: string
  prefix: number
  /** Next-hop address; '' for a route through an exit interface only. */
  via: string
  /** Exit interface (`ip route … g0/1`). Without a next hop, the router ARPs for each destination. */
  iface?: string
  /** Administrative distance (default 1). Higher = floating static route, a backup. */
  ad?: number
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
  /** Free-text notes kept on this PC (the admin PC's Notes tab). */
  notes?: string
  /** 2D map size of the ISP cloud (it can be enlarged). */
  w?: number
  h?: number
  /** 3D building: room a desk device is in (see room/layout roomsOf). Rack gear lives in its rack's room. */
  room?: string
  /** IP phone: the PC or laptop whose desk it sits on. */
  deskOf?: string
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
  vty?: { login?: VtyLogin; password?: string; transport?: VtyTransport; /** `access-class N in`: who may SSH in. */ accessClass?: string }
  /** Saved by `write memory`. */
  startup?: string
  /** Access point wireless settings. */
  wlan?: WlanConfig
  /** Switch VLAN database: id -> name. VLAN 1 always exists. */
  vlans?: Record<number, string>
  /** Spanning tree: mode (both converge instantly in NetSim) and bridge priority per VLAN. */
  stp?: { mode?: 'pvst' | 'rapid-pvst'; priority?: Record<number, number> }
  ospf?: OspfConfig
  eigrp?: EigrpConfig
  rip?: RipConfig
  bgp?: BgpConfig
  dhcp?: DhcpServer
  /** Access lists by number ("1", "110") or name ("BLOCK-SSH"). */
  acls?: Record<string, AclEntry[]>
  /** Named lists: standard or extended (numbered ones go by their number range). */
  aclTypes?: Record<string, 'standard' | 'extended'>
  nat?: NatConfig
  /** `ip dhcp snooping`: on, and the VLANs it watches. Drops rogue DHCP offers on untrusted ports. */
  dhcpSnoop?: { vlans: number[] }
  /** `ip arp inspection vlan …`: the VLANs where ARP is checked against the snooping table. */
  arpInspect?: { vlans: number[] }
}

export interface NetworkStatement {
  network: string
  /** Wildcard mask, e.g. 0.0.0.255. Missing = classful (RIP, EIGRP without a wildcard). */
  wildcard?: string
  /** OSPF area. */
  area?: number
}

export interface OspfConfig {
  pid: number
  routerId?: string
  networks: NetworkStatement[]
  passive?: string[]
  /** `default-information originate`: advertise this router's default route. */
  defaultOriginate?: boolean
}

export interface EigrpConfig {
  as: number
  routerId?: string
  networks: NetworkStatement[]
  passive?: string[]
}

export interface RipConfig {
  version?: 1 | 2
  networks: string[]
  passive?: string[]
  noAutoSummary?: boolean
  defaultOriginate?: boolean
}

export interface BgpNeighbor {
  ip: string
  remoteAs: number
}

export interface BgpConfig {
  as: number
  routerId?: string
  neighbors: BgpNeighbor[]
  networks: { network: string; prefix: number }[]
}

export interface DhcpPool {
  network?: string
  prefix?: number
  router?: string
  dns?: string
  domain?: string
}

export interface DhcpLease {
  ip: string
  mac: string
  /** Client device name. */
  host: string
  pool: string
}

export interface DhcpServer {
  pools: Record<string, DhcpPool>
  excluded: { from: string; to: string }[]
  leases: DhcpLease[]
}

export type AclProto = 'ip' | 'icmp' | 'tcp' | 'udp'

/** One access-list line. Standard lines use only action/src/wildcard; extended lines add the rest. */
export interface AclEntry {
  action: 'permit' | 'deny'
  /** 'any' or an address (a host without a wildcard). */
  src: string
  wildcard?: string
  /** Extended: protocol (ip = any). */
  proto?: AclProto
  dst?: string
  dstWildcard?: string
  /** Extended: `eq` destination port. */
  port?: number
  /** Extended: `eq` source port. */
  srcPort?: number
  /** Extended TCP: only replies in an existing session. */
  established?: boolean
  /** A `remark` line: a comment, never matches. */
  remark?: string
  /** Sequence number when entered with one (named lists); else 10, 20, 30… */
  seq?: number
}

export interface NatConfig {
  /** `ip nat inside source list N interface X overload` */
  overload?: { acl: number | string; iface: string }
  /** `ip nat inside source static <local> <global>` */
  statics: { local: string; global: string }[]
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

export interface IpLogEntry {
  /** Unix time in ms. */
  t: number
  device: string
  iface: string
  /** CIDR, or null when the address was removed. */
  ip: string | null
  was: string | null
}

export interface WallRack {
  id: number
  room: string
  name: string
}

export interface Topology {
  devices: Device[]
  links: Link[]
  /** Custom room names and colours, by room id (see room/layout roomsOf). Shared by the 2D map and the 3D building. */
  rooms?: Record<string, { label?: string; color?: string }>
  /** IP addresses assigned, changed or removed on network devices, newest last (the admin PC's Notes tab). */
  ipLog?: IpLogEntry[]
  /** Built-in rooms the player deleted. */
  removedRooms?: string[]
  /** Rooms the player added: more offices east of the building, or balconies off the corridor. */
  customRooms?: { id: string; label: string; kind: 'office' | 'balcony' }[]
  /** 2D map spot of each rack (by rack index), so empty racks show up too. */
  rackPos?: Record<number, { x: number; y: number }>
  /** Floor racks (MDF) in the server room: at least this many, even if empty. */
  serverRacks?: number
  /** Wall-mounted mini racks (IDF) in offices. Ids start at WALL_RACK_BASE so they never clash with floor racks. */
  wallRacks?: WallRack[]
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
  /** Source address the destination saw (after NAT). */
  srcIp?: string
}
