# NetSim — Network & Cyber Security Simulator

A browser game for learning networking. Build networks out of PCs, laptops, servers, switches, access points, routers and firewalls, configure them from a GUI or a hacker-style CLI, and watch packets travel hop by hop.

- **Frontend:** Vue 3, TypeScript, Vite, Pinia, Tailwind v4, Vue Flow (canvas), xterm.js (terminal)
- **Backend:** FastAPI, SQLModel, Alembic, JWT auth, Postgres in Docker or SQLite locally

## How it works

The simulation engine in `frontend/src/engine/` is plain TypeScript with no Vue dependency. It handles:

| File | What it does |
| --- | --- |
| `ip.ts` | IPv4 and CIDR math |
| `network.ts` | device catalog, adding and removing devices, cables, mission topology builder |
| `forwarding.ts` | ARP, switch MAC learning, longest-prefix routing, stateful firewall ACLs, TTL. Produces a hop trace that drives both the animation and the CLI output |
| `commands.ts` | the Linux-style host shell for PCs and servers (`ifconfig`, `ip set`, `ping`, `traceroute`, `tcp`, …) |
| `ios.ts` | the Cisco IOS-style console for routers, switches and firewalls (see below) |
| `shell.ts` | per-device terminal sessions: picks the shell, handles password prompts and SSH hops |
| `objectives.ts` | mission win conditions |

### IOS console

Routers, switches and firewalls use IOS modes: `R1>` → `enable` → `R1#` → `configure terminal` → `interface g0/0` / `line vty 0 4`. You can shorten keywords if they stay unambiguous (`sh ip int br`, `conf t`). `?` lists what can come next, Tab completes, Ctrl+Z leaves config mode, and `do` runs exec commands from config mode.

Supported: `ip address`, `shutdown`, `description`, `ip route`, `hostname`, `enable secret`, `username`, `service password-encryption`, `banner motd`, `ip domain-name`, `crypto key generate rsa`, `ip ssh version 2`, `login local`, `transport input`, `write memory`, and `show` for `running-config`, `startup-config`, `ip interface brief`, `ip route`, `interfaces`, `arp`, `mac address-table`, `cdp neighbors`, `ip ssh` and `version`. On firewalls the `fw ...` rule commands still work.

### VLANs, routing protocols, DHCP and NAT

- **VLANs and trunks (switches):** `vlan 10` + `name SALES`, `switchport mode access|trunk`, `switchport access vlan 10` (creates the VLAN if it's missing, like IOS), `switchport trunk allowed vlan 10,20` (`add`/`remove`/`all`/`none`), `switchport trunk native vlan`, `interface range fa0/1 - 4`. Frames really carry 802.1Q tags. Access ports only reach their own VLAN, trunks carry the VLANs they allow (native VLAN untagged), and a switch in the middle drops VLANs it doesn't have. `show vlan brief` and `show interfaces trunk` list ports and warn about mismatched ends.
- **Switch management address:** `interface vlan 1` → `ip address …`, plus `ip default-gateway`. The switch can then be pinged and SSH'd to, and shows up with its IP in the admin PC's Notes tab.
- **Router on a stick:** `interface g0/0.10` → `encapsulation dot1Q 10` → `ip address …` routes between VLANs over one trunk. `interface loopback 0` gives a router a loopback.
- **OSPF, EIGRP, RIP:** `router ospf 1` / `router eigrp 100` / `router rip`, then `network` (OSPF: wildcard + `area`), `passive-interface`, `router-id`, `default-information originate`, `version 2`, `ip ospf cost`.
  - **Neighbors:** they only form over a working layer 2 path between interfaces in the same subnet with matching area/AS. `show ip ospf neighbor` and `show ip eigrp neighbors` explain why one doesn't (area mismatch, AS mismatch, passive, no network statement, duplicate router ID).
  - **Route choice:** per prefix, the lowest administrative distance wins (connected 0, static 1, eBGP 20, EIGRP 90, OSPF 110, RIP 120, iBGP 200). Packets follow longest-prefix match.
  - **Other show commands:** `show ip route` uses the IOS codes (C, L, S, O, O IA, O E2, D, R, B), and `show ip protocols` summarises every process.
- **BGP:** `router bgp 65001`, `neighbor <ip> remote-as <AS>`, `network <prefix> mask <mask>` (only advertised if that exact route exists). eBGP/iBGP with AS-path loop prevention. Peers must share a subnet. `show ip bgp summary`, `show ip bgp`.
- **DHCP:**
  - **Server:** `ip dhcp pool NAME` → `network`, `default-router`, `dns-server`, plus `ip dhcp excluded-address`.
  - **Relay:** `ip helper-address` on the client's gateway.
  - **Clients:** `dhcp` / `ipconfig /renew` on PCs, laptops, phones and printers, or the **DHCP** button next to each interface in the side panel. A router interface can be a client too (`ip address dhcp`) and installs the default route it is given.
  - **Checking:** `show ip dhcp binding`, `show ip dhcp pool`. A failed request explains what's missing: no router in that VLAN, no pool for the subnet, or a relay that can't reach the server.
- **Static routes:** next hop (`ip route 10.3.0.0 255.255.255.0 10.2.0.2`), exit interface (`… g0/1`, answered with proxy ARP), or both. A distance at the end makes a floating static route (`… 10.2.0.2 200`), a backup that stays out of the table while a better route exists.
- **Access lists:**
  - Standard (1-99) and extended (100-199) numbered lists, and named lists (`ip access-list standard|extended NAME`, with sequence numbers and `remark`).
  - Extended lines match `ip|icmp|tcp|udp`, source, destination, `eq <port>` (numbers or names like `www`, `ssh`, `domain`) and `established`.
  - Applied with `ip access-group <acl> in|out` (checked before NAT inbound and after NAT outbound, as in IOS), or `access-class <acl> in` on `line vty` to limit who can SSH in.
  - First match wins, with the implicit deny at the end. ACLs are stateless, so replies are checked too.
  - `show access-lists` counts matches per line. The console warns about subnet masks used as wildcards, lists with only denies, and lines that can never match.
- **Port security:** `switchport port-security` (the port must be `switchport mode access` first), `maximum`, `violation shutdown|restrict|protect`, `mac-address sticky` or a static `mac-address`. A violation err-disables the port (`shutdown` / `no shutdown` recovers it). `show port-security [interface|address]`.
- **Spanning tree:**
  - One tree per VLAN (PVST+, or `spanning-tree mode rapid-pvst`). The lowest bridge ID becomes root, root ports take the cheapest path (cost 19 Fa, 4 Gi), and redundant ports block. Traffic follows the tree, and a blocked port takes over when a link fails.
  - Commands: `spanning-tree vlan N priority` (steps of 4096) or `root primary|secondary`, `spanning-tree portfast`, `bpduguard enable` (a switch plugged in err-disables the port), `spanning-tree cost`.
  - `show spanning-tree` in the IOS layout.
- **NAT:** `ip nat inside` / `ip nat outside` on interfaces, `access-list 1 permit 192.168.1.0 0.0.0.255` and `ip nat inside source list 1 interface g0/1 overload` (PAT), or `ip nat inside source static <inside> <public>`. Ping and traceroute show each translation, and replies are translated back. `show ip nat translations`, `show access-lists`.

### Cables

Pick a cable in the device list before connecting:

| Cable | Use | If it's wrong |
| --- | --- | --- |
| Straight-through | unlike devices: PC, router, AP or firewall to a switch | link stays down, with the reason |
| Crossover | like devices: switch↔switch, router↔router, PC↔PC, PC↔router | link stays down, with the reason |
| Fiber | fiber (SFP) ports: `g0/1`–`g0/2` on switches, `g0/4` on routers, `g0/3` on firewalls | refused: it doesn't fit |
| Console | a PC's `com1` to a device's `con0`; then `console` on the PC opens the device's CLI with no IP | carries no traffic |
| Auto (default) | picks straight or crossover and says which | |

The rules live in `src/engine/network.ts` (`cableFor`, `cableProblem`); `cables.test.ts` covers them.


**Choosing ports.** On the 2D map, dragging a cable from one device to another opens a port picker. It shows every port on both ends, colour-coded by type (copper RJ45, fiber SFP as round orange chips, console). Ports in use are crossed out, with what they're plugged into. It starts with the ports auto-connect would choose. You can change the cable type there, and it warns before you plug in if the ports need the other copper cable or a fiber cable.

**Telling fiber from copper.**
- **3D:** fiber (SFP) ports are slim silver cages with an orange frame, and an orange dust cap while unplugged.
- **Side panel:** ports are colour-coded, with a legend.
- **IOS console:** `show interfaces status` lists each port's type (`10/100BaseTX`, `10/100/1000BaseTX`, `1000BaseSX SFP (fiber)`), and `show interfaces <port>` says `Hardware is … SFP (fiber)` / `media type is 1000BaseSX`.
- **Which ports are fiber:** switches g0/1–g0/2, routers g0/4, firewalls g0/3, the ONT's `pon` and the ISP's `pon0`.
- **Switch and router ports:** switches are 48-port access switches: `fa0/1–fa0/48` in two rows of 24 (odd on top), copper gigabit `g0/3–g0/6`, fiber `g0/1–g0/2`. Routers have copper `g0/0–g0/3` and `g0/5`, plus fiber `g0/4`.
- **Older networks:** networks saved before a port existed get it added when they load. Their existing ports, addresses and cables are kept.

### Wi-Fi

Access points (AP) are layer 2 bridges. They have a wired uplink `g0/0` and a radio, `Dot11Radio0`, configured Aironet-style: `dot11 ssid OFFICE` → `authentication open`, `authentication key-management wpa version 2`, `wpa-psk ascii <key>`, `guest-mode`. Then `interface Dot11Radio0` → `encryption mode ciphers aes-ccm`, `ssid OFFICE`. `show dot11 associations` lists the clients.

Laptops have only `wlan0` and join with `wifi scan` and `wifi connect <ssid> <password>`. A Wi-Fi link is free and works only while the AP still accepts it: changing the key, removing the SSID or shutting the radio drops the clients.

PC and laptop console windows have a **PuTTY** tab: a host field, SSH or Serial (COM1 over a console cable), a username, and saved sessions for every Cisco-style device marked *SSH ready* or with the reason it isn't. Open runs the login in the Console tab. A sandbox always has **ADMIN-PC** at the server room desk (uncabled); older saved sandboxes get one when they load. The admin's PC can sit at a desk in the server room (pick "Server room" for a PC or laptop), or in the IT office.

A PC or laptop in the server room (ADMIN-PC) also gets a **Notes** tab. It lists every router, switch, firewall, AP, modem and ISP with its rack/room and interface IPs, plus an **SSH** button that opens `ssh admin@<ip>` in the Console tab (green when the device is SSH ready). Whenever an IP is assigned or changed on a network device, an entry (time, device, interface, new IP, old IP) is added automatically to the change log (the last 60 are kept). A free-text *My notes* box is saved with the topology.

`ssh admin@10.0.0.1` from a PC, or `ssh -l admin 10.0.0.1` from IOS, opens a session on the remote device. The connection goes over TCP 22, so firewall rules apply. It works only once the target has RSA keys, allows SSH on its vty lines, and has a login set up.

### Racks, patch panels and the ISP

Adding a device asks where it goes: an existing rack, a new floor rack (MDF) in the server room, or a new wall-mounted mini rack (IDF) in an office; PCs, laptops and APs ask for an office. **＋ Add a rack** in the device list adds an empty one, and the Building section lists every rack: click one to see what is mounted in it, show it in 3D, or delete it (with a confirmation) (its devices move to the server room's other racks; later floor racks are renumbered). Wall racks hang at chest height on the office's back wall and hold a few devices (a full one spills over to the server room).

A **patch panel** has 48 front ports (p1–p48) wired straight through to 48 rear ports (p1r–p48r); traffic only passes between matching numbers. Auto cabling lands office devices on the rear and switches on the front of the same port. The **ISP** is a cloud on the 2D map only (drag its corner to enlarge it); it routes like a router and has 8.8.8.8 on lo0 for "the Internet".

Click the floor in the 3D view to walk there, and **📍 Show in 3D** in any device's side panel walks you up to it. New devices land inside their room's box on the 2D map (rack gear under its rack-mates).

### Office equipment, balconies and new rooms

- **ONT / modem:** a rack unit where the ISP's line comes in: the fiber `pon` port faces the ISP, `lan1`–`lan4` go to your edge router. A layer 2 bridge.
- **Printer:** a host on a cabinet by the office door.
- **PC:** comes with an IP phone on its desk (in the Sandbox), not cabled: wire PC → phone `pc` port → network yourself.
- **IP phone:** a host with two ports and a built-in switch: `eth0` to the network, `pc` for the PC on the desk (both straight-through). The add dialog lists desks without a phone as checkboxes, with **All desks**. Cabling is up to you; a PC-to-phone cable lies on the desk, behind the monitor.
- **Smartphone:** a wireless-only host like the laptop (`wifi scan`, `wifi connect`).
- Every balcony seat has someone on it: a laptop user on each lounge chair and a smartphone user at each railing spot (filled in when the network loads and when a balcony is added).
- On a balcony, laptops and smartphones are used by people: laptops on the lounge chairs' laps, smartphones in hand at the railing. They're real devices: click to select, E for the console. Free chairs stay empty. A new balcony can start with a few laptop and smartphone users.
- **＋ Add a room** in the device list adds an **office** (east end of the building) or a **balcony** (a terrace off the corridor, through a glass door, facing the city, with people working on laptops). Only laptops and APs go out on a balcony. APs hang from the ceiling in offices and on the outside wall by a balcony door.
- The **Building** section of the side menu lists the rooms: click one to go there in 3D (or use **Go to ▾** in the 3D view), or 🗑 to delete an office or balcony (its devices move to another office). Side menu sections fold up, and the device list is grouped into Network devices, End devices, Servers and Internet.

### Rooms on the 2D map

The **▦ Rooms** toggle draws a labelled box around the devices in each room of the 3D building. Drag a box by its header to move the whole room. Drop a PC, laptop or AP into another office's box to move it there (rack gear stays in the server room). Double-click a room's name, or click ✎, to rename and recolour it; names and colours are saved with the network and also appear on the 3D door signs. Racks show as smaller boxes inside their room. **Tidy by room** lays the map out in one block per room (`src/room/groups.ts`).

### Learn tab

Every console window has a **Learn** tab with lessons for that device type: IP addressing and gateways for PCs, Wi-Fi for laptops, MAC learning for switches, routing and static routes for routers, rules for firewalls, and SSIDs and WPA2 for access points. A "this device" card applies them to the device's actual settings (its subnet, whether its gateway is reachable, and so on). Clicking an example command types it into the console. Lessons live in `src/learn/lessons.ts`; `lessons.test.ts` runs every example command on a fresh device of that type, so a lesson can't teach a command the console rejects.

### 3D building

**Axis gizmo.** Like Unity's scene gizmo, the top-right corner of the 3D view shows the X (red), Y (green) and Z (blue) axes turning with the camera, with grey dots for the negative ends. Click an arrow or dot to look that way: walking, X/Z turn you and Y looks up or down; in the overview, X/Z swing round to that side and Y gives a top-down view. Under it, the camera position in metres (x east, y up, z south).

The 3D view is a small company floor: a corridor with a row of rooms behind it, the **Server room** (glass front, racks), the **IT office**, **Accounting** and **Sales**. Each room has a doorway with its name over it, and a label in the corner tells you where you are. PCs, laptops and APs sit in cubicles in an office (IT by default). Move them by dragging them onto another office's floor, or with the Room dropdown in the side panel; missions can place devices too (`"room": "sales"`). Rooms have fixed widths and grow deeper as they fill, so adding devices never moves anything already placed.

**Overview:** press **O**, the minus key, the Overview button, or pinch out to fly up to an aerial view of the whole company with the roof cut away. The exterior has a facade, lawn, parking lot, roads and a night-time city (`src/room/city.ts`, seeded so it never changes). Drag to orbit, scroll or pinch to zoom, right-drag to pan. Click any spot in the building to fly down and stand there, or press O to go back to where you were.

You see the world through the engineer's eyes. **W/S** walk, **A/D** turn (so you always face where you're going), right-drag looks around, and a two-finger swipe walks (up/down) and turns (left/right). A gloved right hand appears only for cable work: it holds the plug while you carry a cable (in that cable's colour) and reaches to the port when you plug in or unplug, then goes away. It's drawn in its own pass after the room, so it never clips into a rack (`src/room/hands.ts`).

### 3D server room

The **3D room** toggle above the canvas switches to a first-person view of the same network. You start a metre from Rack 1 with its door open; "Reset view" (or R) brings you back there. Routers, switches, firewalls and servers stack top to bottom in shared racks; a new rack opens when one is full. Drag a device onto a rack to mount it there, and drag a mounted device (door open) to move it up, down or into another rack. PCs, laptops and access points each get a cubicle in the office, which is separated from the server room by a glass wall with a doorway. Adding a device never moves the ones already placed. The mouse stays free by default: click what's under the cursor. Press F (or the FPS mode button) for first-person mode with a captured mouse and a crosshair; Esc leaves it. Click a rack door to open it. Click a free port to pick up a cable, then click another port to plug it in, or click a used port to unplug it. Press E or double-click to open the console of whatever you are pointing at, in a window you can move. Port LEDs show the link state, and pings move along the cables through the overhead tray.

The room lives in `src/room/`. `layout.ts` is pure and unit-tested: it places furniture, ports and collision boxes. `RoomScene.ts` is the Three.js scene. Add `?debug` to the URL to get `window.room.teleport(x, z, [lx, ly, lz])` for scripted browser tests.

The backend stores user accounts, saved sandbox networks and mission progress. Missions are defined in `backend/app/missions.py`.

## Run locally

> ⚠️ The parent folder name `networking :cybersecurity` contains a colon and a space. npm `.bin` lookups, Python venvs and Vite's dev server all break on that.
> Rename the folder first, e.g. `mv "networking :cybersecurity" networking-cybersecurity`.

```bash
# backend → http://localhost:8010
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/alembic upgrade head          # creates ./netsim.db (SQLite)
.venv/bin/uvicorn app.main:app --reload --port 8010

# frontend → http://localhost:5273 (proxies /api to :8010)
cd frontend
npm install
npm run dev
```

## Run with Docker

```bash
cp .env.example .env   # then set SECRET_KEY
docker compose up --build
```

Open http://localhost:8090 for the app. The API is also exposed directly at http://localhost:8011.

## Tests

```bash
cd frontend && npm test              # engine: routing, ARP, firewall, TTL loops, objectives
cd backend && .venv/bin/pytest       # auth, topology CRUD/ownership, progress
```

## Adding a mission

Add an entry to `MISSIONS` in `backend/app/missions.py`. Each entry has:

- a starting topology: devices, IPs and cables. Devices it creates are locked, so they can't be deleted.
- the device types the player is allowed to place
- a budget, plus par cost and par time (stars are awarded for meeting each)
- objectives:

  | Type | Checks |
  | --- | --- |
  | `ping` / `tcp` | traffic succeeds or fails, as expected |
  | `inSubnet` | devices have addresses inside a given network |
  | `distinctSubnets` | devices are each in a different subnet |
  | `deviceCount` | at least N devices of a type exist |
  | `ssh` | a host can SSH into a device with a given local user |
  | `ios` | a device has an enable secret, SSH-only vty, password encryption, a saved config, or WPA2 Wi-Fi |
  | `wifi` | a laptop is joined to an SSID |

- hints

## Roadmap

- Blue Team scenarios: attack traffic, threat map, log analysis, patching SQLi/XSS
- IPv6 (addressing, SLAAC, static and OSPFv3 routing)
- EtherChannel, HSRP, DHCP snooping
- DNS
- Redistribution between routing protocols, OSPF multi-area rules (area 0 backbone)
- Leaderboards