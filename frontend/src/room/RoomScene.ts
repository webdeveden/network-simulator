/**
 * First-person server room. Owns the Three.js renderer, the camera and the
 * input; the Vue side decides what clicks mean (see RoomView.vue).
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { buildCity } from './city'
import { CABLES, getDevice, linkActive, linkOn, portKind } from '../engine/network'
import type { Device, Link, Topology } from '../engine/types'
import { Hands } from './hands'
import { BALCONY, BUILDING, collide, CUBE, freeSpot, isBlocked, DESK, PRINTER, MOUNT_GAP, MOUNT_TOP, panelHeight, roomColor, WALL_RACK, RACK, rackHasRoom, roomLayout, TRAY_Y, roomAt, type Cubicle, type Placement, type RackSpot, type Room, type RoomId, type RoomLayout, type Wall } from './layout'

export type Target =
  | { kind: 'port'; deviceId: string; iface: string }
  | { kind: 'door'; rack: number }
  | { kind: 'device'; deviceId: string }
  | { kind: 'cable'; linkId: string }

export interface RackDrag {
  deviceId: string
  /** Rack gear moves between racks and slots; desk devices move between offices. */
  kind: 'rack' | 'room'
  rack: number | null
  /** Position in the rack, 0 = top. */
  index: number
  /** Office under the cursor, for desk devices. */
  room?: { id: RoomId; label: string } | null
  ok: boolean
}

export interface RoomEvents {
  hover(t: Target | null): void
  lock(locked: boolean): void
  /** Left click. */
  primary(t: Target | null): void
  /** E key or double-click. */
  use(t: Target | null): void
  /** Right click or Q. */
  cancel(): void
  /** A rack device is being dragged: where it would land (rack null = not over a rack). */
  dragging(d: RackDrag | null): void
  /** A dragged rack device was dropped at a valid spot. */
  move(deviceId: string, rack: number, index: number): void
  /** A dragged desk device was dropped in an office. */
  moveToRoom(deviceId: string, room: RoomId): void
  /** The player walked into another room (or the corridor). */
  location(label: string): void
  /** The player turned (heading in radians; 0 = facing north, -z). */
  heading?(h: number): void
  /** Zoomed out to the aerial overview (true) or back to walking (false). */
  overview?(on: boolean): void
  /** What a click would do in the overview ("Click: walk into Sales"), or null. */
  overviewHint?(text: string | null): void
}

const EYE = 1.65
/** How far you can interact: arm's length with the crosshair, further with the free cursor. */
const REACH_FPS = 3.2
const REACH_FREE = 7.5
const LOOK_SPEED = 0.004
/** Third person: radians per second when turning with A/D or the arrow keys. */
const TURN_SPEED = 2.4
/** How far you can look down or up (radians). */
const PITCH_RANGE = { min: -1.3, max: 1.3 }
/** Metres walked per pixel of two-finger scroll. */
const WHEEL_SPEED = 0.006
const WALL_H = BUILDING.height

const COLORS = {
  bg: 0x05080d,
  metal: 0x1a1f28,
  metalLight: 0x2a313d,
  socket: 0x050608,
  cable: 0x2f9bff,
  cableDown: 0xff4d5e,
  cableSel: 0x39ff88,
  ledUp: 0x39ff88,
  ledDown: 0xffb020,
  ledShut: 0xff4d5e,
  accent: 0x22d3ee,
}

const ACCENT_CSS = '#22d3ee'

const TYPE_COLOR: Record<string, string> = {
  router: '#22d3ee',
  switch: '#39ff88',
  firewall: '#ff4d5e',
  server: '#b48cff',
  pc: '#c9d6e8',
  laptop: '#c9d6e8',
  ap: '#39ff88',
}

/** Heading (0 = facing -z) that looks from (x, z) towards (tx, tz). */
const headingTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z))

const portKey = (deviceId: string, iface: string) => `${deviceId}|${iface}`

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

const FONT = "'JetBrains Mono', ui-monospace, monospace"

export class RoomScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: PointerLockControls
  private orbit: OrbitControls
  /** walk: first person; overview: aerial orbit; flying: animating between the two. */
  private mode: 'walk' | 'overview' | 'flying' = 'walk'
  private fly: { fromPos: THREE.Vector3; fromQuat: THREE.Quaternion; toPos: THREE.Vector3; toQuat: THREE.Quaternion; t: number; dur: number; done: () => void } | null = null
  /** Where you were standing before zooming out. */
  private walkPose: { pos: THREE.Vector3; heading: number } | null = null
  private city: THREE.Group | null = null
  private cityKey = ''
  private ceiling = new THREE.Group()
  private overviewDown: { x: number; y: number } | null = null
  private lastOverviewHint: string | null = null
  private world = new THREE.Group()
  private layout: RoomLayout = { placements: [], racks: [], cubicles: [], rooms: [], walls: [], seats: [], corridor: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, obstacles: [], bounds: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, spawn: { x: 0, z: 2 }, home: { x: 0, z: 2, look: [0, 1.2, -3] } }
  private topo: Topology = { devices: [], links: [] }

  private targets: THREE.Object3D[] = []
  private ports = new Map<string, { pos: THREE.Vector3; station: Placement['station'] }>()
  private curves = new Map<string, THREE.CatmullRomCurve3>()
  private cableMeshes = new Map<string, THREE.Mesh>()
  /** Where Wi-Fi links start and end: AP antennas, laptop lids. */
  private radios = new Map<string, THREE.Vector3>()
  private chassis = new Map<string, THREE.MeshStandardMaterial>()
  /** Invisible rack-sized boxes, only for finding the rack under a drop. */
  private rackBodies: THREE.Object3D[] = []
  private doors = new Map<number, THREE.Object3D>()
  private openDoors = new Set<number>()

  private hover: Target | null = null
  private hoverBox = new THREE.BoxHelper(new THREE.Object3D(), COLORS.accent)
  private carryFrom: string | null = null
  private carryMesh: THREE.Mesh | null = null
  private carryColor = '#39ff88'
  private packet: { curve: THREE.CatmullRomCurve3; start: number; dur: number; forward: boolean; mesh: THREE.Mesh } | null = null
  private flash: Record<string, 'ok' | 'err' | 'hit'> = {}
  private selection: { kind: 'device' | 'link' | 'rack'; id: string } | null = null

  private keys = new Set<string>()
  private where = ''
  private lastHeading = Infinity
  /** Street-View style navigation: a heading to swing round to, a floor spot to walk to, held pad buttons. */
  private turnGoal: number | null = null
  private walkGoal: { x: number; z: number } | null = null
  private pad = new Set<'fwd' | 'back' | 'left' | 'right'>()
  /** You: feet position, facing (heading 0 looks down -z) and how far you look up or down. */
  private player = { pos: new THREE.Vector3(), heading: 0, pitch: 0 }
  private hands = new Hands()
  private raycaster = new THREE.Raycaster()
  private clock = new THREE.Clock()
  private raf = 0
  private resize: ResizeObserver
  private placed = false

  private container: HTMLElement
  private events: RoomEvents

  constructor(container: HTMLElement, events: RoomEvents) {
    this.container = container
    this.events = events
    // Logarithmic depth: the city stretches hundreds of metres, the ports are centimetres.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.25
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 900)
    this.camera.position.set(0, EYE, 3)
    this.scene.background = new THREE.Color(COLORS.bg)
    this.scene.fog = new THREE.Fog(COLORS.bg, 45, 170)
    this.scene.add(this.world)
    this.hoverBox.visible = false
    this.scene.add(this.hoverBox)
    this.dropBar.visible = false
    this.scene.add(this.dropBar)
    this.roomGlow.rotation.x = -Math.PI / 2
    this.roomGlow.visible = false
    this.scene.add(this.roomGlow)
    this.raycaster.far = REACH_FREE

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.enabled = false
    this.orbit.enableDamping = true
    this.orbit.minDistance = 10
    this.orbit.maxDistance = 260
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.06
    this.controls = new PointerLockControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('lock', () => {
      // First person: eyes where the engineer's eyes are, looking where they face.
      this.camera.position.copy(this.player.pos).setY(EYE)
      this.camera.quaternion.setFromEuler(new THREE.Euler(0, this.player.heading, 0, 'YXZ'))
      this.events.lock(true)
    })
    this.controls.addEventListener('unlock', () => {
      this.keys.clear()
      this.events.lock(false)
    })

    const canvas = this.renderer.domElement
    // Focusable, so clicking the room takes keyboard focus away from console windows.
    canvas.tabIndex = 0
    canvas.style.outline = 'none'
    canvas.addEventListener('mousedown', this.onMouseDown)
    canvas.addEventListener('mousemove', this.onCanvasMove)
    // Also on enter: a console window closing under a still cursor fires no mousemove.
    canvas.addEventListener('mouseover', this.onCanvasMove)
    canvas.addEventListener('mouseleave', this.onCanvasLeave)
    canvas.addEventListener('dblclick', this.onDoubleClick)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('mousemove', this.onLookMove)
    window.addEventListener('mouseup', this.onLookEnd)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)

    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(container)
    this.fit()
    this.loop()
  }

  // ---------- public API ----------

  lock() {
    this.controls.lock()
  }

  unlock() {
    this.controls.unlock()
  }

  /** The outside world, rebuilt only when the building's outline changes (not on every edit). */
  private ensureCity() {
    const b = this.layout.bounds
    const doors = this.layout.rooms.filter((r) => r.kind === 'balcony').map((r) => r.doorX.toFixed(2))
    const key = [b.minX, b.maxX, b.minZ, b.maxZ].map((v) => v.toFixed(2)).join() + doors.join()
    if (key === this.cityKey) return
    if (this.city) {
      this.disposeGroup(this.city)
      this.scene.remove(this.city)
    }
    const core = { ...b, maxZ: this.layout.corridor.maxZ + BUILDING.wallT / 2 }
    const openings = this.layout.rooms.filter((r) => r.kind === 'balcony').map((r) => ({ x0: r.doorX - BALCONY.door / 2, x1: r.doorX + BALCONY.door / 2 }))
    this.city = buildCity({ building: core, height: WALL_H, entrance: { x: b.minX, z: this.layout.corridor.maxZ / 2 }, southOpenings: openings, extraZ: b.maxZ - core.maxZ })
    this.scene.add(this.city)
    this.cityKey = key
  }

  get inOverview() {
    return this.mode !== 'walk'
  }

  /** Zoom out: fly up to an aerial view of the whole company, roof off. */
  enterOverview() {
    if (this.mode !== 'walk') return
    if (this.controls.isLocked) this.controls.unlock()
    this.walkPose = { pos: this.player.pos.clone(), heading: this.player.heading }
    const b = this.layout.bounds
    const target = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2)
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ)
    const pos = new THREE.Vector3(target.x - size * 0.15, size * 0.75 + 8, b.maxZ + size * 0.65)
    this.setOverviewLook(true)
    this.events.overview?.(true)
    this.flyTo(pos, target, 1.1, () => {
      this.mode = 'overview'
      this.orbit.target.copy(target)
      this.orbit.enabled = true
      this.orbit.update()
    })
  }

  /** Zoom back in: to where you were, or to a spot you clicked (looking into the room). */
  exitOverview(to?: { x: number; z: number; heading?: number }) {
    if (this.mode !== 'overview') return
    this.orbit.enabled = false
    this.events.overviewHint?.(null)
    if (to) this.placePlayer(to.x, to.z, to.heading ?? 0)
    else if (this.walkPose) this.placePlayer(this.walkPose.pos.x, this.walkPose.pos.z, this.walkPose.heading)
    else this.goHome()
    const { pos, quat } = this.eyePose()
    this.flyToQuat(pos, quat, 1.0, () => {
      this.mode = 'walk'
      this.setOverviewLook(false)
      this.events.overview?.(false)
    })
  }

  /** Ceiling, fog and sky for each mode: tight and indoor, or wide open over the city. */
  private setOverviewLook(on: boolean) {
    this.ceiling.visible = !on
    const fog = this.scene.fog as THREE.Fog
    fog.near = on ? 180 : 45
    fog.far = on ? 700 : 170
    ;(this.scene.background as THREE.Color).setHex(on ? 0x0b1322 : COLORS.bg)
    this.hoverBox.visible = false
    if (on && this.hover) this.setHover(null, null)
  }

  private lookQuat(from: THREE.Vector3, at: THREE.Vector3): THREE.Quaternion {
    const cam = new THREE.PerspectiveCamera()
    cam.position.copy(from)
    cam.lookAt(at)
    return cam.quaternion.clone()
  }

  private flyTo(pos: THREE.Vector3, at: THREE.Vector3, dur: number, done: () => void) {
    this.flyToQuat(pos, this.lookQuat(pos, at), dur, done)
  }

  private flyToQuat(pos: THREE.Vector3, quat: THREE.Quaternion, dur: number, done: () => void) {
    this.mode = 'flying'
    this.fly = { fromPos: this.camera.position.clone(), fromQuat: this.camera.quaternion.clone(), toPos: pos.clone(), toQuat: quat.clone(), t: 0, dur, done }
  }

  private animateFly(dt: number) {
    const f = this.fly
    if (!f) return
    f.t = Math.min(1, f.t + dt / f.dur)
    const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2 // ease in-out
    this.camera.position.lerpVectors(f.fromPos, f.toPos, e)
    this.camera.quaternion.slerpQuaternions(f.fromQuat, f.toQuat, e)
    if (f.t >= 1) {
      this.fly = null
      f.done()
    }
  }

  /** Overview: the spot a click would take you to, or null if it isn't inside the building. */
  private overviewSpot(): { x: number; z: number; label: string } | null {
    if (!this.pointer) return null
    this.raycaster.far = 2000
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const p = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())
    const b = this.layout.bounds
    if (!p || p.x < b.minX + 0.4 || p.x > b.maxX - 0.4 || p.z < b.minZ + 0.4 || p.z > b.maxZ - 0.4) return null
    // Furniture or a wall there: find the nearest free spot on a small spiral.
    const free = (x: number, z: number) => collide(this.layout, x - 0.01, z, 0.01, 0).x === x
    for (let rad = 0; rad <= 2; rad += 0.25)
      for (let a = 0; a < Math.PI * 2; a += rad ? Math.PI / 8 : 7) {
        const x = p.x + Math.cos(a) * rad
        const z = p.z + Math.sin(a) * rad
        if (free(x, z)) return { x, z, label: roomAt(this.layout, x, z)?.label ?? 'the corridor' }
      }
    return null
  }

  /** Back to the starting view: close up in front of rack 1, its door open. */
  resetView() {
    if (this.mode === 'overview') {
      this.walkPose = null
      return this.exitOverview()
    }
    this.goHome()
  }

  /** Takes you just inside a room, facing into it (the server room: in front of rack 1). */
  goToRoom(id: string) {
    const r = this.layout.rooms.find((x) => x.id === id)
    if (!r) return
    let spot: { x: number; z: number; heading: number }
    // Server room: just inside the door, looking in: admin desks ahead, racks behind them.
    if (r.kind === 'racks') spot = { x: r.doorX, z: -0.6, heading: 0 }
    else if (r.kind === 'balcony') spot = { x: r.doorX, z: r.z0 + 1.0, heading: Math.PI }
    else spot = { x: r.doorX, z: -1.0, heading: 0 }
    if (this.mode === 'overview') return this.exitOverview(spot)
    this.placePlayer(spot.x, spot.z, spot.heading)
    // Server room: look down a little so the admin desk ahead is in full view.
    if (r.kind === 'racks') this.player.pitch = -0.32
  }

  /** Takes you in front of a device, facing it (looking up at ceiling APs, down at laps). */
  /** Stands in front of a rack, facing it, with its door open. */
  goToRack(index: number) {
    const r = this.layout.racks.find((x) => x.index === index)
    if (!r) return
    this.openDoors.add(index)
    const spot = freeSpot(this.layout, r.x, r.z + 1.1, { x: r.x, z: r.z })
    const heading = headingTo(spot.x, spot.z, r.x, r.z)
    if (this.mode === 'overview') return this.exitOverview({ x: spot.x, z: spot.z, heading })
    this.placePlayer(spot.x, spot.z, heading)
    this.player.pitch = r.kind === 'wall' ? -0.15 : -0.1
  }

  goToDevice(id: string) {
    const p = this.layout.placements.find((x) => x.deviceId === id)
    if (!p) return
    const y = p.panel.y
    // Every device faces +z: stand in front of it (further back for things up high).
    const back = p.station === 'ceiling' || p.station === 'wall' ? 2.2 : p.station === 'rack' ? 1.0 : 1.2
    // Ceiling APs hang just inside the office door: stand further in the room, looking up at it.
    const sz = p.station === 'ceiling' ? p.panel.z - 1.6 : p.panel.z + back
    const spot = freeSpot(this.layout, p.panel.x, sz, { x: p.panel.x, z: p.panel.z })
    if (p.rack !== undefined) this.openDoors.add(p.rack)
    const go = () => {
      this.placePlayer(spot.x, spot.z, headingTo(spot.x, spot.z, p.panel.x, p.panel.z))
      this.player.pitch = Math.max(-1.0, Math.min(1.0, Math.atan2(y - EYE, Math.hypot(spot.x - p.panel.x, spot.z - p.panel.z))))
    }
    if (this.mode === 'overview') {
      this.exitOverview({ x: spot.x, z: spot.z, heading: headingTo(spot.x, spot.z, p.panel.x, p.panel.z) })
      return
    }
    go()
  }

  /** Swing round smoothly to face this heading (0 = north). */
  turnTo(heading: number) {
    // Shortest way round.
    let d = (heading - this.player.heading) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    this.turnGoal = this.player.heading + d
  }

  /** Turn by an angle right now (dragging the compass). */
  turnBy(delta: number) {
    this.turnGoal = null
    this.player.heading += delta
  }

  /** Compass arrow pad: held buttons move you until released. */
  setPad(dir: 'fwd' | 'back' | 'left' | 'right', on: boolean) {
    if (on) {
      this.pad.add(dir)
      this.walkGoal = null
      this.turnGoal = null
    } else this.pad.delete(dir)
  }

  /** Walk to a floor spot in a straight line (walls and furniture stop you). */
  walkTo(x: number, z: number) {
    this.walkGoal = { x, z }
    this.turnGoal = null
  }

  /** Which way you face, in radians clockwise from north (north = towards the back of the building). */
  get compassHeading() {
    return -this.player.heading
  }

  /** Rooms you can go to, in building order. */
  get roomList() {
    return this.layout.rooms.map((r) => ({ id: r.id, label: r.label, kind: r.kind }))
  }

  /** In front of rack 1 (or the first cubicle), facing it, its door open. */
  private goHome() {
    const h = this.layout.home
    this.placePlayer(h.x, h.z, headingTo(h.x, h.z, h.look[0], h.look[2]))
    if (h.rack !== undefined) this.openDoors.add(h.rack)
  }

  private placePlayer(x: number, z: number, heading: number) {
    this.player.pos.set(x, 0, z)
    this.player.heading = heading
    this.player.pitch = 0
    if (this.controls.isLocked) {
      this.camera.position.set(x, EYE, z)
      this.camera.quaternion.setFromEuler(new THREE.Euler(0, heading, 0, 'YXZ'))
    }
  }

  /** Puts the player at (x, z) facing a point. Used by `?debug` scripted tests. */
  teleport(x: number, z: number, look: [number, number, number]) {
    this.placePlayer(x, z, headingTo(x, z, look[0], look[2]))
  }

  get locked() {
    return this.controls.isLocked
  }

  /** Rebuilds the room from the topology. Cheap enough to call on every structural change. */
  sync(topo: Topology) {
    this.topo = topo
    this.layout = roomLayout(topo)
    this.disposeGroup(this.world)
    this.world.clear()
    this.targets = []
    this.ports.clear()
    this.curves.clear()
    this.cableMeshes.clear()
    this.radios.clear()
    this.chassis.clear()
    this.doors.clear()
    this.rackBodies = []

    this.buildRoom()
    this.ensureCity()
    for (const r of this.layout.racks) this.buildRack(r)
    for (const c of this.layout.cubicles) this.buildCubicle(c)
    for (const p of this.layout.placements) {
      const d = getDevice(topo, p.deviceId)
      if (!d) continue
      if (p.station === 'rack') {
        const g = new THREE.Group()
        this.buildChassis(g, d, p, 0.4)
        this.world.add(g)
      } else if (p.station === 'printer') this.buildPrinter(d, p)
      else if (p.station === 'phone') this.buildPhone(d, p)
      else if (p.station === 'lounge') this.buildLounge(d, p)
      else if (p.station === 'ceiling') this.buildCeilingAp(d, p)
      else if (p.station === 'held') this.buildHeld(d, p)
      else if (p.station === 'wall') this.buildWallAp(d, p)
      else this.buildDesk(d, p)
    }
    topo.links.forEach((l, i) => (l.wifi ? this.buildWifi(l.id) : this.buildCable(l.id, i)))
    if (this.carryFrom && !this.ports.has(this.carryFrom)) this.setCarry(null)

    if (!this.placed) {
      this.resetView()
      this.placed = true
    } else {
      // New furniture where you stand: step aside to the nearest free spot (not back to the start).
      const { x, z } = this.player.pos
      if (isBlocked(this.layout, x, z)) {
        const spot = freeSpot(this.layout, x, z)
        this.player.pos.set(spot.x, 0, spot.z)
      }
    }
    this.applyHighlights()
    this.hover = null
    this.hoverBox.visible = false
  }

  setFlash(flash: Record<string, 'ok' | 'err' | 'hit'>) {
    this.flash = flash
    this.applyHighlights()
  }

  setSelection(sel: { kind: 'device' | 'link' | 'rack'; id: string } | null) {
    this.selection = sel
    this.applyHighlights()
  }

  /** Shows a loose cable (in `color`) from this port to the player's hand. */
  setCarry(from: { deviceId: string; iface: string } | null, color = '#39ff88') {
    this.carryFrom = from ? portKey(from.deviceId, from.iface) : null
    this.carryColor = color
    this.hands.setCarrying(from ? color : null)
    if (!this.carryFrom && this.carryMesh) {
      this.world.remove(this.carryMesh)
      this.carryMesh.geometry.dispose()
      this.carryMesh = null
    }
  }

  playPacket(linkId: string, forward: boolean, color: string, ms: number) {
    const curve = this.curves.get(linkId)
    if (!curve) return
    if (!this.packet) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 16, 12),
        new THREE.MeshBasicMaterial({ color, toneMapped: false }),
      )
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 16, 12),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false }),
      )
      mesh.add(glow)
      this.scene.add(mesh)
      this.packet = { curve, start: 0, dur: ms, forward, mesh }
    }
    this.packet.curve = curve
    this.packet.forward = forward
    this.packet.dur = ms
    this.packet.start = performance.now()
    ;(this.packet.mesh.material as THREE.MeshBasicMaterial).color.set(color)
    ;((this.packet.mesh.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color)
    this.packet.mesh.visible = true
  }

  stopPacket() {
    if (this.packet) this.packet.mesh.visible = false
  }

  toggleDoor(rack: number) {
    if (this.openDoors.has(rack)) this.openDoors.delete(rack)
    else this.openDoors.add(rack)
  }

  openDoor(rack: number) {
    this.openDoors.add(rack)
  }

  isDoorOpen(rack: number) {
    return this.openDoors.has(rack)
  }

  /** The rack under a screen point (for drag-and-drop), if any. */
  rackAt(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect()
    const at = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.far = 40
    this.raycaster.setFromCamera(at, this.camera)
    const hit = this.raycaster.intersectObjects([...this.targets, ...this.rackBodies], false)[0]
    const t = hit?.object.userData.target as Target | undefined
    if (t?.kind === 'door') return t.rack
    if (t?.kind === 'device' || t?.kind === 'port') return this.layout.placements.find((p) => p.deviceId === t.deviceId)?.rack ?? null
    return (hit?.object.userData.rack as number | undefined) ?? null
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resize.disconnect()
    this.controls.unlock()
    this.controls.dispose()
    this.orbit.dispose()
    window.removeEventListener('mousemove', this.onLookMove)
    window.removeEventListener('mouseup', this.onLookEnd)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.disposeGroup(this.scene)
    this.hands.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ---------- input ----------

  /** Mouse position in normalized device coordinates, while it is over the room. */
  private pointer: THREE.Vector2 | null = null
  /** Free mode: right-drag or Alt+drag turns the camera. */
  private looking = false

  /**
   * Whether keys move you. In FPS mode always. In free mode when the room has
   * focus or the mouse is over it, but never while you're typing: a console
   * window, a text field. (A focused button, like the 3D toggle, doesn't count.)
   */
  private roomActive(): boolean {
    if (this.controls.isLocked) return true
    const a = document.activeElement as HTMLElement | null
    const typing = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)
    if (typing) return false
    return a === this.renderer.domElement || this.pointer !== null
  }

  private onCanvasMove = (e: MouseEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pointer = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  private onCanvasLeave = () => {
    this.pointer = null
  }

  /** Pressed on a rack device: becomes a drag once the mouse moves a few pixels. */
  private press: { deviceId: string; x: number; y: number; kind: 'rack' | 'room' } | null = null
  private drag: RackDrag | null = null
  /** Shows where a dragged device would be inserted. */
  private dropBar = new THREE.Mesh(
    new THREE.BoxGeometry(RACK.w - 0.08, 0.012, 0.02),
    new THREE.MeshBasicMaterial({ color: COLORS.ledUp, toneMapped: false }),
  )

  private onMouseDown = (e: MouseEvent) => {
    if (this.mode === 'flying') return
    if (this.mode === 'overview') {
      if (e.button === 0) this.overviewDown = { x: e.clientX, y: e.clientY }
      return
    }
    if (this.controls.isLocked) {
      if (e.button === 0 && this.hover?.kind === 'port') this.hands.reach()
      if (e.button === 0) this.events.primary(this.hover)
      else if (e.button === 2) this.events.cancel()
      return
    }
    this.renderer.domElement.focus()
    if (e.button === 2 || (e.button === 0 && e.altKey)) {
      this.looking = true
      this.renderer.domElement.style.cursor = 'grabbing'
      e.preventDefault()
      return
    }
    if (e.button === 0 && !this.hover && this.pointer) {
      // Clicking the floor walks you there, like Street View's ground arrows.
      this.raycaster.far = 40
      this.raycaster.setFromCamera(this.pointer, this.camera)
      const floor = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())
      if (floor && floor.distanceTo(this.player.pos) < 15) this.walkTo(floor.x, floor.z)
    }
    if (e.button === 0) {
      const t = this.hover
      // The hand only comes out for cable work: taking, plugging or unplugging at a port.
      if (t?.kind === 'port') this.reachTowardsPointer()
      const station = t?.kind === 'device' ? this.layout.placements.find((p) => p.deviceId === t.deviceId)?.station : undefined
      if (t?.kind === 'device' && station) this.press = { deviceId: t.deviceId, x: e.clientX, y: e.clientY, kind: station === 'rack' ? 'rack' : 'room' }
      this.events.primary(t)
    }
  }

  private onLookMove = (e: MouseEvent) => {
    if (this.press) {
      if (!this.drag && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 6) {
        this.drag = { deviceId: this.press.deviceId, kind: this.press.kind, rack: null, index: 0, ok: false }
        this.renderer.domElement.style.cursor = 'grabbing'
      }
      if (this.drag) {
        if (this.drag.kind === 'rack') this.updateDrag(e.clientX, e.clientY)
        else this.updateRoomDrag(e.clientX, e.clientY)
      }
      return
    }
    if (!this.looking) return
    // Right-drag turns the engineer (the camera swings round behind) and tilts the view.
    this.player.heading -= e.movementX * LOOK_SPEED
    this.player.pitch = Math.max(PITCH_RANGE.min, Math.min(PITCH_RANGE.max, this.player.pitch - e.movementY * LOOK_SPEED))
  }

  private onLookEnd = (e?: MouseEvent) => {
    // Overview: a click (not an orbit drag) on the building walks you there.
    if (this.overviewDown && e) {
      const moved = Math.hypot(e.clientX - this.overviewDown.x, e.clientY - this.overviewDown.y)
      this.overviewDown = null
      if (moved < 5 && this.mode === 'overview') {
        const spot = this.overviewSpot()
        if (spot) this.exitOverview(spot)
      }
      return
    }
    if (this.press) {
      const d = this.drag
      this.press = null
      this.drag = null
      this.dropBar.visible = false
      this.roomGlow.visible = false
      this.renderer.domElement.style.cursor = ''
      this.applyHighlights()
      if (d) {
        this.events.dragging(null)
        if (d.ok && d.kind === 'rack' && d.rack !== null) this.events.move(d.deviceId, d.rack, d.index)
        if (d.ok && d.kind === 'room' && d.room) this.events.moveToRoom(d.deviceId, d.room.id)
      }
      return
    }
    if (!this.looking) return
    this.looking = false
    this.renderer.domElement.style.cursor = ''
  }

  /**
   * Two-finger swipe (or mouse wheel) walks, like the arrow keys. With macOS natural
   * scrolling, fingers up gives deltaY > 0 and fingers left gives deltaX > 0, so the
   * room moves the way the fingers do. Pinch (ctrl+wheel) is swallowed so the page
   * doesn't zoom.
   */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (this.mode === 'overview') {
      // OrbitControls zooms; pushing in past the closest distance walks back in.
      if (e.deltaY < 0 && this.camera.position.distanceTo(this.orbit.target) <= this.orbit.minDistance + 0.5) this.exitOverview()
      return
    }
    if (this.mode !== 'walk') return
    if (e.ctrlKey) {
      // Pinch out (or ctrl+scroll down) zooms out to the overview.
      if (e.deltaY > 4) this.enterOverview()
      return
    }
    if (this.drag) return
    const scale = (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) * WHEEL_SPEED
    const clamp = (v: number) => Math.max(-0.3, Math.min(0.3, v))
    // Swipe up/down walks; left/right turns (in first person it steps sideways).
    if (this.controls.isLocked) this.step(clamp(e.deltaY * scale), clamp(-e.deltaX * scale))
    else {
      this.step(clamp(e.deltaY * scale), 0)
      this.player.heading += clamp(e.deltaX * scale) * 1.2
    }
  }

  /** Reach towards the cursor (free mode) or straight ahead (FPS). */
  private reachTowardsPointer() {
    if (this.controls.isLocked || !this.pointer) return this.hands.reach()
    this.hands.reach(new THREE.Vector3(this.pointer.x * 0.6, this.pointer.y * 0.45, -1))
  }

  private onDoubleClick = () => {
    if (!this.controls.isLocked && this.hover) this.events.use(this.hover)
  }

  private onBlur = () => {
    this.keys.clear()
    this.onLookEnd()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.roomActive() || e.ctrlKey || e.metaKey) return
    const k = e.key.toLowerCase()
    if ((k === 'o' || k === '-' || k === '+' || k === '=') && !e.repeat) {
      if (this.mode === 'walk' && k !== '+' && k !== '=') this.enterOverview()
      else if (this.mode === 'overview' && k !== '-') this.exitOverview()
      e.preventDefault()
      return
    }
    if (this.mode !== 'walk') {
      if (k === 'r' && !e.repeat) this.resetView()
      return
    }
    if (k === 'e') {
      // The console takes focus right away; don't let this E land in it.
      e.preventDefault()
      this.events.use(this.hover)
    } else if (k === 'q') this.events.cancel()
    else if (k === 'r' && !e.repeat) this.resetView()
    else if (k === 'f' && !e.repeat) {
      if (this.controls.isLocked) this.controls.unlock()
      else this.controls.lock()
    } else {
      this.keys.add(e.code)
      this.walkGoal = null
      this.turnGoal = null
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
  }

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code)

  private fit() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ---------- frame loop ----------

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    this.animateFly(dt)
    if (this.mode === 'overview') this.orbit.update()
    if (this.mode === 'walk' && this.roomActive()) this.move(dt)
    else if (this.mode !== 'walk' || !this.roomActive()) this.keys.clear()
    if (this.mode === 'walk') this.navigate(dt)
    if (this.mode === 'walk') this.updateCamera()
    this.animateDoors(dt)
    this.pick()
    this.animateCarry()
    this.animatePacket()
    const where = this.mode !== 'walk' ? 'Overview' : (roomAt(this.layout, this.player.pos.x, this.player.pos.z)?.label ?? 'Corridor')
    if (Math.abs(this.player.heading - this.lastHeading) > 0.01) this.events.heading?.((this.lastHeading = this.player.heading))
    if (where !== this.where) this.events.location((this.where = where))
    this.hands.update(this.camera, dt, this.controls.isLocked ? null : this.pointer)
    this.renderer.autoClear = true
    this.renderer.render(this.scene, this.camera)
    if (this.hands.showing && this.mode === 'walk') {
      // Draw the hand over everything: clear depth so walls and racks can't cut through it.
      this.renderer.autoClear = false
      this.renderer.clearDepth()
      this.renderer.render(this.hands.scene, this.camera)
    }
  }

  /** First person: eyes above the player's feet, looking along heading and pitch. */
  private eyePose(): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const pos = this.player.pos.clone().setY(EYE)
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.player.pitch, this.player.heading, 0, 'YXZ'))
    return { pos, quat }
  }

  private updateCamera() {
    this.camera.position.copy(this.player.pos).setY(EYE)
    if (this.controls.isLocked) {
      // FPS mode: the captured mouse turns the camera; walking follows its heading.
      const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(this.camera.quaternion)
      this.player.heading = e.y
      this.player.pitch = e.x
      return
    }
    this.camera.quaternion.copy(this.eyePose().quat)
  }

  /** Compass pad, smooth turns and click-to-walk. */
  private navigate(dt: number) {
    const p = this.pad
    const turn = (p.has('left') ? 1 : 0) - (p.has('right') ? 1 : 0)
    if (turn) this.player.heading += turn * TURN_SPEED * dt
    const f = (p.has('fwd') ? 1 : 0) - (p.has('back') ? 1 : 0)
    if (f) this.step(f * 2.2 * dt, 0)
    if (this.turnGoal !== null) {
      const d = this.turnGoal - this.player.heading
      if (Math.abs(d) < 0.01) {
        this.player.heading = this.turnGoal
        this.turnGoal = null
      } else this.player.heading += d * Math.min(1, dt * 7)
    }
    if (this.walkGoal) {
      const g = this.walkGoal
      const dx = g.x - this.player.pos.x
      const dz = g.z - this.player.pos.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.12) this.walkGoal = null
      else {
        // Face the way you walk, then go; stop if something is in the way.
        this.player.heading += ((headingTo(0, 0, dx, dz) - this.player.heading + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 8)
        const before = this.player.pos.clone()
        const s = Math.min(dist, 3 * dt)
        const steps = Math.ceil(s / 0.1)
        for (let k = 0; k < steps; k++) {
          const q = collide(this.layout, this.player.pos.x, this.player.pos.z, (dx / dist) * (s / steps), (dz / dist) * (s / steps))
          this.player.pos.set(q.x, 0, q.z)
        }
        if (this.player.pos.distanceTo(before) < s * 0.3) this.walkGoal = null
      }
    }
  }

  private move(dt: number) {
    const k = this.keys
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    if (!f && !r) return
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 2.2) * dt
    if (this.controls.isLocked) {
      // First person: A/D step sideways, the mouse turns.
      const len = Math.hypot(f, r)
      this.step((f / len) * speed, (r / len) * speed)
    } else {
      // Third person: A/D turn the engineer, W/S walk where they face.
      this.player.heading -= r * TURN_SPEED * dt
      if (f) this.step(f * speed, 0)
    }
  }

  /** Walks `forward` and `right` metres relative to where the engineer faces, with collisions. */
  private step(forward: number, right: number) {
    const h = this.player.heading
    const v = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h)).multiplyScalar(forward).add(new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)).multiplyScalar(right))
    // Small sub-steps so a fast swipe can't jump through a thin wall.
    const n = Math.ceil(v.length() / 0.1) || 1
    for (let k = 0; k < n; k++) {
      const p = collide(this.layout, this.player.pos.x, this.player.pos.z, v.x / n, v.z / n)
      this.player.pos.set(p.x, 0, p.z)
    }
  }

  private animateDoors(dt: number) {
    for (const [id, pivot] of this.doors) {
      const goal = this.openDoors.has(id) ? -1.95 : 0
      pivot.rotation.y += (goal - pivot.rotation.y) * Math.min(1, dt * 8)
    }
  }

  /** Floor highlight for the office a desk device would move to. */
  private roomGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: COLORS.ledUp, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }),
  )

  /** Desk devices: which office the cursor's floor point is in, highlighted on the floor. */
  private updateRoomDrag(clientX: number, clientY: number) {
    const drag = this.drag!
    const r = this.renderer.domElement.getBoundingClientRect()
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera)
    const floor = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())
    const room = floor ? roomAt(this.layout, floor.x, floor.z) : undefined
    drag.room = room ? { id: room.id, label: room.label } : null
    drag.ok = room?.kind === 'office'
    if (room) {
      this.roomGlow.scale.set(room.x1 - room.x0, room.z1 - room.z0, 1)
      this.roomGlow.position.set((room.x0 + room.x1) / 2, 0.012, (room.z0 + room.z1) / 2)
      ;(this.roomGlow.material as THREE.MeshBasicMaterial).color.setHex(drag.ok ? COLORS.ledUp : COLORS.ledShut)
      this.roomGlow.visible = true
    } else this.roomGlow.visible = false
    this.applyHighlights()
    this.events.dragging({ ...drag })
  }

  /** Works out which rack and slot the cursor points at, and draws the insertion line. */
  private updateDrag(clientX: number, clientY: number) {
    const drag = this.drag!
    const rack = this.rackAt(clientX, clientY)
    const spot = rack === null ? undefined : this.layout.racks.find((r) => r.index === rack)
    if (!spot) {
      Object.assign(drag, { rack: null, ok: false })
      this.dropBar.visible = false
      this.events.dragging({ ...drag })
      return
    }
    const others = this.layout.placements.filter((p) => p.rack === spot.index && p.deviceId !== drag.deviceId)
    // Height the cursor points at, on the rack's front plane.
    const r = this.renderer.domElement.getBoundingClientRect()
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera)
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -(spot.z - 0.06)), new THREE.Vector3())
    const y = hit?.y ?? 0
    const index = others.filter((p) => p.panel.y > y).length
    const above = others[index - 1]
    const below = others[index]
    const barY = above
      ? above.panel.y - above.panel.h / 2 - MOUNT_GAP / 2
      : below
        ? below.panel.y + below.panel.h / 2 + MOUNT_GAP / 2
        : MOUNT_TOP
    const dev = getDevice(this.topo, drag.deviceId)
    const ok = !!dev && rackHasRoom([...others.map((p) => p.panel.h), panelHeight(dev.type)])
    Object.assign(drag, { rack: spot.index, index, ok })
    this.dropBar.position.set(spot.x, barY, spot.z - 0.03)
    ;(this.dropBar.material as THREE.MeshBasicMaterial).color.setHex(ok ? COLORS.ledUp : COLORS.ledShut)
    this.dropBar.visible = true
    this.applyHighlights()
    this.events.dragging({ ...drag })
  }

  private pick() {
    if (this.mode !== 'walk') {
      if (this.mode === 'overview') {
        const spot = this.overviewSpot()
        const text = spot ? `Click: walk into ${spot.label}` : null
        if (text !== this.lastOverviewHint) this.events.overviewHint?.((this.lastOverviewHint = text))
        this.renderer.domElement.style.cursor = spot ? 'pointer' : ''
      }
      return
    }
    if (this.drag) {
      if (this.hover) this.setHover(null, null)
      return
    }
    const fps = this.controls.isLocked
    // FPS aims with the crosshair; free mode with the cursor (nothing while dragging to look).
    const at = fps ? new THREE.Vector2(0, 0) : this.looking ? null : this.pointer
    if (!at) {
      if (this.hover) this.setHover(null, null)
      return
    }
    this.raycaster.far = fps ? REACH_FPS : REACH_FREE
    this.raycaster.setFromCamera(at, this.camera)
    const cursor = !fps && this.hover ? 'pointer' : ''
    if (this.renderer.domElement.style.cursor !== cursor && !this.looking) this.renderer.domElement.style.cursor = cursor
    // A cable rising out of a port should not steal the click: close behind the
    // nearest hit, prefer ports, then doors, then devices.
    const hits = this.raycaster.intersectObjects(this.targets, false)
    const near = hits.filter((h) => h.distance <= (hits[0]?.distance ?? 0) + 0.3)
    const rank = (h: THREE.Intersection) => ['port', 'door', 'device', 'cable'].indexOf((h.object.userData.target as Target).kind)
    const hit = near.sort((a, b) => rank(a) - rank(b))[0]
    const t = (hit?.object.userData.target as Target | undefined) ?? null
    if (JSON.stringify(t) !== JSON.stringify(this.hover)) this.setHover(t, hit?.object ?? null)
  }

  private setHover(t: Target | null, obj: THREE.Object3D | null) {
    this.hover = t
    if (obj && t?.kind !== 'cable') {
      this.hoverBox.setFromObject(obj)
      this.hoverBox.visible = true
    } else this.hoverBox.visible = false
    this.applyHighlights()
    this.events.hover(t)
  }

  private animateCarry() {
    if (!this.carryFrom) return
    const from = this.ports.get(this.carryFrom)
    if (!from) return
    // The loose end is the plug in the engineer's hand; in first person it hangs in front of you.
    let hand: THREE.Vector3
    if (this.mode === 'walk') hand = this.hands.plugWorld()
    else {
      const dir = new THREE.Vector3()
      this.camera.getWorldDirection(dir)
      hand = this.camera.position.clone().add(dir.multiplyScalar(0.45)).add(new THREE.Vector3(0, -0.22, 0))
    }
    const out = from.pos.clone().add(new THREE.Vector3(0, 0, 0.12))
    const mid = out.clone().lerp(hand, 0.5).add(new THREE.Vector3(0, -0.25, 0))
    const curve = new THREE.CatmullRomCurve3([from.pos, out, mid, hand])
    const geo = new THREE.TubeGeometry(curve, 40, 0.0055, 6)
    if (!this.carryMesh) {
      this.carryMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: this.carryColor, emissive: this.carryColor, emissiveIntensity: 0.3 }))
      this.world.add(this.carryMesh)
    } else {
      this.carryMesh.geometry.dispose()
      this.carryMesh.geometry = geo
    }
  }

  private animatePacket() {
    const p = this.packet
    if (!p || !p.mesh.visible) return
    const t = Math.min(1, (performance.now() - p.start) / p.dur)
    p.mesh.position.copy(p.curve.getPointAt(p.forward ? t : 1 - t))
  }

  // ---------- highlights ----------

  private applyHighlights() {
    for (const [id, mat] of this.chassis) {
      if (this.drag?.deviceId === id) {
        mat.emissive.setHex(COLORS.accent)
        mat.emissiveIntensity = 0.35
        continue
      }
      const f = this.flash[id]
      const selected = this.selection?.kind === 'device' && this.selection.id === id
      const color = f === 'err' ? 0xff4d5e : f === 'ok' ? 0x39ff88 : f === 'hit' ? 0x22d3ee : selected ? 0x39ff88 : 0x000000
      mat.emissive.setHex(color)
      // No tint for plain selection: it hid the panel labels. The side panel shows what's selected.
      mat.emissiveIntensity = f ? 0.55 : 0
    }
    for (const [id, mesh] of this.cableMeshes) {
      const l = this.topo.links.find((x) => x.id === id)
      const mat = mesh.material as THREE.MeshStandardMaterial
      const sel = this.selection?.kind === 'link' && this.selection.id === id
      const hov = this.hover?.kind === 'cable' && this.hover.linkId === id
      // Colour by cable type; red when it can't carry traffic (console cables never do, by design).
      const typed = new THREE.Color(CABLES[l?.cable ?? 'straight'].color).getHex()
      const base = sel ? COLORS.cableSel : l?.cable === 'console' || (l && linkActive(this.topo, l)) ? typed : COLORS.cableDown
      mat.color.setHex(base)
      mat.emissive.setHex(base)
      mat.emissiveIntensity = sel || hov ? 0.7 : 0.15
    }
  }

  // ---------- building ----------

  private buildRoom() {
    const b = this.layout.bounds
    const w = b.maxX - b.minX
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2

    // Raised floor: 60 cm tiles, a perforated one every few tiles.
    const floorTex = canvasTexture(256, 256, (g) => {
      g.fillStyle = '#2a313c'
      g.fillRect(0, 0, 256, 256)
      g.strokeStyle = '#161b22'
      g.lineWidth = 6
      g.strokeRect(0, 0, 256, 256)
      g.fillStyle = '#1e242d'
      for (let y = 40; y < 220; y += 22) for (let x = 40; x < 220; x += 22) g.fillRect(x, y, 8, 8)
    })
    // Floors: raised tiles in the server room, carpet in the offices, concrete in the corridor.
    const carpet = () =>
      canvasTexture(256, 256, (g) => {
        g.fillStyle = '#323b4a'
        g.fillRect(0, 0, 256, 256)
        for (let k = 0; k < 2600; k++) {
          g.fillStyle = k % 3 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.08)'
          g.fillRect((k * 97) % 256, (k * 57 + (k >> 4)) % 256, 2, 2)
        }
      })
    const concrete = () =>
      canvasTexture(256, 256, (g) => {
        g.fillStyle = '#3b4250'
        g.fillRect(0, 0, 256, 256)
        g.strokeStyle = 'rgba(0,0,0,0.25)'
        g.lineWidth = 2
        g.strokeRect(0, 0, 256, 256)
      })
    const floorRect = (tex: THREE.Texture, x0: number, x1: number, z0: number, z1: number, tile: number, mat: { roughness: number; metalness: number }) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set((x1 - x0) / tile, (z1 - z0) / tile)
      const f = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: tex, ...mat }))
      f.rotation.x = -Math.PI / 2
      f.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2)
      this.world.add(f)
    }
    const decking = () =>
      canvasTexture(256, 256, (g) => {
        g.fillStyle = '#5a4634'
        g.fillRect(0, 0, 256, 256)
        g.fillStyle = '#3e3024'
        for (let y = 0; y < 256; y += 32) g.fillRect(0, y, 256, 3)
      })
    for (const r of this.layout.rooms) {
      if (r.kind === 'racks') floorRect(floorTex.clone(), r.x0, r.x1, r.z0, r.z1, 0.6, { roughness: 0.85, metalness: 0.2 })
      else if (r.kind === 'balcony') {
        floorRect(decking(), r.x0, r.x1, r.z0, r.z1, 1.2, { roughness: 0.9, metalness: 0 })
        this.buildBalcony(r)
      } else floorRect(carpet(), r.x0, r.x1, r.z0, r.z1, 1.0, { roughness: 1, metalness: 0 })
    }
    const cor = this.layout.corridor
    floorRect(concrete(), cor.minX, cor.maxX, cor.minZ, cor.maxZ, 1.2, { roughness: 0.6, metalness: 0.1 })
    floorTex.dispose()

    for (const wall of this.layout.walls) this.buildWall(wall)
    for (const r of this.layout.rooms)
      if (r.kind === 'balcony') this.buildDoorway(r.doorX, r.label, roomColor(this.topo, r.id), BUILDING.corridor, BALCONY.door)
      else this.buildDoorway(r.doorX, r.label, roomColor(this.topo, r.id))

    // The ceiling covers the building only: balconies are open to the sky.
    const coreD = cor.maxZ - b.minZ
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, coreD), new THREE.MeshStandardMaterial({ color: 0x3a4352, emissive: 0x1c222c, roughness: 1 }))
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.set(cx, WALL_H, (b.minZ + cor.maxZ) / 2)
    // Ceiling and its lights are hidden in the overview, so you can look into every room.
    this.ceiling = new THREE.Group()
    this.ceiling.visible = this.mode === 'walk'
    this.world.add(this.ceiling)
    this.ceiling.add(ceiling)

    // Even lighting everywhere: soft fill from all sides plus one overhead light.
    // No point lights, so nothing gets darker with distance from a lamp.
    this.world.add(new THREE.AmbientLight(0xdde8ff, 0.9))
    this.world.add(new THREE.HemisphereLight(0xe8f0ff, 0x2a3140, 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(cx + 3, 12, cz + 6)
    sun.target.position.set(cx, 0, cz)
    this.world.add(sun, sun.target)
    // Ceiling light panels on a grid (visual only).
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xdde8ff, toneMapped: false })
    for (let x = b.minX + 2; x < b.maxX - 1; x += 3)
      for (let z = b.minZ + 1.5; z < cor.maxZ - 1; z += 3) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), panelMat)
        p.rotation.x = Math.PI / 2
        p.position.set(x, WALL_H - 0.01, z)
        this.ceiling.add(p)
      }

    // Overhead tray above each rack row.
    const racks = this.layout.placements.filter((p) => p.station === 'rack')
    const rows = new Map<number, number[]>()
    for (const r of racks) rows.set(r.z, [...(rows.get(r.z) ?? []), r.x])
    const trayMat = new THREE.MeshStandardMaterial({ color: 0x2a313d, metalness: 0.7, roughness: 0.4 })
    for (const [z, xs] of rows) {
      const x0 = Math.min(...xs) - RACK.w / 2
      const x1 = Math.max(...xs) + RACK.w / 2
      const tray = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.03, 0.32), trayMat)
      tray.position.set((x0 + x1) / 2, TRAY_Y - 0.06, z - 0.25)
      this.world.add(tray)
      // A light strip on the floor in front of the row.
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, 0.04), new THREE.MeshBasicMaterial({ color: COLORS.accent, toneMapped: false }))
      glow.rotation.x = -Math.PI / 2
      glow.position.set((x0 + x1) / 2, 0.005, z + 0.25)
      this.world.add(glow)
    }
  }

  private target<T extends THREE.Object3D>(obj: T, t: Target): T {
    obj.userData.target = t
    this.targets.push(obj)
    return obj
  }

  /** A floor rack (MDF, 2 m) or a wall-mounted mini rack (IDF), with a glass door and a name plate. */
  private buildRack(p: RackSpot) {
    const g = new THREE.Group()
    const metal = new THREE.MeshStandardMaterial({ color: COLORS.metal, metalness: 0.6, roughness: 0.5 })
    const box = (w: number, h: number, dd: number, x: number, y: number, z: number, mat: THREE.Material = metal) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), mat)
      m.position.set(x, y, z)
      g.add(m)
      return m
    }
    const wall = p.kind === 'wall'
    const { w, h, d: depth } = wall ? WALL_RACK : RACK
    const y0 = wall ? WALL_RACK.bottom : 0 // a wall rack hangs at chest height
    const zc = p.z - depth / 2
    box(0.02, h, depth, p.x - w / 2 + 0.01, y0 + h / 2, zc)
    box(0.02, h, depth, p.x + w / 2 - 0.01, y0 + h / 2, zc)
    box(w, 0.04, depth, p.x, y0 + h - 0.02, zc)
    box(w, 0.04, depth, p.x, y0 + 0.02, zc)
    box(w, h, 0.02, p.x, y0 + h / 2, p.z - depth + 0.01)
    // Front posts with mounting holes look.
    const postMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.7, roughness: 0.4 })
    box(0.03, h - 0.08, 0.02, p.x - 0.245, y0 + h / 2, p.z - 0.07, postMat)
    box(0.03, h - 0.08, 0.02, p.x + 0.245, y0 + h / 2, p.z - 0.07, postMat)
    if (wall) box(0.5, 0.05, 0.06, p.x, y0 + h / 2, p.z - depth - 0.03, postMat) // wall bracket

    // Blanking panels fill the empty space under the mounted devices (floor racks).
    const mounted = this.layout.placements.filter((x) => x.rack === p.index)
    if (!wall) {
      const blank = new THREE.MeshStandardMaterial({ color: 0x0e1218, metalness: 0.4, roughness: 0.7 })
      const lowest = Math.min(h - 0.1, ...mounted.map((x) => x.panel.y - x.panel.h / 2))
      for (let y = 0.15; y < lowest - 0.06; y += 0.1) box(0.44, 0.08, 0.3, p.x, y, p.z - 0.22, blank)
    }

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), new THREE.MeshBasicMaterial({ visible: false }))
    body.position.set(p.x, y0 + h / 2, zc)
    body.userData.rack = p.index
    g.add(body)
    this.rackBodies.push(body)

    // Name plate on top of the rack.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.56, 0.14),
      new THREE.MeshBasicMaterial({ map: this.plateTexture(p), transparent: true, toneMapped: false }),
    )
    plate.position.set(p.x, y0 + h + 0.12, p.z - 0.02)
    g.add(plate)

    // Glass door on a hinge at the left edge.
    const pivot = new THREE.Group()
    pivot.position.set(p.x - w / 2, y0, p.z + 0.011)
    const frameMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.6, roughness: 0.4 })
    const door = new THREE.Group()
    const bar = (bw: number, bh: number, x: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.02), frameMat)
      m.position.set(x, y, 0)
      door.add(m)
    }
    bar(0.03, h - 0.04, 0.015, h / 2)
    bar(0.03, h - 0.04, w - 0.015, h / 2)
    bar(w, 0.03, w / 2, 0.025)
    bar(w, 0.03, w / 2, h - 0.025)
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(w - 0.06, h - 0.07),
      new THREE.MeshStandardMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0.16, metalness: 0.1, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    )
    glass.position.set(w / 2, h / 2, 0)
    door.add(glass)
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.015, Math.min(0.18, h * 0.3), 0.03), new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.9, roughness: 0.2 }))
    handle.position.set(w - 0.05, wall ? h / 2 : 1.1, 0.02)
    door.add(handle)
    pivot.add(door)
    pivot.rotation.y = this.openDoors.has(p.index) ? -1.95 : 0
    g.add(pivot)
    // One invisible hit box for the whole door so it is easy to click.
    const hit = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), new THREE.MeshBasicMaterial({ visible: false }))
    hit.position.set(w / 2, h / 2, 0)
    door.add(this.target(hit, { kind: 'door', rack: p.index }))
    this.doors.set(p.index, pivot)

    this.world.add(g)
  }

  /** A wall segment, full height. Glass walls get an aluminium frame with mullions. */
  private buildWall(w: Wall) {
    const alongX = w.z0 === w.z1
    const len = Math.hypot(w.x1 - w.x0, w.z1 - w.z0)
    if (len < 0.05) return
    const t = BUILDING.wallT
    const cx = (w.x0 + w.x1) / 2
    const cz = (w.z0 + w.z1) / 2
    const box = (thick: number, h: number, y: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : thick, h, alongX ? thick : len), mat)
      m.position.set(cx, y, cz)
      this.world.add(m)
    }
    if (w.glass) {
      const frame = new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.8, roughness: 0.3 })
      const glass = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.12, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false })
      box(0.02, 2.2, 1.1, glass)
      box(t, 0.06, 0.03, frame)
      box(t, 0.06, 2.2, frame)
      box(t, WALL_H - 2.23, (WALL_H + 2.23) / 2, this.wallMat)
      const n = Math.max(1, Math.round(len / 1.2))
      for (let k = 0; k <= n; k++) {
        const f = k / n
        const m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.04 : t, 2.2, alongX ? t : 0.04), frame)
        m.position.set(w.x0 + (w.x1 - w.x0) * f, 1.1, w.z0 + (w.z1 - w.z0) * f)
        this.world.add(m)
      }
      return
    }
    box(t, WALL_H, WALL_H / 2, this.wallMat)
    // Glowing baseboard on both faces.
    box(t + 0.01, 0.03, 0.12, new THREE.MeshBasicMaterial({ color: COLORS.accent, toneMapped: false }))
  }

  private wallMat = new THREE.MeshStandardMaterial({ color: 0x34404f, roughness: 0.95 })

  /** Door frame in a room's corridor wall, with a lintel above and the room's name over it. */
  /** Door frame and lintel in a wall at z, with the room's name over it on the corridor side. */
  private buildDoorway(x: number, label: string, color = ACCENT_CSS, z = 0, width = BUILDING.door) {
    const half = width / 2
    // Rooms open to -z of the corridor (sign on the +z face); balconies to +z (sign on the -z face).
    const side = z === 0 ? 1 : -1
    const frame = new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.8, roughness: 0.3 })
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.2, BUILDING.wallT + 0.02), frame)
      post.position.set(x + sx * half, 1.1, z)
      this.world.add(post)
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(width + 0.12, WALL_H - 2.2, BUILDING.wallT), this.wallMat)
    lintel.position.set(x, (WALL_H + 2.2) / 2, z)
    this.world.add(lintel)
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 0.24),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(500, 100, (g) => {
          g.fillStyle = '#05080d'
          g.fillRect(0, 0, 500, 100)
          g.strokeStyle = color
          g.lineWidth = 4
          g.strokeRect(2, 2, 496, 96)
          g.fillStyle = color
          g.font = `bold 40px ${FONT}`
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText(label.toUpperCase(), 250, 52)
        }),
        toneMapped: false,
      }),
    )
    sign.position.set(x, 2.45, z + side * (BUILDING.wallT / 2 + 0.01))
    if (side < 0) sign.rotation.y = Math.PI
    this.world.add(sign)
  }

  /** Low fabric walls around a desk: back, left, and right on the row's last cubicle. */
  private buildCubicle(c: Cubicle) {
    const fabric = new THREE.MeshStandardMaterial({ color: 0x4a5870, roughness: 1 })
    const trim = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, metalness: 0.7, roughness: 0.35 })
    const { w, d, wallH, wallT } = CUBE
    const panel = (pw: number, pd: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(pw, wallH, pd), fabric)
      m.position.set(x, wallH / 2, z)
      this.world.add(m)
      const cap = new THREE.Mesh(new THREE.BoxGeometry(pw + 0.01, 0.025, pd + 0.01), trim)
      cap.position.set(x, wallH, z)
      this.world.add(cap)
    }
    panel(w, wallT, c.x, c.back + wallT / 2)
    panel(wallT, d, c.x - w / 2, c.back + d / 2)
    if (c.rightWall) panel(wallT, d, c.x + w / 2, c.back + d / 2)

    // Name card standing on top of the back wall, so monitors never hide it.
    const name = getDevice(this.topo, c.deviceId)?.name ?? '?'
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.1),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(336, 80, (g) => {
          g.fillStyle = '#e6edf7'
          g.fillRect(0, 0, 336, 80)
          g.fillStyle = '#0a0e14'
          g.font = `bold 40px ${FONT}`
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText(name, 168, 42)
        }),
      }),
    )
    card.position.set(c.x, wallH + 0.065, c.back + wallT / 2 + 0.014)
    this.world.add(card)

    // Office chair in front of the desk.
    const dark = new THREE.MeshStandardMaterial({ color: 0x151a22, roughness: 0.8 })
    // Pushed back and to the side, so it doesn't hide the desk from the aisle.
    const cz = c.back + wallT + DESK.d + 0.45
    const chairX = c.x + w / 2 - 0.35
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.07, 0.44), dark)
    seat.position.set(chairX, 0.47, cz)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.32, 0.05), dark)
    back.position.set(chairX, 0.68, cz + 0.21)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), trim)
    pole.position.set(chairX, 0.24, cz)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 16), dark)
    base.position.set(chairX, 0.03, cz)
    this.world.add(seat, back, pole, base)
  }

  /** Glass railing, planters and lounge chairs where people sit with laptops. */
  private buildBalcony(r: Room) {
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.18, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false })
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, metalness: 0.8, roughness: 0.3 })
    const H = BALCONY.railH
    const rail = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0)
      const alongX = z0 === z1
      const pane = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.02, H - 0.08, alongX ? 0.02 : len), glass)
      pane.position.set((x0 + x1) / 2, (H - 0.08) / 2, (z0 + z1) / 2)
      const top = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.06, 0.05, alongX ? 0.06 : len), steel)
      top.position.set((x0 + x1) / 2, H, (z0 + z1) / 2)
      this.world.add(pane, top)
    }
    rail(r.x0, r.z1, r.x1, r.z1)
    rail(r.x0, r.z0, r.x0, r.z1)
    rail(r.x1, r.z0, r.x1, r.z1)
    // Planters in the corners.
    const pot = new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 0.8 })
    const leaves = new THREE.MeshStandardMaterial({ color: 0x2f6b45, roughness: 1 })
    for (const x of [r.x0 + 0.35, r.x1 - 0.35]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), pot)
      p.position.set(x, 0.225, r.z1 - 0.35)
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.38, 8, 6), leaves)
      b.position.set(x, 0.75, r.z1 - 0.35)
      this.world.add(p, b)
    }
    // Free lounge chairs stay empty; people are drawn with the device they use (buildHeld).
    for (const seat of this.layout.seats.filter((s) => !s.deviceId && s.pose === 'sit' && s.x > r.x0 && s.x < r.x1 && s.z > r.z0 && s.z < r.z1))
      this.buildLoungeChair(seat.x, seat.z)
  }

  /** Someone standing at the railing, forearms on it, looking out at the city (some with a coffee). */
  private buildStandingPerson(x: number, z: number, holdingPhone = false) {
    const k = Math.floor(Math.abs(x * 5.1 + 3)) % 4
    const shirt = new THREE.MeshStandardMaterial({ color: [0xe67e22, 0x2c3e50, 0xd35400, 0x27ae60][k], roughness: 0.8 })
    const skin = new THREE.MeshStandardMaterial({ color: [0xc68642, 0x8d5524, 0xf1c27d, 0x6b4423][k], roughness: 0.8 })
    const pants = new THREE.MeshStandardMaterial({ color: [0x22262e, 0x3b4a6b, 0x4a3a2a, 0x22262e][k], roughness: 0.8 })
    const hair = new THREE.MeshStandardMaterial({ color: [0x2b2018, 0x0e0e0e, 0x8a5a2b, 0x3a2a1a][k], roughness: 0.9 })
    const g = new THREE.Group()
    const box = (w: number, h: number, d: number, m: THREE.Material, px: number, py: number, pz: number, rx = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
      mesh.position.set(px, py, pz)
      mesh.rotation.x = rx
      g.add(mesh)
    }
    box(0.14, 0.86, 0.16, pants, -0.09, 0.43, 0)
    box(0.14, 0.86, 0.16, pants, 0.09, 0.43, 0)
    box(0.4, 0.6, 0.22, shirt, 0, 1.17, 0.02, 0.08)
    box(0.2, 0.24, 0.22, skin, 0, 1.6, 0.06)
    box(0.22, 0.08, 0.24, hair, 0, 1.74, 0.05)
    // Left forearm on the railing; the right hand either on the railing too or holding a phone up.
    box(0.09, 0.09, 0.34, shirt, -0.2, 1.04, 0.18)
    if (holdingPhone) {
      box(0.09, 0.09, 0.3, shirt, 0.2, 1.12, 0.12, 0.6) // forearm raised towards the face
      box(0.08, 0.09, 0.08, skin, 0.2, 1.2, 0.3) // hand
    } else {
      box(0.09, 0.09, 0.34, shirt, 0.2, 1.04, 0.18)
      if (k % 2 === 0) box(0.06, 0.1, 0.06, new THREE.MeshStandardMaterial({ color: 0xf5f5f5 }), 0.2, 1.12, 0.34) // coffee cup
    }
    g.position.set(x, 0, z - 0.2)
    this.world.add(g)
  }

  private buildLoungeChair(x: number, z: number) {
    const chair = new THREE.MeshStandardMaterial({ color: 0x3a4658, roughness: 0.9 })
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.7), chair)
    seat.position.set(x, 0.38, z)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.6, 0.06), chair)
    back.position.set(x, 0.66, z - 0.36)
    back.rotation.x = -0.35
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.5), chair)
    base.position.set(x, 0.17, z)
    this.world.add(seat, back, base)
  }

  /**
   * A laptop or smartphone used by someone on the balcony: the person and the real
   * device (selectable, E opens its console, Wi-Fi arcs start from it).
   */
  private buildHeld(d: Device, p: Placement) {
    const seat = this.layout.seats.find((s) => s.deviceId === d.id)
    if (!seat) return
    if (seat.pose === 'sit') {
      this.buildLoungeChair(seat.x, seat.z)
      this.buildSittingPerson(seat.x, seat.z)
      if (d.type === 'laptop') {
        // The laptop on their lap, screen towards them: build it facing +z, then turn it round.
        const lap = new THREE.Group()
        const local: Placement = { ...p, x: 0, z: 0, panel: { ...p.panel, x: 0, y: 0, z: 0 } }
        this.buildLaptop(lap, d, local)
        lap.rotation.y = Math.PI
        lap.position.set(seat.x, 0.6, seat.z + 0.08)
        this.world.add(lap)
        this.radios.set(d.id, new THREE.Vector3(seat.x, 0.95, seat.z + 0.3))
      } else this.buildHeldPhone(d, new THREE.Vector3(seat.x + 0.1, 0.78, seat.z + 0.22))
    } else {
      this.buildStandingPerson(seat.x, seat.z, true)
      this.buildHeldPhone(d, new THREE.Vector3(seat.x + 0.2, 1.3, seat.z + 0.16))
    }
  }

  /** A smartphone held upright, screen towards its owner. */
  private buildHeldPhone(d: Device, at: THREE.Vector3) {
    const body = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.4, metalness: 0.4 })
    this.chassis.set(d.id, body)
    const phone = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.15, 0.012), body)
    phone.position.copy(at)
    phone.rotation.x = 0.35
    this.world.add(this.target(phone, { kind: 'device', deviceId: d.id }))
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.065, 0.13), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, toneMapped: false }))
    screen.position.set(0, 0, -0.007)
    screen.rotation.y = Math.PI
    phone.add(screen)
    this.radios.set(d.id, at.clone().add(new THREE.Vector3(0, 0.1, 0)))
  }

  /** A smartphone lying on a desk or table. */
  private buildMobileFlat(g: THREE.Group, d: Device, p: Placement) {
    this.buildChassis(g, d, p, 0.15)
    this.radios.set(d.id, new THREE.Vector3(p.panel.x, p.panel.y + 0.15, p.panel.z - 0.08))
  }

  /** A person on a lounge chair, working on the laptop on their lap, looking out at the city. */
  private buildSittingPerson(x: number, z: number) {
    const k = Math.floor(Math.abs(x * 13.7 + z * 5.3) * 3) % 4
    const shirt = new THREE.MeshStandardMaterial({ color: [0x2e86de, 0xc0392b, 0x16a085, 0x8e44ad][k], roughness: 0.8 })
    const skin = new THREE.MeshStandardMaterial({ color: [0x8d5524, 0xc68642, 0xe0ac69, 0x5c3a21][k], roughness: 0.8 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.8 })
    const g = new THREE.Group()
    const box = (w: number, h: number, d: number, m: THREE.Material, px: number, py: number, pz: number, rx = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
      mesh.position.set(px, py, pz)
      mesh.rotation.x = rx
      g.add(mesh)
    }
    // Seated person facing +z (the view): thighs forward, shins down, torso leaning back.
    box(0.36, 0.14, 0.42, dark, 0, 0.5, 0.12)
    box(0.34, 0.4, 0.13, dark, 0, 0.26, 0.36)
    box(0.42, 0.52, 0.24, shirt, 0, 0.8, -0.14, -0.2)
    box(0.2, 0.24, 0.22, skin, 0, 1.18, -0.2)
    box(0.22, 0.07, 0.24, dark, 0, 1.31, -0.21) // hair
    // Arms reaching to the laptop on the lap.
    box(0.09, 0.09, 0.34, shirt, -0.24, 0.66, 0.06)
    box(0.09, 0.09, 0.34, shirt, 0.24, 0.66, 0.06)
    g.position.set(x, 0, z)
    this.world.add(g)
  }

  /** A printer on a low cabinet, paper tray in front. */
  private buildPrinter(d: Device, p: Placement) {
    const g = new THREE.Group()
    const cab = new THREE.Mesh(new THREE.BoxGeometry(PRINTER.w, PRINTER.h, PRINTER.d), new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 0.8 }))
    cab.position.set(p.x, PRINTER.h / 2, p.z - PRINTER.d / 2)
    g.add(cab)
    this.buildChassis(g, d, p, 0.42)
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.012, 0.2), new THREE.MeshStandardMaterial({ color: 0xe6edf7, roughness: 0.6 }))
    tray.position.set(p.x - 0.04, p.panel.y + 0.08, p.z - 0.02)
    tray.rotation.x = -0.15
    g.add(tray)
    const lid = new THREE.Mesh(new THREE.BoxGeometry(p.panel.w, 0.03, 0.4), new THREE.MeshStandardMaterial({ color: 0x3a4352, roughness: 0.6 }))
    lid.position.set(p.x, p.panel.y + p.panel.h / 2 + 0.015, p.z - 0.27)
    g.add(lid)
    this.world.add(g)
  }

  /** An IP phone on a desk: base, handset, little screen. */
  private buildPhone(d: Device, p: Placement) {
    const g = new THREE.Group()
    this.buildChassis(g, d, p, 0.2)
    const dark = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.5 })
    const handset = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.2), dark)
    handset.position.set(p.panel.x - 0.07, p.panel.y + 0.04, p.panel.z - 0.1)
    g.add(handset)
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.045), new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false }))
    screen.rotation.x = -Math.PI / 3
    screen.position.set(p.panel.x + 0.04, p.panel.y + p.panel.h / 2 + 0.005, p.panel.z - 0.1)
    g.add(screen)
    this.world.add(g)
  }

  /** A small balcony table with a laptop or an AP on it. */
  private buildLounge(d: Device, p: Placement) {
    const g = new THREE.Group()
    const T = BALCONY.table
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b5440, roughness: 0.8 })
    const top = new THREE.Mesh(new THREE.BoxGeometry(T.w, 0.04, T.d), wood)
    top.position.set(p.x, T.h - 0.02, p.z - T.d / 2)
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, T.h - 0.04, 8), new THREE.MeshStandardMaterial({ color: 0x9aa6b8, metalness: 0.8, roughness: 0.3 }))
    leg.position.set(p.x, (T.h - 0.04) / 2, p.z - T.d / 2)
    g.add(top, leg)
    if (d.type === 'laptop') this.buildLaptop(g, d, p)
    else if (d.type === 'mobile') this.buildMobileFlat(g, d, p)
    else this.buildAp(g, d, p)
    this.world.add(g)
  }

  private buildDesk(d: Device, p: Placement) {
    const g = new THREE.Group()
    const H = p.deskH ?? DESK.h
    const wood = new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.8 })
    const top = new THREE.Mesh(new THREE.BoxGeometry(DESK.w, 0.04, DESK.d), wood)
    top.position.set(p.x, H - 0.02, p.z - DESK.d / 2)
    g.add(top)
    const legMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.8, roughness: 0.3 })
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, H - 0.04, 0.04), legMat)
        leg.position.set(p.x + sx * (DESK.w / 2 - 0.04), (H - 0.04) / 2, p.z - DESK.d / 2 + sz * (DESK.d / 2 - 0.04))
        g.add(leg)
      }
    if (d.type === 'pc') this.buildPc(g, d, p, legMat)
    else if (d.type === 'laptop') this.buildLaptop(g, d, p)
    else if (d.type === 'mobile') this.buildMobileFlat(g, d, p)
    else this.buildAp(g, d, p)
    this.world.add(g)
  }

  private screenTexture(d: Device, extra: string[]): THREE.CanvasTexture {
    const ip = d.ifaces.find((i) => i.ip)
    return canvasTexture(512, 300, (c) => {
      c.fillStyle = '#05080d'
      c.fillRect(0, 0, 512, 300)
      c.font = `bold 34px ${FONT}`
      c.fillStyle = '#39ff88'
      c.fillText(`${d.name}:~$ _`, 24, 70)
      c.font = `24px ${FONT}`
      c.fillStyle = '#6b7a90'
      c.fillText(ip ? `inet ${ip.ip}/${ip.prefix}` : 'no IP address', 24, 120)
      c.fillText(d.gateway ? `gateway ${d.gateway}` : 'no gateway', 24, 156)
      extra.forEach((t, k) => c.fillText(t, 24, 192 + k * 36))
      c.fillStyle = '#22d3ee'
      c.fillText('press E for console', 24, 270)
    })
  }

  private buildPc(g: THREE.Group, d: Device, p: Placement, legMat: THREE.Material) {
    const H = p.deskH ?? DESK.h
    // Monitor showing the host's prompt.
    const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.34, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b0e13 }))
    monitor.position.set(p.x + 0.15, H + 0.3, p.z - DESK.d + 0.18)
    g.add(this.target(monitor, { kind: 'device', deviceId: d.id }))
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.3), new THREE.MeshBasicMaterial({ map: this.screenTexture(d, []), toneMapped: false }))
    screen.position.set(0, 0, 0.016)
    monitor.add(screen)
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.05), legMat)
    stand.position.set(p.x + 0.15, H + 0.07, p.z - DESK.d + 0.18)
    g.add(stand)
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.14), new THREE.MeshStandardMaterial({ color: 0x151a22 }))
    kb.position.set(p.x + 0.15, H + 0.01, p.z - 0.18)
    g.add(kb)
    this.buildChassis(g, d, p, 0.42)
  }

  private buildLaptop(g: THREE.Group, d: Device, p: Placement) {
    const depth = 0.24
    this.buildChassis(g, d, p, depth)
    const link = linkOn(this.topo, d.id, 'wlan0')
    const wifi = link?.wifi ? (linkActive(this.topo, link) ? `wifi "${link.wifi.ssid}"` : `wifi "${link.wifi.ssid}" (dropped)`) : 'wifi: not connected'
    // Lid hinged at the back edge of the base, tilted back a little.
    const hinge = new THREE.Group()
    hinge.position.set(p.panel.x, p.panel.y + p.panel.h / 2, p.panel.z - depth)
    hinge.rotation.x = -0.25
    const lid = new THREE.Mesh(new THREE.BoxGeometry(p.panel.w, 0.22, 0.012), new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.5, roughness: 0.5 }))
    lid.position.set(0, 0.11, 0)
    hinge.add(this.target(lid, { kind: 'device', deviceId: d.id }))
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(p.panel.w - 0.02, 0.2), new THREE.MeshBasicMaterial({ map: this.screenTexture(d, [wifi]), toneMapped: false }))
    screen.position.set(0, 0.11, 0.007)
    hinge.add(screen)
    g.add(hinge)
    this.radios.set(d.id, new THREE.Vector3(p.panel.x, p.panel.y + 0.24, p.panel.z - depth - 0.05))
  }

  private buildAp(g: THREE.Group, d: Device, p: Placement) {
    const depth = 0.18
    this.buildChassis(g, d, p, depth)
    const mat = new THREE.MeshStandardMaterial({ color: 0x0e1218, roughness: 0.6 })
    for (const sx of [-1, 1]) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.2, 10), mat)
      ant.position.set(p.panel.x + sx * (p.panel.w / 2 - 0.03), p.panel.y + p.panel.h / 2 + 0.1, p.panel.z - depth + 0.02)
      ant.rotation.z = sx * 0.15
      g.add(ant)
    }
    // Status light on top: green while the radio is serving an SSID.
    const radio = d.ifaces.find((i) => i.name === 'd0')
    const on = !!d.ios?.wlan?.radioSsid && !radio?.shutdown
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: on ? COLORS.ledUp : COLORS.ledDown, toneMapped: false }))
    led.position.set(p.panel.x, p.panel.y + p.panel.h / 2 + 0.005, p.panel.z - depth / 2)
    g.add(led)
    this.radios.set(d.id, new THREE.Vector3(p.panel.x, p.panel.y + 0.2, p.panel.z - depth + 0.02))
  }

  /** Office AP: a white puck on the ceiling with a dome underneath; ports on its front edge. */
  private buildCeilingAp(d: Device, p: Placement) {
    const g = new THREE.Group()
    this.buildChassis(g, d, p, 0.26)
    const white = new THREE.MeshStandardMaterial({ color: 0xe6edf7, roughness: 0.4 })
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), white)
    dome.position.set(p.panel.x, p.panel.y - p.panel.h / 2, p.panel.z - 0.13)
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.04, 20), white)
    mount.position.set(p.panel.x, WALL_H - 0.02, p.panel.z - 0.13)
    g.add(dome, mount)
    this.apStatusLed(g, d, p.panel.x, p.panel.y - p.panel.h / 2 - 0.1, p.panel.z - 0.13)
    this.radios.set(d.id, new THREE.Vector3(p.panel.x, p.panel.y - 0.2, p.panel.z - 0.13))
    this.world.add(g)
  }

  /** Balcony AP: an outdoor unit on a bracket on the building's outside wall, antennas up. */
  private buildWallAp(d: Device, p: Placement) {
    const g = new THREE.Group()
    const depth = 0.16
    this.buildChassis(g, d, p, depth)
    const metal = new THREE.MeshStandardMaterial({ color: 0x5b6475, metalness: 0.7, roughness: 0.4 })
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.05), metal)
    bracket.position.set(p.panel.x, p.panel.y, p.panel.z - depth - 0.02)
    g.add(bracket)
    const mat = new THREE.MeshStandardMaterial({ color: 0x0e1218, roughness: 0.6 })
    for (const sx of [-1, 1]) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.26, 10), mat)
      ant.position.set(p.panel.x + sx * (p.panel.w / 2 - 0.03), p.panel.y + p.panel.h / 2 + 0.13, p.panel.z - depth / 2)
      g.add(ant)
    }
    this.apStatusLed(g, d, p.panel.x, p.panel.y + p.panel.h / 2 + 0.006, p.panel.z - depth / 2)
    this.radios.set(d.id, new THREE.Vector3(p.panel.x, p.panel.y + 0.25, p.panel.z - depth / 2))
    this.world.add(g)
  }

  /** Green while the AP's radio is serving an SSID, amber otherwise. */
  private apStatusLed(g: THREE.Group, d: Device, x: number, y: number, z: number) {
    const radio = d.ifaces.find((i) => i.name === 'd0')
    const on = !!d.ios?.wlan?.radioSsid && !radio?.shutdown
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), new THREE.MeshBasicMaterial({ color: on ? COLORS.ledUp : COLORS.ledDown, toneMapped: false }))
    led.position.set(x, y, z)
    g.add(led)
  }

  /** The device box, its labelled front panel, ports, LEDs and plugs. */
  private buildChassis(g: THREE.Group, d: Device, p: Placement, depth: number) {
    const { x, y, z, w, h } = p.panel
    const body = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.5, roughness: 0.5 })
    const front = new THREE.MeshStandardMaterial({ map: this.panelTexture(d, p), metalness: 0.3, roughness: 0.6 })
    this.chassis.set(d.id, front)
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), [body, body, body, body, front, body])
    m.position.set(x, y, z - depth / 2)
    g.add(this.target(m, { kind: 'device', deviceId: d.id }))

    for (const s of p.ports) {
      const iface = d.ifaces.find((i) => i.name === s.iface)!
      const px = x + s.x
      const py = y + s.y
      // RJ45 sockets are black, SFP fiber cages silver and slim, console ports framed in lavender.
      const kind = portKind(d, s.iface)
      const look = {
        copper: { w: 0.04, h: 0.034, color: COLORS.socket, metal: 0 },
        fiber: { w: 0.032, h: 0.02, color: 0x9aa6b8, metal: 0.8 },
        console: { w: 0.032, h: 0.022, color: 0x3b3f6b, metal: 0 },
        radio: { w: 0.03, h: 0.03, color: COLORS.socket, metal: 0 },
        virtual: { w: 0.03, h: 0.03, color: COLORS.socket, metal: 0 },
      }[kind]
      // Patch panel: 48 small keystone jacks in front, white punch-down blocks on the rear side.
      if (d.type === 'patch') Object.assign(look, s.iface.endsWith('r') ? { w: 0.014, h: 0.012, color: 0xd8e4f0 } : { w: 0.014, h: 0.014 })
      const socket = new THREE.Mesh(
        new THREE.BoxGeometry(look.w, look.h, 0.012),
        new THREE.MeshStandardMaterial({ color: look.color, metalness: look.metal, roughness: look.metal ? 0.35 : 0.9 }),
      )
      socket.position.set(px, py, z + 0.002)
      g.add(this.target(socket, { kind: 'port', deviceId: d.id, iface: s.iface }))
      this.ports.set(portKey(d.id, s.iface), { pos: new THREE.Vector3(px, py, z + 0.01), station: p.station })

      const link = linkOn(this.topo, d.id, s.iface)
      if (kind !== 'console') {
        const ledColor = iface.shutdown ? COLORS.ledShut : !link ? 0x20262f : linkActive(this.topo, link) ? COLORS.ledUp : COLORS.ledDown
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.005, 0.004), new THREE.MeshBasicMaterial({ color: ledColor, toneMapped: false }))
        led.position.set(px - 0.012, py + (look.h / 2 + 0.002) * (s.y < 0 && d.type === 'switch' ? -1 : 1), z + 0.003)
        g.add(led)
      }

      if (link) {
        const plugColor = new THREE.Color(CABLES[link.cable ?? 'straight'].color)
        const plug = new THREE.Mesh(
          new THREE.BoxGeometry(look.w * 0.75, look.h * 0.65, 0.05),
          new THREE.MeshStandardMaterial({ color: plugColor, transparent: true, opacity: 0.9, roughness: 0.3 }),
        )
        plug.position.set(px, py, z + 0.03)
        g.add(plug)
      }
    }
  }

  /** Wi-Fi association: a dashed arc from the AP antennas to the client. Not clickable. */
  private buildWifi(linkId: string) {
    const l = this.topo.links.find((x) => x.id === linkId)!
    const a = this.radios.get(l.a.device)
    const b = this.radios.get(l.b.device)
    if (!a || !b) return
    const mid = a.clone().lerp(b, 0.5)
    mid.y = Math.max(a.y, b.y) + 0.35
    const curve = new THREE.CatmullRomCurve3([a, mid, b])
    this.curves.set(linkId, curve)
    const up = linkActive(this.topo, l)
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(60)),
      new THREE.LineDashedMaterial({ color: up ? COLORS.accent : COLORS.cableDown, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: up ? 0.8 : 0.4, toneMapped: false }),
    )
    line.computeLineDistances()
    this.world.add(line)
  }

  private buildCable(linkId: string, index: number) {
    const l = this.topo.links.find((x) => x.id === linkId)!
    const a = this.ports.get(portKey(l.a.device, l.a.iface))
    const b = this.ports.get(portKey(l.b.device, l.b.iface))
    if (!a || !b) return
    const trayY = TRAY_Y + (index % 4) * 0.025
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const end = (e: { pos: THREE.Vector3; station: Placement['station'] }) => {
      const p = e.pos
      if (e.station === 'rack') return [p, v(p.x, p.y, p.z + 0.045), v(p.x, 1.95, p.z + 0.03), v(p.x, trayY, p.z - 0.2)]
      // Ceiling AP: out of the front edge, then along the ceiling to the tray.
      if (e.station === 'ceiling') return [p, v(p.x, p.y, p.z + 0.08), v(p.x, p.y + 0.03, p.z + 0.25), v(p.x, trayY + 0.3, p.z + 0.5)]
      // Balcony wall AP: up the wall and in through it, into the corridor's tray.
      if (e.station === 'wall') return [p, v(p.x, p.y, p.z + 0.06), v(p.x, p.y + 0.35, p.z), v(p.x, p.y + 0.35, p.z - 0.5), v(p.x, trayY, p.z - 0.9)]
      return [p, v(p.x, p.y, p.z + 0.1), v(p.x, p.y + 0.6, p.z + 0.12), v(p.x, trayY, p.z + 0.1)]
    }
    const pts = this.deskRoute(l, a.pos, b.pos) ?? [...end(a), ...end(b).reverse()]
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
    this.curves.set(linkId, curve)
    const radius = l.cable === 'fiber' ? 0.0035 : l.cable === 'console' ? 0.0045 : 0.0055
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius, 6), new THREE.MeshStandardMaterial({ color: COLORS.cable, roughness: 0.6 }))
    this.world.add(this.target(mesh, { kind: 'cable', linkId }))
    this.cableMeshes.set(linkId, mesh)
  }

  /**
   * A phone cabled to the PC on its own desk: the cable lies on the desk, from the
   * phone, around behind the monitor, to the PC tower, instead of going up to the ceiling.
   */
  private deskRoute(l: Link, pa: THREE.Vector3, pb: THREE.Vector3): THREE.Vector3[] | null {
    const da = getDevice(this.topo, l.a.device)
    const db = getDevice(this.topo, l.b.device)
    if (!da || !db) return null
    const [phone, phonePos, pcPos] = da.type === 'phone' ? [da, pa, pb] : db.type === 'phone' ? [db, pb, pa] : [null, pa, pb]
    if (!phone) return null
    const other = phone === da ? db : da
    if (phone.deskOf !== other.id) return null
    const pc = this.layout.placements.find((p) => p.deviceId === other.id)
    if (!pc || (pc.station !== 'desk' && pc.station !== 'lounge')) return null
    const top = (pc.station === 'desk' ? (pc.deskH ?? DESK.h) : BALCONY.table.h) + 0.012
    const back = pc.z - (pc.station === 'desk' ? DESK.d : BALCONY.table.d) + 0.06
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    return [
      phonePos,
      v(phonePos.x, phonePos.y, phonePos.z + 0.05),
      v(phonePos.x + 0.06, top, phonePos.z + 0.03), // down to the desk beside the phone
      v(phonePos.x + 0.1, top, back + 0.12), // along the side of the phone to the back
      v((phonePos.x + pcPos.x) / 2, top, back), // behind the monitor
      v(pcPos.x + 0.14, top, back + 0.1), // to the side of the tower
      v(pcPos.x + 0.12, top, pcPos.z + 0.06), // round to its front
      v(pcPos.x, pcPos.y - 0.06, pcPos.z + 0.06), // up the front to the port
      pcPos,
    ]
  }

  /** Patch panel face: name, a FRONT and a REAR band, and port numbers every sixth jack. */
  private patchTexture(d: Device, p: Placement, W: number, H: number): THREE.CanvasTexture {
    const toX = (x: number) => (x / p.panel.w + 0.5) * W
    const toY = (y: number) => (0.5 - y / p.panel.h) * H
    return canvasTexture(W, H, (g) => {
      g.fillStyle = '#20262f'
      g.fillRect(0, 0, W, H)
      // Rear (punch-down) band is lighter, like the white blocks on a real panel's back.
      g.fillStyle = '#2b323d'
      g.fillRect(0, toY(-0.008), W, H - toY(-0.008))
      g.fillStyle = '#c9d6e8'
      g.font = `bold 15px ${FONT}`
      g.textBaseline = 'middle'
      g.fillText(`${d.name} · 48-port patch panel`, 10, 13)
      g.fillStyle = '#6b7a90'
      g.font = `12px ${FONT}`
      g.textAlign = 'right'
      g.fillText('FRONT', W - 8, 13)
      g.fillText('REAR', W - 8, toY(-0.008) + 9)
      g.textAlign = 'center'
      for (const s of p.ports)
        if (!s.iface.endsWith('r')) {
          const n = Number(s.iface.slice(1))
          if (n === 1 || n % 6 === 0 || n === 25) g.fillText(String(n), toX(s.x), toY(s.y) + (n <= 24 ? -13 : 13))
        }
    })
  }

  private panelTexture(d: Device, p: Placement): THREE.CanvasTexture {
    const S = 1600
    const W = Math.round(p.panel.w * S)
    const H = Math.round(p.panel.h * S)
    const color = TYPE_COLOR[d.type]
    if (d.type === 'patch') return this.patchTexture(d, p, W, H)
    return canvasTexture(W, H, (g) => {
      g.fillStyle = '#1b2230'
      g.fillRect(0, 0, W, H)
      g.fillStyle = color
      if (d.type === 'pc') g.fillRect(0, 0, W, 10)
      else g.fillRect(0, 0, 10, H)
      const toX = (x: number) => (x / p.panel.w + 0.5) * W
      const toY = (y: number) => (0.5 - y / p.panel.h) * H
      g.fillStyle = '#e6edf7'
      g.font = `bold ${d.type === 'pc' ? 42 : 34}px ${FONT}`
      g.textBaseline = 'middle'
      if (d.type === 'laptop' || d.type === 'mobile') return
      if (d.type === 'ap') {
        g.textAlign = 'left'
        g.font = `bold 28px ${FONT}`
        g.fillText(d.name, 22, H / 2)
      } else if (d.type === 'pc') {
        g.textAlign = 'center'
        g.fillText(d.name, W / 2, 60)
        g.font = `24px ${FONT}`
        g.fillStyle = '#6b7a90'
        g.fillText('NS-DESK', W / 2, 100)
      } else {
        g.textAlign = 'left'
        g.fillText(d.name, 30, H / 2 - 16)
        g.font = `20px ${FONT}`
        g.fillStyle = '#6b7a90'
        g.fillText(({ router: 'NS-2911 router', switch: 'NS-2960 switch', firewall: 'NS-ASA firewall', server: 'NS-R740 server' } as Record<string, string>)[d.type] ?? '', 30, H / 2 + 20)
      }
      // Port labels.
      g.fillStyle = '#9fb0c4'
      g.font = `bold 17px ${FONT}`
      g.textAlign = 'center'
      for (const s of p.ports) {
        const kind = portKind(d, s.iface)
        const label = kind === 'console' ? 'CON' : kind === 'fiber' && d.type === 'switch' ? `G${s.iface.split('/')[1]}` : d.type === 'switch' ? s.iface.split('/')[1] : s.iface
        g.fillStyle = kind === 'fiber' ? CABLES.fiber.color : kind === 'console' ? CABLES.console.color : '#9fb0c4'
        if (kind === 'console') g.fillText(label, toX(s.x + 0.04), toY(s.y))
        else {
          const dy = d.type === 'switch' ? (s.y > 0 ? 0.03 : -0.03) : d.type === 'ap' ? 0.035 : 0.03
          g.fillText(label, toX(s.x), toY(s.y + dy))
        }
      }
      // Port surrounds.
      g.strokeStyle = '#3a4352'
      g.lineWidth = 3
      for (const s of p.ports) g.strokeRect(toX(s.x) - 0.022 * S, toY(s.y) - 0.018 * S, 0.044 * S, 0.036 * S)
    })
  }

  private plateTexture(r: RackSpot): THREE.CanvasTexture {
    const names = r.deviceIds.map((id) => getDevice(this.topo, id)?.name ?? '?').join(' · ')
    return canvasTexture(512, 128, (g) => {
      g.fillStyle = 'rgba(5,8,13,0.85)'
      g.fillRect(0, 0, 512, 128)
      g.strokeStyle = ACCENT_CSS
      g.lineWidth = 4
      g.strokeRect(2, 2, 508, 124)
      g.fillStyle = ACCENT_CSS
      g.font = `bold 46px ${FONT}`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(r.name.toUpperCase(), 256, 46)
      g.font = `24px ${FONT}`
      g.fillStyle = '#9fb0c4'
      g.fillText(names.length > 34 ? names.slice(0, 33) + '…' : names, 256, 98)
    })
  }

  private disposeGroup(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose()
        mat.dispose()
      }
    })
    if (root === this.world && this.carryMesh) this.carryMesh = null
  }
}
