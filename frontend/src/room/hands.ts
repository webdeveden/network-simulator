/**
 * First-person hand: a gloved right hand at the bottom-right of the screen, shown
 * only for cable work. It holds the plug while you carry a cable, and reaches out
 * when you plug in or unplug, then goes away. Rendered in its own scene after the
 * room, with a cleared depth buffer, so it never sinks into a rack or a wall.
 */
import * as THREE from 'three'

/** Where the hand rests, in camera space (metres; -z is forward). */
const REST = new THREE.Vector3(0.24, -0.27, -0.5)
const REACH_TIME = 0.32

export class Hands {
  readonly scene = new THREE.Scene()
  private rig = new THREE.Group()
  private hand = new THREE.Group()
  private fingers: THREE.Mesh[] = []
  private plug: THREE.Mesh
  private reachLeft = 0
  /** Direction of the current reach in camera space, from the cursor. */
  private reachDir = new THREE.Vector3(0, 0, -1)
  private bobPhase = 0
  private lastPos = new THREE.Vector3()
  private carrying = false

  constructor() {
    const glove = new THREE.MeshStandardMaterial({ color: 0x2a313d, roughness: 0.7, metalness: 0.1 })
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x151a22, roughness: 0.9 })
    const accent = new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false })
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      m.position.set(x, y, z)
      this.hand.add(m)
      return m
    }
    box(0.085, 0.085, 0.34, sleeve, 0, -0.005, 0.2) // forearm in a jacket sleeve
    box(0.09, 0.012, 0.015, accent, 0, 0.038, 0.035) // glowing cuff
    box(0.078, 0.028, 0.09, glove, 0, 0, -0.04) // palm
    for (let k = 0; k < 4; k++) this.fingers.push(box(0.016, 0.017, 0.065, glove, -0.027 + k * 0.018, 0.002, -0.115))
    const thumb = box(0.02, 0.018, 0.05, glove, -0.048, -0.004, -0.06)
    thumb.rotation.y = 0.6
    // The RJ45/LC plug held between fingers while carrying a cable.
    this.plug = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.016, 0.04), new THREE.MeshStandardMaterial({ color: 0xd8e4f0, roughness: 0.3 }))
    this.plug.position.set(0, 0.014, -0.15)
    this.plug.visible = false
    this.hand.add(this.plug)

    this.hand.rotation.set(0.12, 0.28, 0.08)
    this.rig.add(this.hand)
    this.scene.add(this.rig)
    this.scene.add(new THREE.AmbientLight(0xdde8ff, 1.2))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(-1, 2, 1)
    this.scene.add(key)
  }

  /** Close the fingers around a plug of this colour, or open the hand (null). */
  setCarrying(color: string | null) {
    // Letting go of a cable (plugged in or dropped): one last reach, then the hand goes away.
    if (this.carrying && color === null) this.reach()
    this.carrying = color !== null
    this.plug.visible = color !== null
    if (color) (this.plug.material as THREE.MeshStandardMaterial).color.set(color)
    for (const f of this.fingers) f.rotation.x = color ? -0.7 : 0
  }

  /** Start a short reach towards a camera-space direction (from the cursor, or straight ahead). */
  reach(dir?: THREE.Vector3) {
    this.reachLeft = REACH_TIME
    this.reachDir.copy(dir ?? new THREE.Vector3(0, 0, -1)).normalize()
  }

  /**
   * Follows the camera. `aim` (-1..1 screen coords) nudges the hand towards the
   * cursor in free-cursor mode, so it seems to point at what you hover.
   */
  /** On screen only while carrying a cable or reaching to a port. */
  get showing() {
    return this.carrying || this.reachLeft > 0
  }

  update(camera: THREE.Camera, dt: number, aim: THREE.Vector2 | null) {
    const appearing = !this.rig.visible && this.showing
    this.rig.visible = this.showing
    this.rig.position.copy(camera.position)
    this.rig.quaternion.copy(camera.quaternion)

    const walked = camera.position.distanceTo(this.lastPos)
    this.lastPos.copy(camera.position)
    this.bobPhase += Math.min(walked, 0.2) * 9

    const p = REST.clone()
    if (aim) p.add(new THREE.Vector3(aim.x * 0.08, aim.y * 0.06, 0))
    p.y += Math.sin(this.bobPhase) * 0.012
    p.x += Math.cos(this.bobPhase / 2) * 0.008
    if (this.reachLeft > 0) {
      this.reachLeft = Math.max(0, this.reachLeft - dt)
      // Out and back: a quick sine pulse along the reach direction.
      const k = Math.sin((1 - this.reachLeft / REACH_TIME) * Math.PI)
      p.add(this.reachDir.clone().multiplyScalar(0.16 * k))
    }
    // Coming into view: rise from below the screen edge instead of popping in.
    if (appearing) this.hand.position.copy(p).add(new THREE.Vector3(0, -0.25, 0.1))
    this.hand.position.lerp(p, Math.min(1, dt * 14))
    this.rig.updateMatrixWorld(true)
  }

  /** World position of the plug in the hand: where a carried cable ends. */
  plugWorld(): THREE.Vector3 {
    return this.plug.getWorldPosition(new THREE.Vector3())
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
      mats.forEach((x) => x.dispose())
    })
  }
}
