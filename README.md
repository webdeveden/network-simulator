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

### Wi-Fi

Access points (AP) are layer 2 bridges. They have a wired uplink `g0/0` and a radio, `Dot11Radio0`, configured Aironet-style: `dot11 ssid OFFICE` → `authentication open`, `authentication key-management wpa version 2`, `wpa-psk ascii <key>`, `guest-mode`. Then `interface Dot11Radio0` → `encryption mode ciphers aes-ccm`, `ssid OFFICE`. `show dot11 associations` lists the clients.

Laptops have only `wlan0` and join with `wifi scan` and `wifi connect <ssid> <password>`. A Wi-Fi link is free and works only while the AP still accepts it: changing the key, removing the SSID or shutting the radio drops the clients.

`ssh admin@10.0.0.1` from a PC, or `ssh -l admin 10.0.0.1` from IOS, opens a session on the remote device. The connection goes over TCP 22, so firewall rules apply. It works only once the target has RSA keys, allows SSH on its vty lines, and has a login set up.

### Racks, patch panels and the ISP

Adding a device asks where it goes: an existing rack, a new floor rack (MDF) in the server room, or a new wall-mounted mini rack (IDF) in an office; PCs, laptops and APs ask for an office. **＋ Add a rack** in the device list adds an empty one. Wall racks hang at chest height on the office's back wall and hold a few devices (a full one spills over to the server room).

A **patch panel** has 48 front ports (p1–p48) wired straight through to 48 rear ports (p1r–p48r); traffic only passes between matching numbers. Auto cabling lands office devices on the rear and switches on the front of the same port. The **ISP** is a cloud on the 2D map only (drag its corner to enlarge it); it routes like a router and has 8.8.8.8 on lo0 for "the Internet".

### Office equipment, balconies and new rooms

- **ONT / modem:** a rack unit where the ISP's line comes in: the fiber `pon` port faces the ISP, `lan1`–`lan4` go to your edge router. A layer 2 bridge.
- **Printer:** a host on a cabinet by the office door.
- **IP phone:** a host with two ports and a built-in switch: `eth0` to the network, `pc` for the PC on the desk (both straight-through). The add dialog lists desks without a phone as checkboxes, with **All desks**. Cabling is up to you; a PC-to-phone cable lies on the desk, behind the monitor.
- **＋ Add a room** in the device list adds an **office** (east end of the building) or a **balcony** (a terrace off the corridor, through a glass door, facing the city, with people working on laptops). Only laptops and APs go out on a balcony. APs hang from the ceiling in offices and on the outside wall by a balcony door.
- The **Building** section of the side menu lists the rooms: click one to go there in 3D (or use **Go to ▾** in the 3D view), or 🗑 to delete an office or balcony (its devices move to another office). Side menu sections fold up.

### Rooms on the 2D map

The **▦ Rooms** toggle draws a labelled box around the devices in each room of the 3D building. Drag a box by its header to move the whole room. Drop a PC, laptop or AP into another office's box to move it there (rack gear stays in the server room). Double-click a room's name, or click ✎, to rename and recolour it; names and colours are saved with the network and also appear on the 3D door signs. Racks show as smaller boxes inside their room. **Tidy by room** lays the map out in one block per room (`src/room/groups.ts`).

### Learn tab

Every console window has a **Learn** tab with lessons for that device type: IP addressing and gateways for PCs, Wi-Fi for laptops, MAC learning for switches, routing and static routes for routers, rules for firewalls, and SSIDs and WPA2 for access points. A "this device" card applies them to the device's actual settings (its subnet, whether its gateway is reachable, and so on). Clicking an example command types it into the console. Lessons live in `src/learn/lessons.ts`; `lessons.test.ts` runs every example command on a fresh device of that type, so a lesson can't teach a command the console rejects.

### 3D building

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

- VLANs and trunks, SVIs on switches, NAT/PAT
- Blue Team scenarios: attack traffic, threat map, log analysis, patching SQLi/XSS
- DHCP, DNS
- Leaderboards
