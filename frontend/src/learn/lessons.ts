/**
 * Lessons shown in the Learn tab of a console window, per device type.
 * Text may use `backticks` for inline code. Example commands are typed into the
 * console when clicked; every one of them is checked by lessons.test.ts.
 */
import type { DeviceType } from '../engine/types'

export interface Example {
  /** Where to start typing, e.g. "from R1>". */
  title: string
  commands: string[]
  note?: string
}

export interface Topic {
  id: string
  title: string
  body: string[]
  /** Monospace drawing, kept short so it fits a console window. */
  diagram?: string
  examples?: Example[]
}

// ---------- hosts ----------

const ipBasics: Topic = {
  id: 'ip',
  title: 'IP addresses and subnets',
  body: [
    'An IPv4 address is four numbers from 0 to 255, like `192.168.1.10`. The `/24` after it is the prefix length: the first 24 bits name the network, the rest name the host.',
    '`/24` is the same as the subnet mask `255.255.255.0`. So `192.168.1.10/24` lives in network `192.168.1.0`, and hosts `.1` to `.254` share it (`.0` is the network itself, `.255` is broadcast).',
    'Two devices can talk directly only if they are in the same subnet. Anything else must go through a router.',
    'Private ranges you can use freely: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.',
  ],
  diagram: ['192.168.1.10 / 24', '└──── network ───┘└host┘', '192.168.1  .  10'].join('\n'),
  examples: [{ title: 'Give this device an address', commands: ['ip set 192.168.1.10/24', 'ifconfig'] }],
}

const gateway: Topic = {
  id: 'gateway',
  title: 'The default gateway',
  body: [
    'When a host sends to an address outside its own subnet, it hands the packet to its default gateway: a router interface in the same subnet.',
    'Rule of thumb: the gateway must be inside your subnet. `192.168.1.10/24` can use `192.168.1.1`, but not `10.0.0.1`.',
    'No gateway means you can only reach your own subnet.',
  ],
  examples: [{ title: 'Point the host at its router', commands: ['gateway 192.168.1.1', 'ifconfig'] }],
}

const testing: Topic = {
  id: 'testing',
  title: 'Testing connectivity',
  body: [
    '`ping` sends an ICMP echo request and waits for the reply. It only succeeds if the path works in both directions.',
    '`traceroute` lists every router the packet crosses, so you can see where it stops.',
    'Before sending, a host needs the MAC address of the next hop. It asks with ARP ("who has 192.168.1.1?") and caches the answer: `arp -a` shows that cache.',
    '`ping 127.0.0.1` (or `ping localhost`) tests the computer itself: 127.0.0.0/8 is its built-in loopback and never goes on the network. If that works but the gateway doesn\'t, the problem is the cable, the address or the network, not the PC.',
  ],
  examples: [
    { title: 'Check the path to your gateway', commands: ['ping 192.168.1.1', 'traceroute 192.168.1.1', 'arp -a'] },
    { title: 'Test the PC itself first', commands: ['ping 127.0.0.1', 'ping localhost'] },
  ],
}

const ports: Topic = {
  id: 'ports',
  title: 'TCP ports and services',
  body: [
    'An IP address finds the machine; a port finds the service on it. Web servers listen on TCP `80` (HTTP) and `443` (HTTPS), SSH on `22`, DNS on `53`.',
    'Firewalls usually filter by port: "allow 443 to the web server, nothing else". `tcp <ip> <port>` tests whether a connection would get through.',
  ],
  examples: [{ title: 'Test a web and an SSH connection', commands: ['tcp 192.168.1.1 443', 'tcp 192.168.1.1 22'] }],
}

const sshClient: Topic = {
  id: 'ssh',
  title: 'Managing devices over SSH',
  body: [
    'Instead of walking to a router\'s console, admins log in remotely with SSH, which encrypts everything, including the password. (Telnet does the same job in clear text: avoid it.)',
    'The router must have a hostname, a domain name, RSA keys, a local user, and `login local` + `transport input ssh` on its vty lines. Then:',
  ],
  examples: [{ title: 'Log in to a router', commands: ['ssh admin@192.168.1.1'], note: 'Type `exit` to come back.' }],
}

const wifi: Topic = {
  id: 'wifi',
  title: 'Joining Wi-Fi',
  body: [
    'A laptop has no cable: it joins a wireless network (an SSID) served by an access point. The AP bridges you onto the wired LAN, so you still need an IP in that LAN\'s subnet.',
    'Secured networks use WPA2-PSK: everyone shares a password, and traffic is encrypted with AES. If the admin changes the password, every client is disconnected until it rejoins.',
  ],
  examples: [{ title: 'Find and join a network', commands: ['wifi scan', 'wifi connect OFFICE Sup3rSecret', 'wifi status'] }],
}

const serverRole: Topic = {
  id: 'server',
  title: 'What a server does',
  body: [
    'A server is a host like a PC, set up to offer services: web, files, DNS, and so on. Clients connect to its IP on the service\'s port.',
    'Servers usually get a fixed address and live in their own subnet (or a DMZ) behind a firewall, which decides who may reach which port.',
  ],
}

const cabling: Topic = {
  id: 'cables',
  title: 'Choosing the right cable',
  body: [
    'Copper Ethernet has two wire pairs: one to send, one to receive. A PC sends on the pair a switch listens on, so PC↔switch uses a straight-through cable.',
    'Two devices of the same kind (switch↔switch, router↔router, PC↔PC, and PC↔router, which both send on the "PC" pins) need a crossover cable, which swaps the pairs. With the wrong one the link stays down.',
    'Fiber carries light: longer distances, no electrical interference, and it only fits fiber (SFP) ports, like the `g0/1` and `g0/2` uplinks on a switch.',
    'A console cable is not a network cable. It joins a PC\'s `COM1` to a device\'s console port, so you can configure a brand-new router that has no IP yet. On the PC, type `console`.',
    'Many modern ports fix straight-vs-crossover automatically (Auto-MDIX). NetSim follows the classic rule so you learn it; the Auto cable picks the right one for you.',
  ],
  diagram: ['PC ──straight── SW ──crossover── SW', 'PC ──crossover── PC      R ──crossover── R', 'PC COM1 ┄┄console┄┄ con0 R'].join('\n'),
  examples: [{ title: 'With a console cable on COM1', commands: ['ifconfig', 'console'], note: 'Type `exit` to leave the device and come back to the PC.' }],
}

/** Same lesson on Cisco gear: check the cables from the device side. */
const cablingIos: Topic = {
  ...cabling,
  examples: [
    {
      title: 'from the > prompt',
      commands: ['show interfaces', 'show cdp neighbors'],
      note: 'A wrong cable shows as "down" with the reason; CDP only lists neighbours behind working cables.',
    },
  ],
}

// ---------- IOS (shared) ----------

const iosModes: Topic = {
  id: 'ios',
  title: 'The Cisco console',
  body: [
    'Cisco devices have modes. `R1>` is user mode (look only). `enable` gives `R1#`, privileged mode. `configure terminal` gives `R1(config)#`, where changes happen. From there, `interface g0/0` or `line vty 0 4` enter sub-modes.',
    '`exit` goes up one level, `end` (or Ctrl+Z) back to `R1#`. In config mode, run show commands with `do`, like `do show ip interface brief`.',
    'Shortcuts: any unambiguous abbreviation works (`conf t`, `sh ip int br`). Type `?` to see what can come next, and Tab to complete a word.',
  ],
  diagram: ['R1>  ──enable──▶  R1#  ──conf t──▶  R1(config)#', '                                    │ interface g0/0', '                                    ▼', '                              R1(config-if)#'].join('\n'),
  examples: [{ title: 'from the > prompt', commands: ['enable', 'configure terminal', 'hostname EDGE', 'end', 'show running-config'] }],
}

const saving: Topic = {
  id: 'saving',
  title: 'Running vs startup config',
  body: [
    'Every change applies immediately to the running-config, which lives in memory. A reboot would lose it.',
    '`write memory` (or `copy running-config startup-config`) saves it to the startup-config, which loads at boot.',
  ],
  examples: [{ title: 'from the > prompt', commands: ['enable', 'write memory', 'show startup-config'] }],
}

const neighbors: Topic = {
  id: 'cdp',
  title: 'Finding neighbours',
  body: [
    'CDP (Cisco Discovery Protocol) lets directly connected Cisco devices announce themselves. `show cdp neighbors` tells you what is on the other end of each cable: very handy when the diagram is wrong or missing.',
  ],
  examples: [{ title: 'from the > or # prompt', commands: ['show cdp neighbors', 'show ip interface brief'] }],
}

const hardening: Topic = {
  id: 'hardening',
  title: 'Securing access',
  body: [
    '`enable secret` protects privileged mode with a hashed password. Avoid `enable password`: it is stored in clear text.',
    '`service password-encryption` hides the remaining clear-text passwords in the config (weakly, but better than nothing).',
    'For remote management use SSH with local accounts, and refuse Telnet on the vty lines.',
  ],
  examples: [
    {
      title: 'from the > prompt',
      commands: [
        'enable',
        'configure terminal',
        'enable secret Cl4ssified',
        'username admin secret S3cret!',
        'ip domain-name lab.local',
        'crypto key generate rsa modulus 2048',
        'ip ssh version 2',
        'line vty 0 4',
        'login local',
        'transport input ssh',
        'end',
        'write memory',
      ],
    },
  ],
}

// ---------- switch ----------

const switching: Topic = {
  id: 'switching',
  title: 'What a switch does',
  body: [
    'A switch connects devices in the same network (one broadcast domain). It works with MAC addresses, not IPs, so it needs no IP to do its job.',
    'It learns: when a frame arrives, it notes "this source MAC is on this port". When it knows the destination\'s port it sends the frame only there; otherwise it floods it out every port.',
    'Try pinging between two hosts on this switch, then look at what it learned.',
  ],
  diagram: ['PC1 ─fa0/1─┐', '            SW1  MAC table: PC1→fa0/1, PC2→fa0/2', 'PC2 ─fa0/2─┘'].join('\n'),
  examples: [{ title: 'from the > or # prompt', commands: ['show mac address-table', 'show interfaces fa0/1'] }],
}

const portAdmin: Topic = {
  id: 'portadmin',
  title: 'Shutting ports and labelling them',
  body: [
    'An unused port is a way in for anyone with a cable. Good practice is to `shutdown` ports you don\'t use and `description` the ones you do.',
    'A shut port shows `administratively down` and its LED turns red.',
  ],
  examples: [{ title: 'from the > prompt', commands: ['enable', 'configure terminal', 'interface fa0/8', 'description unused', 'shutdown', 'end', 'show ip interface brief'] }],
}

// ---------- router / firewall ----------

const routing: Topic = {
  id: 'routing',
  title: 'What a router does',
  body: [
    'A router connects different subnets. Each interface sits in its own subnet, and is usually the default gateway for the hosts there.',
    'Its routing table says where to send each destination. `C` routes are directly connected networks, `L` are its own addresses, `S` are static routes you add. For each packet it picks the most specific match (the longest prefix).',
  ],
  diagram: ['LAN A 10.1.0.0/24 ─g0/0─ R1 ─g0/1─ 10.2.0.0/30 ─ R2 ─ LAN B'].join('\n'),
  examples: [{ title: 'from the > or # prompt', commands: ['show ip route', 'show ip interface brief'] }],
}

const ifaceConfig: Topic = {
  id: 'interfaces',
  title: 'Configuring an interface',
  body: [
    'Give each interface an address in the subnet it serves. IOS wants a dotted mask, not `/24`: `/24` = `255.255.255.0`, `/30` = `255.255.255.252` (2 hosts, perfect for router-to-router links).',
    'An interface needs a cable at both ends and must not be shut down. Check with `show ip interface brief`: you want `up` / `up`.',
  ],
  examples: [
    {
      title: 'from the > prompt',
      commands: ['enable', 'configure terminal', 'interface g0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'end', 'show ip interface brief'],
    },
  ],
}

const staticRoutes: Topic = {
  id: 'static',
  title: 'Static routes',
  body: [
    'A router only knows the networks it is connected to. To reach a network behind another router, add a static route: destination network, mask, and the next hop (the other router\'s address on a shared subnet).',
    'Routes are one-way: the other router needs a route back, or replies get lost. A default route (`0.0.0.0 0.0.0.0`) catches everything else, typically towards the Internet.',
  ],
  examples: [
    {
      title: 'from the > prompt',
      commands: ['enable', 'configure terminal', 'ip route 10.3.0.0 255.255.255.0 10.2.0.2', 'ip route 0.0.0.0 0.0.0.0 10.2.0.2', 'do show ip route'],
    },
  ],
}

const troubleshooting: Topic = {
  id: 'troubleshoot',
  title: 'Troubleshooting a path',
  body: [
    'Work outwards: can you ping your own interfaces? The next hop? The far network? `traceroute` shows the last router that answered; the problem is just after it.',
    'Common causes: interface down, wrong mask, missing route (often the return route), or a firewall rule.',
  ],
  examples: [{ title: 'from the > or # prompt', commands: ['ping 10.2.0.2', 'traceroute 10.3.0.10', 'show arp'] }],
}

const firewalling: Topic = {
  id: 'firewall',
  title: 'What a firewall does',
  body: [
    'A firewall routes like a router, but checks every new connection against an ordered list of rules. The first matching rule wins; if none matches, the default policy decides.',
    'Secure setups use `fw default deny` and allow only what is needed ("least privilege").',
    'It is stateful: once a connection is allowed, its replies come back automatically. You don\'t write rules for return traffic.',
  ],
  diagram: ['Internet ─g0/0─ FW1 ─g0/1─ LAN', '                 └─g0/2─ DMZ (public servers)'].join('\n'),
  examples: [{ title: 'from the > or # prompt', commands: ['show firewall'] }],
}

const fwRules: Topic = {
  id: 'rules',
  title: 'Writing firewall rules',
  body: [
    'A rule is: action, source, destination, and optionally protocol/port. Sources and destinations are `any`, a host IP, or a network like `10.0.10.0/24`.',
    'Order matters. Put specific rules first: a broad `deny any any` at the top would block everything after it.',
    'The classic DMZ policy: the Internet may reach the web server on 443 only, the LAN may start connections out, and nothing from the Internet reaches the LAN.',
  ],
  examples: [
    {
      title: 'from the > prompt',
      commands: [
        'enable',
        'configure terminal',
        'fw default deny',
        'fw rule add allow any 10.0.50.10 tcp/443',
        'fw rule add allow 10.0.10.0/24 any',
        'do show firewall',
      ],
    },
  ],
}

// ---------- access point ----------

const apRole: Topic = {
  id: 'ap',
  title: 'What an access point does',
  body: [
    'An access point (AP) is a bridge between radio and cable: Wi-Fi clients on its radio (`Dot11Radio0`) are put on the wired LAN behind its `g0/0` port. Like a switch, it is layer 2 and needs no IP.',
    'It announces a network name, the SSID. Clients pick an SSID and prove they know its password.',
  ],
  diagram: ['LT1 )))           ', '       AP1 ─g0/0─ SW1 ─ servers', 'LT2 )))           '].join('\n'),
  examples: [{ title: 'from the > or # prompt', commands: ['show dot11 associations', 'show ip interface brief'] }],
}

const apSecure: Topic = {
  id: 'ssid',
  title: 'Creating a secure SSID',
  body: [
    'Two parts: define the SSID and its security, then serve it on the radio. WPA2-PSK needs key management (WPA version 2), a password of 8 to 63 characters, and AES encryption on the radio.',
    '`guest-mode` broadcasts the SSID so it shows up in scans. Without it the network is hidden, which is not real security: the name leaks anyway.',
  ],
  examples: [
    {
      title: 'from the > prompt',
      commands: [
        'enable',
        'configure terminal',
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
      ],
      note: '"authentication open" sounds insecure, but it is just the 802.11 handshake; WPA2 runs on top of it.',
    },
  ],
}

const wifiSecurity: Topic = {
  id: 'wifisec',
  title: 'Wi-Fi security choices',
  body: [
    'Open network: anyone can join and anyone nearby can read the traffic. Only for guests, ideally isolated from the company LAN.',
    'WPA2-PSK with AES: the standard for small offices. TKIP and WEP are broken; don\'t use them.',
    'Changing the PSK disconnects every client. That is how you lock out someone who learned the old password.',
  ],
}

const patchPanel: Topic = {
  id: 'patch',
  title: 'What a patch panel does',
  body: [
    'A patch panel is passive: no power, no IP, no console. It just organises cables. Each office wall jack has a permanent cable run to the rear of a panel port (punched down), and a short patch cord goes from the front of the same port to a switch.',
    'Front port 5 is wired straight through to rear port 5. To move a desk to another switch port, you only swap a patch cord in the rack: nobody pulls cable through walls.',
    'In NetSim, "terminating" the run means cabling the office device (PC, printer, phone, AP) to a rear port (p1r…p48r). Then patch the front of the same number (p1…p48) to the switch. When you drag a cable to the panel on the 2D map, the port picker shows the front and rear rows; in 3D the rear side is the white punch-down row under the jacks.',
    'Both segments are straight-through, like real structured cabling. NetSim judges the run end to end: PC → panel → switch must behave like one straight cable, so a crossover on one segment takes the link down.',
    'Check it: `ping` from the PC, or `show mac address-table` on the switch after a ping: the PC\'s MAC appears on the switch port the patch cord is in.',
  ],
  diagram: ['PC ──wall jack ─ ─ ─ rear p5 │PATCH│ front p5 ──patch cord── SW1'].join('\n'),
}

const structured: Topic = {
  id: 'structured',
  title: 'Structured cabling: MDF and IDF',
  body: [
    'Buildings are wired in layers. The MDF (main distribution frame) is the main rack room, the server room here, where the core switches, routers and the ISP line live.',
    'An IDF (intermediate distribution frame) is a smaller rack closer to the users, often a wall-mounted mini rack on each floor or wing. Desks are cabled to the nearest IDF; the IDF connects back to the MDF with an uplink, often fiber.',
    'Each rack usually has a patch panel above its switch, so moves and changes are just a patch cord swap.',
  ],
  diagram: ['desks ── IDF (wall rack: patch + switch) ══fiber══ MDF (server room) ── ISP'].join('\n'),
}

const ispTopic: Topic = {
  id: 'isp',
  title: 'The ISP and the Internet',
  body: [
    'Your Internet Service Provider connects the company to the Internet. In NetSim it is a router outside the building with 8.8.8.8 on its loopback (lo0) standing for "the Internet".',
    'Your edge router (or firewall) gets a default route towards the ISP, and the ISP needs a route back to your network. (Real ISPs never route private addresses: companies use NAT, coming later in NetSim.)',
  ],
  examples: [{ title: 'from the > prompt', commands: ['show ip interface brief', 'show ip route'] }],
}

const ontTopic: Topic = {
  id: 'ont',
  title: 'ONT and modem: where the Internet comes in',
  body: [
    'The ISP brings a line into the building: fiber, coax or copper. An ONT (optical network terminal, for fiber) or a modem converts it to ordinary Ethernet.',
    'In NetSim the ISP cable goes into the ONT\'s fiber PON port, and one of its LAN ports goes to your edge router or firewall. The ONT itself is a bridge: no IP to configure.',
  ],
  diagram: ['ISP ══fiber══ pon [ONT] lan1 ──── EDGE router ── LAN'].join('\n'),
}

const printerTopic: Topic = {
  id: 'printer',
  title: 'Network printers',
  body: [
    'A network printer is just another host: it needs an IP in the office subnet and a gateway. Give it a fixed address so everyone\'s print settings keep working.',
    'Print jobs arrive on TCP 9100 (raw) or 631 (IPP). A firewall rule can let only the office subnet print.',
  ],
  examples: [{ title: 'Give the printer an address', commands: ['ip set 192.168.1.50/24', 'gateway 192.168.1.1', 'ifconfig'] }],
}

const phoneTopic: Topic = {
  id: 'voip',
  title: 'IP phones (VoIP)',
  body: [
    'An IP phone sends calls as packets over the same network as PCs. It needs an IP and a gateway, and in real offices it often sits on its own voice VLAN so calls get priority.',
    'IP phones have a built-in switch with two ports: eth0 goes to the wall jack (or switch), and the PC on the desk plugs into the phone\'s pc port. Phone and PC share one cable run back to the rack.',
    'Cabling: PC → phone pc port is straight-through (the pc port is a switch port), phone eth0 → switch is straight-through too.',
  ],
  diagram: ['PC ──straight── [pc  TEL1  eth0] ──straight── SW1'].join('\n'),
  examples: [{ title: 'Give the phone an address', commands: ['ip set 192.168.1.60/24', 'gateway 192.168.1.1', 'ping 192.168.1.1'] }],
}


// ---------- VLANs, DHCP, dynamic routing, NAT ----------

const vlans: Topic = {
  id: 'vlans',
  title: 'VLANs: several LANs on one switch',
  body: [
    'A VLAN splits one switch into separate broadcast domains. Ports in VLAN 10 only talk to other ports in VLAN 10, even on the same switch: Sales and Accounting can share hardware but not traffic.',
    'An access port belongs to one VLAN and carries untagged frames: that is where PCs, printers and phones plug in. Every port starts in VLAN 1.',
    'Each VLAN is its own subnet. To go from one VLAN to another, traffic needs a router (see router on a stick).',
    '`switchport access vlan 10` creates VLAN 10 if it is missing, like real IOS. `vlan 10` + `name SALES` creates and names it yourself.',
  ],
  diagram: ['PC1 ─fa0/1 [VLAN 10]  SW1  [VLAN 20] fa0/2─ PC2', '        same switch, separate networks'].join('\n'),
  examples: [
    {
      title: 'Create VLAN 10 and put a port in it',
      commands: ['enable', 'configure terminal', 'vlan 10', 'name SALES', 'exit', 'interface fa0/1', 'switchport mode access', 'switchport access vlan 10', 'end', 'show vlan brief'],
    },
    { title: 'Several ports at once', commands: ['enable', 'configure terminal', 'interface range fa0/2 - 4', 'switchport access vlan 10', 'end'] },
  ],
}

const trunks: Topic = {
  id: 'trunks',
  title: 'Trunks: carrying many VLANs on one cable',
  body: [
    'A trunk port carries frames for many VLANs between switches (or to a router). Each frame gets an 802.1Q tag saying which VLAN it belongs to.',
    'The native VLAN (VLAN 1 unless you change it) crosses the trunk untagged. It must match on both ends.',
    '`switchport trunk allowed vlan 10,20` limits which VLANs cross. A switch in the middle must also have the VLAN created, or it drops those frames.',
    'NetSim has no DTP auto-negotiation: set `switchport mode trunk` on both ends.',
  ],
  diagram: ['SW1 g0/1 ══ trunk (VLAN 10, 20 tagged) ══ g0/1 SW2'].join('\n'),
  examples: [
    { title: 'Make the uplink a trunk', commands: ['enable', 'configure terminal', 'interface g0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 1,10,20', 'end', 'show interfaces trunk'] },
  ],
}

const switchMgmt: Topic = {
  id: 'svi',
  title: 'A management address for the switch',
  body: [
    'Switch ports have no IP addresses. To ping or SSH to the switch itself, give it an address on a VLAN interface (SVI), usually `interface vlan 1` or a dedicated management VLAN.',
    'For traffic to other subnets (like the admin PC in another VLAN), set `ip default-gateway` to the router.',
  ],
  examples: [
    { title: 'Address the switch', commands: ['enable', 'configure terminal', 'interface vlan 1', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', 'ip default-gateway 10.0.0.1', 'end', 'show ip interface brief'] },
  ],
}

const roas: Topic = {
  id: 'roas',
  title: 'Router on a stick (inter-VLAN routing)',
  body: [
    'One router port, cabled to a switch trunk, can route between all the VLANs. Split it into subinterfaces: `g0/0.10` for VLAN 10, `g0/0.20` for VLAN 20.',
    'Each subinterface gets `encapsulation dot1Q <vlan>` and an IP address: that address is the default gateway for PCs in that VLAN.',
    'The physical port itself needs `no shutdown` and usually no IP address. The switch port facing the router must be a trunk.',
  ],
  diagram: ['R1 g0/0.10 192.168.10.1  ┐', 'R1 g0/0.20 192.168.20.1  ┴─ trunk ─ SW1 ─ PCs in VLAN 10 and 20'].join('\n'),
  examples: [
    {
      title: 'Gateways for VLAN 10 and 20',
      commands: [
        'enable',
        'configure terminal',
        'interface g0/0',
        'no shutdown',
        'interface g0/0.10',
        'encapsulation dot1Q 10',
        'ip address 192.168.10.1 255.255.255.0',
        'interface g0/0.20',
        'encapsulation dot1Q 20',
        'ip address 192.168.20.1 255.255.255.0',
        'end',
        'show ip interface brief',
      ],
    },
  ],
}

const dynamicRouting: Topic = {
  id: 'dynamic',
  title: 'Dynamic routing: OSPF, EIGRP, RIP',
  body: [
    'Instead of typing a static route on every router, routers can run a routing protocol: they find neighbors on shared subnets, exchange what they know and build the table themselves.',
    'OSPF (link state, open standard) picks paths by cost. EIGRP (Cisco) uses bandwidth and delay. RIP counts hops (max 15). `network` statements choose which interfaces take part.',
    'OSPF network statements use a wildcard mask, the inverse of the subnet mask: `0.0.0.255` for a /24. Neighbors must be in the same area; area 0 is the backbone.',
    '`passive-interface` advertises a LAN without sending hellos to the PCs on it. `default-information originate` shares your default route (to the ISP) with everyone.',
    'If several sources know a prefix, the lowest administrative distance wins: connected 0, static 1, eBGP 20, EIGRP 90, OSPF 110, RIP 120.',
  ],
  examples: [
    {
      title: 'OSPF on every 10.x interface',
      commands: ['enable', 'configure terminal', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'passive-interface g0/0', 'end', 'show ip ospf neighbor', 'show ip route'],
      note: 'Do the same on the neighbor router, then check show ip route for O routes.',
    },
    { title: 'EIGRP instead', commands: ['enable', 'configure terminal', 'router eigrp 100', 'network 10.0.0.0', 'end', 'show ip eigrp neighbors'] },
    { title: 'RIP version 2', commands: ['enable', 'configure terminal', 'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'end', 'show ip protocols'] },
  ],
}

const bgp: Topic = {
  id: 'bgp',
  title: 'BGP: routing between companies',
  body: [
    'BGP connects autonomous systems (AS): your company, your ISP, the rest of the Internet. Unlike OSPF, neighbors are configured by hand: `neighbor <ip> remote-as <their AS>`.',
    'eBGP runs between different ASes, iBGP inside one. `network <prefix> mask <mask>` advertises a prefix, but only if the router already has that exact route.',
    'Private AS numbers are 64512–65534. In NetSim, BGP neighbors must share a subnet.',
  ],
  examples: [
    {
      title: 'Peer with the ISP and advertise the office',
      commands: ['enable', 'configure terminal', 'router bgp 65001', 'neighbor 203.0.113.1 remote-as 65000', 'network 192.168.1.0 mask 255.255.255.0', 'end', 'show ip bgp summary'],
    },
  ],
}

const dhcpServer: Topic = {
  id: 'dhcp',
  title: 'DHCP: handing out addresses',
  body: [
    'DHCP gives hosts their IP, mask, gateway and DNS automatically. The client broadcasts DISCOVER; a server answers with an OFFER, the client REQUESTs it, the server ACKs.',
    'A router can be the server: `ip dhcp pool` with a `network`, a `default-router` and a `dns-server`. Exclude the addresses you assign by hand (gateways, servers, printers) with `ip dhcp excluded-address`.',
    'Broadcasts stop at routers. If the server is on another subnet, the client\'s gateway relays the request: `ip helper-address <server>` on that interface.',
  ],
  examples: [
    {
      title: 'A pool for the office LAN',
      commands: [
        'enable',
        'configure terminal',
        'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
        'ip dhcp pool OFFICE',
        'network 192.168.1.0 255.255.255.0',
        'default-router 192.168.1.1',
        'dns-server 8.8.8.8',
        'end',
        'show ip dhcp pool',
      ],
    },
    { title: 'Relay for a LAN behind this router', commands: ['enable', 'configure terminal', 'interface g0/1', 'ip helper-address 10.0.0.1', 'end'] },
  ],
}

const dhcpClient: Topic = {
  id: 'dhcpclient',
  title: 'Getting an address by DHCP',
  body: [
    'Instead of typing an address, ask the network for one: `dhcp` (or `ipconfig /renew`). You get an IP, mask and default gateway from the DHCP server for your LAN or VLAN.',
    'No answer? The cable or Wi-Fi must be up, a router interface must be in your VLAN, and it needs a pool for your subnet or an `ip helper-address`. The output says which is missing.',
    '`dhcp release` gives the address back. Typing a static address turns DHCP off.',
  ],
  examples: [{ title: 'Ask for an address', commands: ['dhcp', 'ifconfig'] }],
}

const nat: Topic = {
  id: 'nat',
  title: 'NAT: private addresses on the Internet',
  body: [
    'Private addresses (192.168.x.x, 10.x.x.x) are not routed on the Internet: the ISP has no way back to them. NAT on the edge router rewrites them to its public address on the way out, and back on the way in.',
    'Mark the sides: `ip nat inside` on the LAN interface, `ip nat outside` toward the ISP. Then PAT (overload) lets every host share the outside address: `ip nat inside source list 1 interface g0/1 overload`, with `access-list 1` listing the inside networks.',
    'Static NAT (`ip nat inside source static <inside> <public>`) publishes one inside server on a public address.',
    'Access lists use wildcard masks: `0.0.0.255` matches a /24.',
  ],
  diagram: ['PC 192.168.1.10 ─ [inside g0/0  R1  g0/1 outside 203.0.113.2] ─ ISP', '          src 192.168.1.10  →  src 203.0.113.2'].join('\n'),
  examples: [
    {
      title: 'PAT for the office',
      commands: [
        'enable',
        'configure terminal',
        'access-list 1 permit 192.168.1.0 0.0.0.255',
        'interface g0/0',
        'ip nat inside',
        'interface g0/1',
        'ip nat outside',
        'exit',
        'ip nat inside source list 1 interface g0/1 overload',
        'end',
        'show ip nat translations',
      ],
    },
  ],
}

const TOPICS: Record<DeviceType, Topic[]> = {
  pc: [ipBasics, gateway, dhcpClient, testing, cabling, ports, sshClient],
  laptop: [wifi, ipBasics, gateway, dhcpClient, testing, sshClient],
  mobile: [wifi, ipBasics, gateway, dhcpClient, testing],
  server: [serverRole, ipBasics, gateway, testing, ports],
  switch: [switching, vlans, trunks, switchMgmt, cablingIos, structured, iosModes, portAdmin, neighbors, saving],
  ap: [apRole, apSecure, wifiSecurity, iosModes, saving],
  router: [routing, cablingIos, iosModes, ifaceConfig, staticRoutes, dynamicRouting, roas, dhcpServer, nat, bgp, troubleshooting, hardening, saving],
  firewall: [firewalling, fwRules, iosModes, ifaceConfig, staticRoutes, dynamicRouting, nat, saving],
  patch: [patchPanel, structured, cabling],
  modem: [ontTopic, cabling, structured],
  printer: [printerTopic, ipBasics, gateway, dhcpClient, testing],
  phone: [phoneTopic, ipBasics, gateway, dhcpClient, testing],
  isp: [ispTopic, routing, iosModes, ifaceConfig, staticRoutes, bgp, dhcpServer],
}

export function topicsFor(type: DeviceType): Topic[] {
  return TOPICS[type]
}
