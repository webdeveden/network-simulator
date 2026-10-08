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

### Wi-Fi

Access points (AP) are layer 2 bridges. They have a wired uplink `g0/0` and a radio, `Dot11Radio0`, configured Aironet-style: `dot11 ssid OFFICE` → `authentication open`, `authentication key-management wpa version 2`, `wpa-psk ascii <key>`, `guest-mode`. Then `interface Dot11Radio0` → `encryption mode ciphers aes-ccm`, `ssid OFFICE`. `show dot11 associations` lists the clients.

Laptops have only `wlan0` and join with `wifi scan` and `wifi connect <ssid> <password>`. A Wi-Fi link is free and works only while the AP still accepts it: changing the key, removing the SSID or shutting the radio drops the clients.

`ssh admin@10.0.0.1` from a PC, or `ssh -l admin 10.0.0.1` from IOS, opens a session on the remote device. The connection goes over TCP 22, so firewall rules apply. It works only once the target has RSA keys, allows SSH on its vty lines, and has a login set up.

### Learn tab

Every console window has a **Learn** tab with lessons for that device type: IP addressing and gateways for PCs, Wi-Fi for laptops, MAC learning for switches, routing and static routes for routers, rules for firewalls, and SSIDs and WPA2 for access points. A "this device" card applies them to the device's actual settings (its subnet, whether its gateway is reachable, and so on). Clicking an example command types it into the console. Lessons live in `src/learn/lessons.ts`; `lessons.test.ts` runs every example command on a fresh device of that type, so a lesson can't teach a command the console rejects.

### 3D server room

The **3D room** toggle above the canvas switches to a first-person view of the same network. You start a metre from Rack 1 with its door open; "Reset view" (or R) brings you back there. Routers, switches, firewalls and servers stack top to bottom in shared racks; a new rack opens when one is full. Drag a device onto a rack to mount it there, and drag a mounted device (door open) to move it up, down or into another rack. PCs, laptops and access points each get a cubicle in the office, which is separated from the server room by a glass wall with a doorway. Adding a device never moves the ones already placed. The mouse stays free by default: right-drag (or Alt+drag) to look around, WASD, the arrow keys or a two-finger swipe (mouse wheel) to walk, and click what's under the cursor. Press F (or the FPS mode button) for first-person mode with a captured mouse and a crosshair; Esc leaves it. Click a rack door to open it. Click a free port to pick up a cable, then click another port to plug it in, or click a used port to unplug it. Press E or double-click to open the console of whatever you are pointing at, in a window you can move. Port LEDs show the link state, and pings move along the cables through the overhead tray.

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
