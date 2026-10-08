/**
 * First-person server room. Owns the Three.js renderer, the camera and the
 * input; the Vue side decides what clicks mean (see RoomView.vue).
 */
import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { CABLES, getDevice, linkActive, linkOn, portKind } from '../engine/network'
import type { Device, Topology } from '../engine/types'
import { collide, CUBE, DESK, MOUNT_GAP, MOUNT_TOP, PARTITION, panelHeight, RACK, rackHasRoom, roomLayout, TRAY_Y, type Cubicle, type Placement, type RackSpot, type RoomLayout } from './layout'

export type Target =
  | { kind: 'port'; deviceId: string; iface: string }
  | { kind: 'door'; rack: number }
  | { kind: 'device'; deviceId: string }
  | { kind: 'cable'; linkId: string }

export interface RackDrag {
  deviceId: string
  rack: number | null
  /** Position in the rack, 0 = top. */
  index: number
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
}

const EYE = 1.65
/** How far you can interact: arm's length with the crosshair, further with the free cursor. */
const REACH_FPS = 3.2
const REACH_FREE = 6
const LOOK_SPEED = 0.004
/** Metres walked per pixel of two-finger scroll. */
const WHEEL_SPEED = 0.006
const PITCH_LIMIT = Math.PI / 2 - 0.05
const WALL_H = 3.1

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
  private world = new THREE.Group()
  private layout: RoomLayout = { placements: [], racks: [], cubicles: [], obstacles: [], bounds: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, spawn: { x: 0, z: 2 }, home: { x: 0, z: 2, look: [0, 1.2, -3] } }
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
  private packet: { curve: THREE.CatmullRomCurve3; start: number; dur: number; forward: boolean; mesh: THREE.Mesh } | null = null
  private flash: Record<string, 'ok' | 'err' | 'hit'> = {}
  private selection: { kind: 'device' | 'link'; id: string } | null = null

  private keys = new Set<string>()
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
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.25
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 80)
    this.camera.position.set(0, EYE, 3)
    this.scene.background = new THREE.Color(COLORS.bg)
    this.scene.fog = new THREE.Fog(COLORS.bg, 22, 50)
    this.scene.add(this.world)
    this.hoverBox.visible = false
    this.scene.add(this.hoverBox)
    this.dropBar.visible = false
    this.scene.add(this.dropBar)
    this.raycaster.far = REACH_FREE

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('lock', () => this.events.lock(true))
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

  /** Back to the starting view: close up in front of rack 1, its door open. */
  resetView() {
    const h = this.layout.home
    this.camera.position.set(h.x, EYE, h.z)
    this.camera.lookAt(...h.look)
    if (h.rack !== undefined) this.openDoors.add(h.rack)
  }

  /** Puts the player at (x, z) looking at a point. Used by `?debug` scripted tests. */
  teleport(x: number, z: number, look: [number, number, number]) {
    this.camera.position.set(x, EYE, z)
    this.camera.lookAt(...look)
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
    for (const r of this.layout.racks) this.buildRack(r)
    for (const c of this.layout.cubicles) this.buildCubicle(c)
    for (const p of this.layout.placements) {
      const d = getDevice(topo, p.deviceId)
      if (!d) continue
      if (p.station === 'rack') {
        const g = new THREE.Group()
        this.buildChassis(g, d, p, 0.4)
        this.world.add(g)
      } else this.buildDesk(d, p)
    }
    topo.links.forEach((l, i) => (l.wifi ? this.buildWifi(l.id) : this.buildCable(l.id, i)))
    if (this.carryFrom && !this.ports.has(this.carryFrom)) this.setCarry(null)

    if (!this.placed) {
      this.resetView()
      this.placed = true
    } else {
      const p = collide(this.layout, this.camera.position.x, this.camera.position.z, 0, 0)
      if (p.x !== this.camera.position.x || p.z !== this.camera.position.z) {
        this.camera.position.set(this.layout.spawn.x, EYE, this.layout.spawn.z)
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

  setSelection(sel: { kind: 'device' | 'link'; id: string } | null) {
    this.selection = sel
    this.applyHighlights()
  }

  /** Shows a loose cable from this port to the player's hand. */
  setCarry(from: { deviceId: string; iface: string } | null) {
    this.carryFrom = from ? portKey(from.deviceId, from.iface) : null
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
    window.removeEventListener('mousemove', this.onLookMove)
    window.removeEventListener('mouseup', this.onLookEnd)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.disposeGroup(this.scene)
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
  private press: { deviceId: string; x: number; y: number } | null = null
  private drag: RackDrag | null = null
  /** Shows where a dragged device would be inserted. */
  private dropBar = new THREE.Mesh(
    new THREE.BoxGeometry(RACK.w - 0.08, 0.012, 0.02),
    new THREE.MeshBasicMaterial({ color: COLORS.ledUp, toneMapped: false }),
  )

  private onMouseDown = (e: MouseEvent) => {
    if (this.controls.isLocked) {
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
    if (e.button === 0) {
      const t = this.hover
      if (t?.kind === 'device' && this.layout.placements.find((p) => p.deviceId === t.deviceId)?.station === 'rack')
        this.press = { deviceId: t.deviceId, x: e.clientX, y: e.clientY }
      this.events.primary(t)
    }
  }

  private onLookMove = (e: MouseEvent) => {
    if (this.press) {
      if (!this.drag && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 6) {
        this.drag = { deviceId: this.press.deviceId, rack: null, index: 0, ok: false }
        this.renderer.domElement.style.cursor = 'grabbing'
      }
      if (this.drag) this.updateDrag(e.clientX, e.clientY)
      return
    }
    if (!this.looking) return
    const euler = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(this.camera.quaternion)
    euler.y -= e.movementX * LOOK_SPEED
    euler.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.x - e.movementY * LOOK_SPEED))
    this.camera.quaternion.setFromEuler(euler)
  }

  private onLookEnd = () => {
    if (this.press) {
      const d = this.drag
      this.press = null
      this.drag = null
      this.dropBar.visible = false
      this.renderer.domElement.style.cursor = ''
      this.applyHighlights()
      if (d) {
        this.events.dragging(null)
        if (d.ok && d.rack !== null) this.events.move(d.deviceId, d.rack, d.index)
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
    if (e.ctrlKey || this.drag) return
    const scale = (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) * WHEEL_SPEED
    const clamp = (v: number) => Math.max(-0.3, Math.min(0.3, v))
    this.step(clamp(e.deltaY * scale), clamp(-e.deltaX * scale))
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
    if (k === 'e') {
      // The console takes focus right away; don't let this E land in it.
      e.preventDefault()
      this.events.use(this.hover)
    } else if (k === 'q') this.events.cancel()
    else if (k === 'r' && !e.repeat) this.resetView()
    else if (k === 'f' && !e.repeat) {
      if (this.controls.isLocked) this.controls.unlock()
      else this.controls.lock()
    } else this.keys.add(e.code)
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
    if (this.roomActive()) this.move(dt)
    else this.keys.clear()
    this.animateDoors(dt)
    this.pick()
    this.animateCarry()
    this.animatePacket()
    this.renderer.render(this.scene, this.camera)
  }

  private move(dt: number) {
    const k = this.keys
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    if (!f && !r) return
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 2.2) * dt
    const len = Math.hypot(f, r)
    this.step((f / len) * speed, (r / len) * speed)
  }

  /** Walks `forward` and `right` metres relative to where the camera faces, with collisions. */
  private step(forward: number, right: number) {
    const fwd = new THREE.Vector3()
    this.camera.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) return
    fwd.normalize()
    const side = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize()
    const v = fwd.multiplyScalar(forward).add(side.multiplyScalar(right))
    // Small sub-steps so a fast swipe can't jump through a thin wall.
    const n = Math.ceil(v.length() / 0.1) || 1
    for (let k = 0; k < n; k++) {
      const p = collide(this.layout, this.camera.position.x, this.camera.position.z, v.x / n, v.z / n)
      this.camera.position.set(p.x, EYE, p.z)
    }
  }

  private animateDoors(dt: number) {
    for (const [id, pivot] of this.doors) {
      const goal = this.openDoors.has(id) ? -1.95 : 0
      pivot.rotation.y += (goal - pivot.rotation.y) * Math.min(1, dt * 8)
    }
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
    // The loose end hangs from your hand (FPS) or follows the cursor (free mode).
    let hand: THREE.Vector3
    if (!this.controls.isLocked && this.pointer) {
      this.raycaster.setFromCamera(this.pointer, this.camera)
      hand = this.raycaster.ray.at(0.6, new THREE.Vector3())
    } else {
      const dir = new THREE.Vector3()
      this.camera.getWorldDirection(dir)
      hand = this.camera.position.clone().add(dir.multiplyScalar(0.45)).add(new THREE.Vector3(0, -0.22, 0))
    }
    const out = from.pos.clone().add(new THREE.Vector3(0, 0, 0.12))
    const mid = out.clone().lerp(hand, 0.5).add(new THREE.Vector3(0, -0.25, 0))
    const curve = new THREE.CatmullRomCurve3([from.pos, out, mid, hand])
    const geo = new THREE.TubeGeometry(curve, 40, 0.0055, 6)
    if (!this.carryMesh) {
      this.carryMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS.cableSel, emissive: COLORS.cableSel, emissiveIntensity: 0.4 }))
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
      mat.emissiveIntensity = f ? 0.55 : selected ? 0.025 : 0
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
    const d = b.maxZ - b.minZ
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
    // Behind the glass partition: raised tiles. In front: office carpet.
    const split = this.layout.partition?.z ?? (this.layout.cubicles.length ? b.minZ : b.maxZ)
    const carpetTex = canvasTexture(256, 256, (g) => {
      g.fillStyle = '#323b4a'
      g.fillRect(0, 0, 256, 256)
      // Speckled weave.
      for (let k = 0; k < 2600; k++) {
        g.fillStyle = k % 3 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.08)'
        g.fillRect((k * 97) % 256, (k * 57 + (k >> 4)) % 256, 2, 2)
      }
    })
    const floorPart = (tex: THREE.CanvasTexture, z0: number, z1: number, tile: number, mat: { roughness: number; metalness: number }) => {
      if (z1 - z0 <= 0) return
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(w / tile, (z1 - z0) / tile)
      const f = new THREE.Mesh(new THREE.PlaneGeometry(w, z1 - z0), new THREE.MeshStandardMaterial({ map: tex, ...mat }))
      f.rotation.x = -Math.PI / 2
      f.position.set(cx, 0, (z0 + z1) / 2)
      this.world.add(f)
    }
    floorPart(floorTex, b.minZ, split, 0.6, { roughness: 0.85, metalness: 0.2 })
    floorPart(carpetTex, split, b.maxZ, 1.0, { roughness: 1, metalness: 0 })
    if (this.layout.partition) this.buildPartition()

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b3442, roughness: 0.95 })
    const walls: [number, number, number, number][] = [
      [cx, b.minZ, w, 0],
      [cx, b.maxZ, w, Math.PI],
      [b.minX, cz, d, Math.PI / 2],
      [b.maxX, cz, d, -Math.PI / 2],
    ]
    for (const [x, z, len, rot] of walls) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, WALL_H), wallMat)
      m.position.set(x, WALL_H / 2, z)
      m.rotation.y = rot
      this.world.add(m)
      // Cyan strip along the bottom of each wall.
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.03), new THREE.MeshBasicMaterial({ color: COLORS.accent, toneMapped: false }))
      strip.position.set(x, 0.12, z)
      strip.rotation.y = rot
      strip.translateZ(0.01)
      this.world.add(strip)
    }
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x3a4352, emissive: 0x1c222c, roughness: 1 }))
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.set(cx, WALL_H, cz)
    this.world.add(ceiling)

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
      for (let z = b.minZ + 1.5; z < b.maxZ - 1; z += 3) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), panelMat)
        p.rotation.x = Math.PI / 2
        p.position.set(x, WALL_H - 0.01, z)
        this.world.add(p)
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

  private buildRack(p: RackSpot) {
    const g = new THREE.Group()
    const metal = new THREE.MeshStandardMaterial({ color: COLORS.metal, metalness: 0.6, roughness: 0.5 })
    const box = (w: number, h: number, dd: number, x: number, y: number, z: number, mat: THREE.Material = metal) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), mat)
      m.position.set(x, y, z)
      g.add(m)
      return m
    }
    const { w, h, d: depth } = RACK
    const zc = p.z - depth / 2
    box(0.02, h, depth, p.x - w / 2 + 0.01, h / 2, zc)
    box(0.02, h, depth, p.x + w / 2 - 0.01, h / 2, zc)
    box(w, 0.04, depth, p.x, h - 0.02, zc)
    box(w, 0.06, depth, p.x, 0.03, zc)
    box(w, h, 0.02, p.x, h / 2, p.z - depth + 0.01)
    // Front posts with mounting holes look.
    const postMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.7, roughness: 0.4 })
    box(0.03, h - 0.1, 0.02, p.x - 0.245, h / 2, p.z - 0.07, postMat)
    box(0.03, h - 0.1, 0.02, p.x + 0.245, h / 2, p.z - 0.07, postMat)

    // Blanking panels fill the empty space under the mounted devices.
    const blank = new THREE.MeshStandardMaterial({ color: 0x0e1218, metalness: 0.4, roughness: 0.7 })
    const mounted = this.layout.placements.filter((x) => x.rack === p.index)
    const lowest = Math.min(h - 0.1, ...mounted.map((x) => x.panel.y - x.panel.h / 2))
    for (let y = 0.15; y < lowest - 0.06; y += 0.1) box(0.44, 0.08, 0.3, p.x, y, p.z - 0.22, blank)

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), new THREE.MeshBasicMaterial({ visible: false }))
    body.position.set(p.x, h / 2, zc)
    body.userData.rack = p.index
    g.add(body)
    this.rackBodies.push(body)

    // Name plate on top of the rack.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.56, 0.14),
      new THREE.MeshBasicMaterial({ map: this.plateTexture(p), transparent: true, toneMapped: false }),
    )
    plate.position.set(p.x, h + 0.12, p.z - 0.02)
    g.add(plate)

    // Glass door on a hinge at the left edge.
    const pivot = new THREE.Group()
    pivot.position.set(p.x - w / 2, 0, p.z + 0.011)
    const frameMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.6, roughness: 0.4 })
    const door = new THREE.Group()
    const bar = (bw: number, bh: number, x: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.02), frameMat)
      m.position.set(x, y, 0)
      door.add(m)
    }
    bar(0.03, h - 0.04, 0.015, h / 2)
    bar(0.03, h - 0.04, w - 0.015, h / 2)
    bar(w, 0.03, w / 2, 0.035)
    bar(w, 0.03, w / 2, h - 0.035)
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(w - 0.06, h - 0.1),
      new THREE.MeshStandardMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0.16, metalness: 0.1, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    )
    glass.position.set(w / 2, h / 2, 0)
    door.add(glass)
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.18, 0.03), new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.9, roughness: 0.2 }))
    handle.position.set(w - 0.05, 1.1, 0.02)
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

  /** Glass wall with aluminium frame between the server room and the office. */
  private buildPartition() {
    const pt = this.layout.partition!
    const frame = new THREE.MeshStandardMaterial({ color: 0x8a96a8, metalness: 0.8, roughness: 0.3 })
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.12, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false })
    const half = PARTITION.door / 2
    const segment = (x0: number, x1: number) => {
      if (x1 - x0 < 0.05) return
      const g = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, PARTITION.h), glass)
      g.position.set((x0 + x1) / 2, PARTITION.h / 2, pt.z)
      this.world.add(g)
      for (const y of [0.05, PARTITION.h - 0.03]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.05, PARTITION.t), frame)
        bar.position.set((x0 + x1) / 2, y, pt.z)
        this.world.add(bar)
      }
      // Mullions every 1.2 m.
      for (let x = x0; x <= x1 + 0.001; x += Math.max(0.6, (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 1.2)))) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.04, PARTITION.h, PARTITION.t), frame)
        m.position.set(x, PARTITION.h / 2, pt.z)
        this.world.add(m)
      }
    }
    segment(pt.minX, pt.doorX - half)
    segment(pt.doorX + half, pt.maxX)
    // Door frame and a sign over it.
    const head = new THREE.Mesh(new THREE.BoxGeometry(PARTITION.door, 0.08, PARTITION.t), frame)
    head.position.set(pt.doorX, PARTITION.h - 0.04, pt.z)
    this.world.add(head)
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.18),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(400, 80, (g) => {
          g.fillStyle = '#05080d'
          g.fillRect(0, 0, 400, 80)
          g.fillStyle = ACCENT_CSS
          g.font = `bold 34px ${FONT}`
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText('SERVER ROOM', 200, 42)
        }),
        toneMapped: false,
      }),
    )
    sign.position.set(pt.doorX, PARTITION.h + 0.14, pt.z + 0.04)
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

  private buildDesk(d: Device, p: Placement) {
    const g = new THREE.Group()
    const wood = new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.8 })
    const top = new THREE.Mesh(new THREE.BoxGeometry(DESK.w, 0.04, DESK.d), wood)
    top.position.set(p.x, DESK.h - 0.02, p.z - DESK.d / 2)
    g.add(top)
    const legMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.8, roughness: 0.3 })
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, DESK.h - 0.04, 0.04), legMat)
        leg.position.set(p.x + sx * (DESK.w / 2 - 0.04), (DESK.h - 0.04) / 2, p.z - DESK.d / 2 + sz * (DESK.d / 2 - 0.04))
        g.add(leg)
      }
    if (d.type === 'pc') this.buildPc(g, d, p, legMat)
    else if (d.type === 'laptop') this.buildLaptop(g, d, p)
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
    // Monitor showing the host's prompt.
    const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.34, 0.03), new THREE.MeshStandardMaterial({ color: 0x0b0e13 }))
    monitor.position.set(p.x + 0.15, DESK.h + 0.3, p.z - DESK.d + 0.18)
    g.add(this.target(monitor, { kind: 'device', deviceId: d.id }))
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.3), new THREE.MeshBasicMaterial({ map: this.screenTexture(d, []), toneMapped: false }))
    screen.position.set(0, 0, 0.016)
    monitor.add(screen)
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.05), legMat)
    stand.position.set(p.x + 0.15, DESK.h + 0.07, p.z - DESK.d + 0.18)
    g.add(stand)
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.14), new THREE.MeshStandardMaterial({ color: 0x151a22 }))
    kb.position.set(p.x + 0.15, DESK.h + 0.01, p.z - 0.18)
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
      }[kind]
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
    const end = (e: { pos: THREE.Vector3; station: Placement['station'] }) => {
      const p = e.pos
      if (e.station === 'rack')
        return [p, new THREE.Vector3(p.x, p.y, p.z + 0.045), new THREE.Vector3(p.x, 1.95, p.z + 0.03), new THREE.Vector3(p.x, trayY, p.z - 0.2)]
      return [p, new THREE.Vector3(p.x, p.y, p.z + 0.1), new THREE.Vector3(p.x, p.y + 0.6, p.z + 0.12), new THREE.Vector3(p.x, trayY, p.z + 0.1)]
    }
    const pts = [...end(a), ...end(b).reverse()]
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
    this.curves.set(linkId, curve)
    const radius = l.cable === 'fiber' ? 0.0035 : l.cable === 'console' ? 0.0045 : 0.0055
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius, 6), new THREE.MeshStandardMaterial({ color: COLORS.cable, roughness: 0.6 }))
    this.world.add(this.target(mesh, { kind: 'cable', linkId }))
    this.cableMeshes.set(linkId, mesh)
  }

  private panelTexture(d: Device, p: Placement): THREE.CanvasTexture {
    const S = 1600
    const W = Math.round(p.panel.w * S)
    const H = Math.round(p.panel.h * S)
    const color = TYPE_COLOR[d.type]
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
      if (d.type === 'laptop') return
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
      g.fillText(`RACK ${r.index + 1}`, 256, 46)
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
