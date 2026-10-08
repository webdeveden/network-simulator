"""Mission catalogue.

Missions are static game content, versioned with the code rather than stored
in the database. `start` uses the frontend's TopologySpec format and
`objectives` are evaluated by the frontend engine (src/engine/objectives.ts).
"""

from typing import Any


def _ping(label: str, src: str, dst: str, expect: str = "success") -> dict[str, Any]:
    return {"type": "ping", "label": label, "from": src, "to": dst, "expect": expect}


def _tcp(label: str, src: str, dst: str, port: int, expect: str = "success") -> dict[str, Any]:
    return {"type": "tcp", "label": label, "from": src, "to": dst, "port": port, "expect": expect}


MISSIONS: list[dict[str, Any]] = [
    {
        "id": "hello-world",
        "order": 1,
        "title": "Hello, World",
        "tagline": "Your first cable and your first ping.",
        "difficulty": 1,
        "briefing": (
            "Two workstations were just unboxed and nothing connects them yet.\n\n"
            "Run a cable between them and give each one an IP address in the same "
            "subnet so they can ping each other."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "PC1", "x": 120, "y": 160},
                {"type": "pc", "name": "PC2", "x": 480, "y": 160},
            ]
        },
        "palette": [],
        "budget": 50,
        "par_cost": 10,
        "par_time": 120,
        "objectives": [
            _ping("PC1 can ping PC2", "PC1", "PC2"),
            _ping("PC2 can ping PC1", "PC2", "PC1"),
        ],
        "hints": [
            "Hover a PC to see its connection dots, then drag from one to the other PC to lay a cable.",
            "Both PCs need addresses in the same subnet, e.g. 192.168.0.1/24 and 192.168.0.2/24.",
            "Select PC1, then type in the terminal: ip set 192.168.0.1/24",
        ],
    },
    {
        "id": "office-lan",
        "order": 2,
        "title": "Office LAN",
        "tagline": "Four desks and one switch.",
        "difficulty": 1,
        "briefing": (
            "The accounting office has four PCs. A PC has only one network card, so "
            "you can't cable them all to each other directly.\n\n"
            "Buy a switch, connect every PC to it, and put them all on 192.168.1.0/24."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "PC1", "x": 60, "y": 60},
                {"type": "pc", "name": "PC2", "x": 520, "y": 60},
                {"type": "pc", "name": "PC3", "x": 60, "y": 320},
                {"type": "pc", "name": "PC4", "x": 520, "y": 320},
            ]
        },
        "palette": ["switch"],
        "budget": 300,
        "par_cost": 190,
        "par_time": 240,
        "objectives": [
            {
                "type": "inSubnet",
                "label": "All PCs are in 192.168.1.0/24",
                "devices": ["PC1", "PC2", "PC3", "PC4"],
                "subnet": "192.168.1.0/24",
            },
            _ping("PC1 can ping PC4", "PC1", "PC4"),
            _ping("PC2 can ping PC3", "PC2", "PC3"),
        ],
        "hints": [
            "Drop a switch in the middle and cable each PC to it.",
            "A switch works at layer 2 and needs no IP address.",
            "Use 192.168.1.1/24 through 192.168.1.4/24. The /24 means the first three numbers identify the network.",
        ],
    },
    {
        "id": "two-subnets",
        "order": 3,
        "title": "Two Subnets",
        "tagline": "Routers connect different networks.",
        "difficulty": 2,
        "briefing": (
            "PC-A lives in 10.0.1.0/24 and PC-B in 10.0.2.0/24. Both are already "
            "configured, and their default gateways point to .1 in their own subnet.\n\n"
            "A switch only forwards traffic inside one subnet. To move traffic between "
            "the two subnets, deploy a router that owns both gateway addresses."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "PC-A", "x": 60, "y": 180, "ifaces": {"eth0": "10.0.1.10/24"}, "gateway": "10.0.1.1"},
                {"type": "pc", "name": "PC-B", "x": 560, "y": 180, "ifaces": {"eth0": "10.0.2.10/24"}, "gateway": "10.0.2.1"},
            ]
        },
        "palette": ["router", "switch"],
        "budget": 700,
        "par_cost": 520,
        "par_time": 300,
        "objectives": [
            _ping("PC-A can ping PC-B", "PC-A", "PC-B"),
            _ping("PC-B can ping PC-A", "PC-B", "PC-A"),
        ],
        "hints": [
            "Cable both PCs to one router. Each cable uses the next free router port (g0/0, g0/1, …).",
            "The router port facing PC-A must be 10.0.1.1/24 and the one facing PC-B must be 10.0.2.1/24.",
            "Select the router and run: ifconfig. It shows which port goes to which PC.",
        ],
    },
    {
        "id": "static-routing",
        "order": 4,
        "title": "Branch Office",
        "tagline": "Teach two routers about each other.",
        "difficulty": 2,
        "briefing": (
            "HQ (10.1.0.0/24) and the branch (10.3.0.0/24) each have a router. "
            "Link the routers with a point-to-point transit network such as 10.2.0.0/30.\n\n"
            "A router only knows the networks it is directly connected to. Add static "
            "routes so each router knows how to reach the other side."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "HQ-PC", "x": 40, "y": 200, "ifaces": {"eth0": "10.1.0.10/24"}, "gateway": "10.1.0.1"},
                {"type": "router", "name": "R1", "x": 220, "y": 200, "ifaces": {"g0/0": "10.1.0.1/24"}},
                {"type": "router", "name": "R2", "x": 460, "y": 200, "ifaces": {"g0/0": "10.3.0.1/24"}},
                {"type": "pc", "name": "BR-PC", "x": 640, "y": 200, "ifaces": {"eth0": "10.3.0.10/24"}, "gateway": "10.3.0.1"},
            ],
            "links": [["R1", "HQ-PC"], ["R2", "BR-PC"]],
        },
        "palette": [],
        "budget": 50,
        "par_cost": 10,
        "par_time": 360,
        "objectives": [
            _ping("HQ-PC can ping BR-PC", "HQ-PC", "BR-PC"),
            _ping("BR-PC can ping HQ-PC", "BR-PC", "HQ-PC"),
        ],
        "hints": [
            "Cable R1 to R2. On both routers the cable lands on g0/1.",
            "Give the transit link 10.2.0.1/30 on R1 g0/1 and 10.2.0.2/30 on R2 g0/1.",
            "Select R1: enable, configure terminal, interface g0/1, ip address 10.2.0.1 255.255.255.252",
            "Still in config mode on R1: ip route 10.3.0.0 255.255.255.0 10.2.0.2. Then add the opposite route on R2.",
            "Check your work with: show ip route (use 'do show ip route' from config mode).",
            "Use 'traceroute BR-PC' from HQ-PC to see where packets stop.",
        ],
    },
    {
        "id": "subnetting",
        "order": 5,
        "title": "Subnetting Challenge",
        "tagline": "One /24, four departments.",
        "difficulty": 3,
        "briefing": (
            "You've been allocated 172.16.0.0/24, and four departments each need their "
            "own isolated subnet.\n\n"
            "Split the /24 into /26 blocks (64 addresses each), give each department "
            "PC its own block, and route between them with a single router."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "SALES", "x": 60, "y": 40},
                {"type": "pc", "name": "DEV", "x": 560, "y": 40},
                {"type": "pc", "name": "HR", "x": 60, "y": 340},
                {"type": "pc", "name": "OPS", "x": 560, "y": 340},
            ]
        },
        "palette": ["router", "switch"],
        "budget": 700,
        "par_cost": 540,
        "par_time": 600,
        "objectives": [
            {
                "type": "inSubnet",
                "label": "Every PC uses 172.16.0.0/24 with a /26 or smaller",
                "devices": ["SALES", "DEV", "HR", "OPS"],
                "subnet": "172.16.0.0/24",
                "minPrefix": 26,
            },
            {
                "type": "distinctSubnets",
                "label": "Each department has its own subnet",
                "devices": ["SALES", "DEV", "HR", "OPS"],
            },
            _ping("SALES can ping OPS", "SALES", "OPS"),
            _ping("DEV can ping HR", "DEV", "HR"),
        ],
        "hints": [
            "The four /26 blocks are 172.16.0.0, .64, .128 and .192.",
            "The first usable host of each block is a natural gateway, e.g. 172.16.0.65/26 for the .64 block.",
            "A router has exactly four ports, one per department. Don't forget each PC's gateway.",
        ],
    },
    {
        "id": "lock-it-down",
        "order": 6,
        "title": "Lock It Down",
        "tagline": "Keep guests away from the server.",
        "difficulty": 3,
        "briefing": (
            "The company runs three networks: staff (192.168.10.0/24), guest Wi-Fi "
            "(192.168.20.0/24) and servers (192.168.30.0/24).\n\n"
            "Staff must reach the server. Guests must reach their gateway, but must "
            "never touch the server over any protocol. A plain router can't enforce that, "
            "so you need a firewall."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "STAFF-PC", "x": 40, "y": 60, "ifaces": {"eth0": "192.168.10.10/24"}, "gateway": "192.168.10.1"},
                {"type": "pc", "name": "GUEST-PC", "x": 40, "y": 320, "ifaces": {"eth0": "192.168.20.10/24"}, "gateway": "192.168.20.1"},
                {"type": "server", "name": "SERVER", "x": 600, "y": 190, "ifaces": {"eth0": "192.168.30.10/24"}, "gateway": "192.168.30.1"},
            ]
        },
        "palette": ["firewall", "router", "switch"],
        "budget": 1000,
        "par_cost": 830,
        "par_time": 480,
        "objectives": [
            _ping("STAFF-PC can ping SERVER", "STAFF-PC", "SERVER"),
            _ping("GUEST-PC can ping its gateway 192.168.20.1", "GUEST-PC", "192.168.20.1"),
            _ping("GUEST-PC cannot ping SERVER", "GUEST-PC", "SERVER", "fail"),
            _tcp("GUEST-PC cannot open TCP/443 on SERVER", "GUEST-PC", "SERVER", 443, "fail"),
        ],
        "hints": [
            "A firewall routes like a router: give each of its three ports the .1 gateway of one network "
            "(enable → conf t → interface g0/0 → ip address 192.168.10.1 255.255.255.0).",
            "Rules are checked top to bottom. Try: fw rule add deny 192.168.20.0/24 192.168.30.0/24",
            "The firewall is stateful, so replies to allowed traffic always come back.",
        ],
    },
    {
        "id": "dmz",
        "order": 7,
        "title": "The DMZ",
        "tagline": "Expose the web server, only on HTTPS.",
        "difficulty": 3,
        "briefing": (
            "FW1 sits between the Internet (203.0.113.0/24), the internal LAN "
            "(10.0.10.0/24) and a DMZ holding the public web server (10.0.50.0/24). "
            "Everything is cabled and addressed.\n\n"
            "Security policy:\n"
            "  • The Internet may reach WEB only on TCP 443.\n"
            "  • The Internet must not reach the LAN at all.\n"
            "  • Admins on the LAN may SSH (TCP 22) into WEB.\n\n"
            "Write the firewall rules. Hint: secure firewalls default to deny."
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "INTERNET", "x": 40, "y": 190, "ifaces": {"eth0": "203.0.113.10/24"}, "gateway": "203.0.113.1"},
                {
                    "type": "firewall",
                    "name": "FW1",
                    "x": 320,
                    "y": 190,
                    "ifaces": {"g0/0": "203.0.113.1/24", "g0/1": "10.0.10.1/24", "g0/2": "10.0.50.1/24"},
                },
                {"type": "pc", "name": "LAN-PC", "x": 600, "y": 60, "ifaces": {"eth0": "10.0.10.10/24"}, "gateway": "10.0.10.1"},
                {"type": "server", "name": "WEB", "x": 600, "y": 320, "ifaces": {"eth0": "10.0.50.10/24"}, "gateway": "10.0.50.1"},
            ],
            "links": [["FW1", "INTERNET"], ["FW1", "LAN-PC"], ["FW1", "WEB"]],
        },
        "palette": [],
        "budget": 0,
        "par_cost": 0,
        "par_time": 420,
        "objectives": [
            _tcp("INTERNET can open TCP/443 on WEB", "INTERNET", "WEB", 443),
            _tcp("INTERNET cannot open TCP/22 on WEB", "INTERNET", "WEB", 22, "fail"),
            _ping("INTERNET cannot ping LAN-PC", "INTERNET", "LAN-PC", "fail"),
            _tcp("LAN-PC can SSH (TCP/22) into WEB", "LAN-PC", "WEB", 22),
        ],
        "hints": [
            "Start with: fw default deny. Then allow only what the policy needs.",
            "fw rule add allow any 10.0.50.10 tcp/443",
            "fw rule add allow 10.0.10.0/24 any lets LAN users start connections. Stateful replies handle the rest.",
            "Test from INTERNET with: tcp WEB 443 and tcp WEB 22",
        ],
    },
    {
        "id": "secure-remote-access",
        "order": 8,
        "title": "Secure Remote Access",
        "tagline": "Lock down R1 and manage it over SSH.",
        "difficulty": 2,
        "briefing": (
            "R1 is the office's edge router and anyone can walk up to its console. "
            "The admin wants to manage it from ADMIN-PC instead, securely.\n\n"
            "Configure R1 from its IOS console:\n"
            "  • Protect privileged mode with an enable secret (hashed, not a plain password).\n"
            "  • Create a local account named admin.\n"
            "  • Turn on the SSH server. It needs a domain name and RSA keys.\n"
            "  • Allow only SSH on the vty lines. Telnet sends passwords in clear text.\n"
            "  • Save the configuration so it survives a reboot.\n\n"
            "Then prove it works: from ADMIN-PC run ssh admin@10.0.0.1"
        ),
        "start": {
            "devices": [
                {"type": "pc", "name": "ADMIN-PC", "x": 60, "y": 200, "ifaces": {"eth0": "10.0.0.10/24"}, "gateway": "10.0.0.1"},
                {"type": "switch", "name": "SW1", "x": 300, "y": 200},
                {"type": "router", "name": "R1", "x": 540, "y": 200, "ifaces": {"g0/0": "10.0.0.1/24"}},
            ],
            "links": [["SW1", "ADMIN-PC"], ["SW1", "R1"]],
        },
        "palette": [],
        "budget": 0,
        "par_cost": 0,
        "par_time": 420,
        "objectives": [
            {"type": "ios", "label": "R1 has an enable secret", "device": "R1", "check": "enableSecret"},
            {"type": "ios", "label": "R1 vty lines accept SSH only", "device": "R1", "check": "sshOnly"},
            {"type": "ssh", "label": "ADMIN-PC can SSH into R1 as admin", "from": "ADMIN-PC", "to": "R1", "user": "admin"},
            {"type": "ios", "label": "R1 configuration is saved", "device": "R1", "check": "saved"},
        ],
        "hints": [
            "Select R1. Type enable, then configure terminal (or conf t). Type ? at any point to list commands.",
            "enable secret <password> and username admin secret <password>",
            "SSH needs keys: ip domain-name lab.local, then crypto key generate rsa modulus 2048, then ip ssh version 2",
            "line vty 0 4, then login local and transport input ssh",
            "Type end, then write memory. From ADMIN-PC: ssh admin@10.0.0.1",
        ],
    },
    {
        "id": "office-wifi",
        "order": 9,
        "title": "Office Wi-Fi",
        "tagline": "Bring two laptops online over a secured wireless network.",
        "difficulty": 2,
        "briefing": (
            "Two new laptops arrived and they have no Ethernet port. AP1 is already "
            "cabled to the office switch, but its radio is not set up.\n\n"
            "Configure AP1 from its console:\n"
            "  • Create the SSID OFFICE and broadcast it so laptops can find it.\n"
            "  • Secure it with WPA2 and a password of at least 8 characters, using AES encryption on the radio.\n"
            "  • Serve OFFICE on Dot11Radio0.\n\n"
            "Then join both laptops to OFFICE and check they can reach the file server."
        ),
        "start": {
            "devices": [
                {"type": "server", "name": "FILES", "x": 60, "y": 60, "ifaces": {"eth0": "192.168.1.10/24"}},
                {"type": "switch", "name": "SW1", "x": 300, "y": 60},
                {"type": "ap", "name": "AP1", "x": 300, "y": 260},
                {"type": "laptop", "name": "LT1", "x": 120, "y": 420, "ifaces": {"wlan0": "192.168.1.21/24"}},
                {"type": "laptop", "name": "LT2", "x": 480, "y": 420, "ifaces": {"wlan0": "192.168.1.22/24"}},
            ],
            "links": [["SW1", "FILES"], ["SW1", "AP1"]],
        },
        "palette": [],
        "budget": 0,
        "par_cost": 0,
        "par_time": 420,
        "objectives": [
            {"type": "ios", "label": "AP1 secures its SSID with WPA2 (AES)", "device": "AP1", "check": "wpa2"},
            {"type": "wifi", "label": "LT1 joined OFFICE", "device": "LT1", "ssid": "OFFICE"},
            {"type": "wifi", "label": "LT2 joined OFFICE", "device": "LT2", "ssid": "OFFICE"},
            _ping("LT1 can ping FILES", "LT1", "FILES"),
            _ping("LT2 can ping FILES", "LT2", "FILES"),
        ],
        "hints": [
            "Select AP1: enable, conf t, then dot11 ssid OFFICE. You are now in (config-ssid) mode.",
            "In the SSID: authentication open, authentication key-management wpa version 2, wpa-psk ascii <password>, guest-mode",
            "exit, then interface Dot11Radio0: encryption mode ciphers aes-ccm, then ssid OFFICE",
            "On LT1: wifi scan, then wifi connect OFFICE <password>. Same on LT2.",
        ],
    },
]

MISSIONS_BY_ID = {m["id"]: m for m in MISSIONS}
