/**
 * First-person hand: a right hand at the bottom-right of the screen, shown only for
 * cable work. Jointed fingers move between poses: relaxed, a pinch grip around the
 * plug while you carry a cable, and pointing when you reach for a port. Rendered in
 * its own scene after the room, with a cleared depth buffer, so it never sinks into
 * a rack or a wall.
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

/** Where the hand rests, in camera space (metres; -z is forward). */
const REST = new THREE.Vector3(0.22, -0.25, -0.46)
const REACH_TIME = 0.32

/** Finger curl per joint (radians, base → tip). */
type Curl = [number, number, number]
interface Pose {
  fingers: [Curl, Curl, Curl, Curl]
  /** Thumb: swing towards the palm, then bend. */
  thumb: [number, number]
}

const POSES: Record<'relaxed' | 'grip' | 'point', Pose> = {
  relaxed: { fingers: [[0.25, 0.35, 0.2], [0.3, 0.4, 0.25], [0.35, 0.45, 0.3], [0.45, 0.5, 0.35]], thumb: [0.25, 0.2] },
  // Pinch: index and thumb close round the plug, the other fingers tucked in.
  grip: { fingers: [[0.75, 0.8, 0.5], [1.15, 1.35, 0.9], [1.25, 1.4, 0.95], [1.3, 1.45, 1.0]], thumb: [0.75, 0.45] },
  point: { fingers: [[0.05, 0.05, 0.05], [1.2, 1.4, 0.9], [1.3, 1.45, 0.95], [1.35, 1.5, 1.0]], thumb: [0.6, 0.4] },
}

/** A capsule from `a` to `b` (local coordinates of `parent`). */
function capsule(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) {
  const len = Math.max(0.001, a.distanceTo(b))
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat)
  m.position.copy(a).add(b).multiplyScalar(0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  parent.add(m)
  return m
}

export class Hands {
  readonly scene = new THREE.Scene()
  private rig = new THREE.Group()
  private hand = new THREE.Group()
  /** Joint pivots: per finger [base, middle, tip]; thumb [base, tip]. */
  private joints: THREE.Group[][] = []
  private thumb: THREE.Group[] = []
  private plug: THREE.Mesh
  private reachLeft = 0
  /** Direction of the current reach in camera space, from the cursor. */
  private reachDir = new THREE.Vector3(0, 0, -1)
  private bobPhase = 0
  private lastPos = new THREE.Vector3()
  private carrying = false
  private pose: Pose = POSES.relaxed

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a582, roughness: 0.62, metalness: 0, emissive: 0x2a1208, emissiveIntensity: 0.25 })
    const nail = new THREE.MeshStandardMaterial({ color: 0xf0cdb8, roughness: 0.3 })
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x1d2633, roughness: 0.85 })
    const cuff = new THREE.MeshStandardMaterial({ color: 0x141a23, roughness: 0.9 })
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, roughness: 0.3, metalness: 0.8 })
    const face = new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false })
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

    // Forearm in a jacket sleeve, the wrist, and a watch.
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.052, 0.34, 18, 1, true), sleeve)
    arm.rotation.x = Math.PI / 2
    arm.position.set(0, -0.004, 0.215)
    const cuffRing = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.008, 8, 22), cuff)
    cuffRing.position.set(0, -0.004, 0.046)
    capsule(this.hand, v(0, -0.004, 0.06), v(0, -0.002, 0.0), 0.031, skin) // wrist
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.033, 0.006, 6, 20), new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.7 }))
    band.position.set(0, -0.003, 0.026)
    const watch = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.009, 0.034, 2, 0.004), steel)
    watch.position.set(0, 0.031, 0.026)
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.022, 0.026), face)
    glass.rotation.x = -Math.PI / 2
    glass.position.set(0, 0.0362, 0.026)
    this.hand.add(arm, cuffRing, band, watch, glass)

    // Palm: a rounded slab, a little wider at the knuckles, with the thumb's muscle pad.
    const palm = new THREE.Mesh(new RoundedBoxGeometry(0.084, 0.03, 0.094, 3, 0.012), skin)
    palm.position.set(0.002, 0, -0.045)
    const pad = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), skin)
    pad.scale.set(1, 0.7, 1.4)
    pad.position.set(-0.03, -0.006, -0.02)
    this.hand.add(palm, pad)

    // Four fingers: index (thumb side, -x) to pinky. Each joint is a pivot that curls about x.
    const fingers = [
      { x: -0.029, lens: [0.042, 0.026, 0.021], r: 0.0092, z: -0.094 },
      { x: -0.009, lens: [0.046, 0.029, 0.022], r: 0.0095, z: -0.097 },
      { x: 0.011, lens: [0.043, 0.027, 0.021], r: 0.009, z: -0.095 },
      { x: 0.03, lens: [0.034, 0.021, 0.018], r: 0.0082, z: -0.088 },
    ]
    for (const f of fingers) {
      const chain: THREE.Group[] = []
      let parent: THREE.Object3D = this.hand
      let at = v(f.x, 0.002, f.z)
      f.lens.forEach((len, k) => {
        const j = new THREE.Group()
        j.position.copy(at)
        parent.add(j)
        const r = f.r * (1 - k * 0.1)
        capsule(j, v(0, 0, 0), v(0, 0, -len), r, skin)
        if (k === 2) {
          const n = new THREE.Mesh(new RoundedBoxGeometry(r * 1.5, 0.003, len * 0.6, 2, 0.0012), nail)
          n.position.set(0, r * 0.85, -len * 0.55)
          j.add(n)
        }
        chain.push(j)
        parent = j
        at = v(0, 0, -len)
      })
      this.joints.push(chain)
    }

    // Thumb: from the side of the palm, angled out and forward.
    const tBase = new THREE.Group()
    tBase.position.set(-0.04, -0.006, -0.03)
    tBase.rotation.set(0, 0.75, -0.35)
    this.hand.add(tBase)
    capsule(tBase, v(0, 0, 0), v(0, 0, -0.036), 0.0115, skin)
    const tTip = new THREE.Group()
    tTip.position.set(0, 0, -0.036)
    tBase.add(tTip)
    capsule(tTip, v(0, 0, 0), v(0, 0, -0.026), 0.0105, skin)
    const tn = new THREE.Mesh(new RoundedBoxGeometry(0.014, 0.003, 0.016, 2, 0.0012), nail)
    tn.position.set(0, 0.0095, -0.017)
    tTip.add(tn)
    this.thumb = [tBase, tTip]

    // The RJ45/LC plug pinched between thumb and index finger while carrying a cable.
    this.plug = new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.015, 0.038, 2, 0.003), new THREE.MeshStandardMaterial({ color: 0xd8e4f0, roughness: 0.3 }))
    this.plug.position.set(-0.03, -0.012, -0.118)
    this.plug.visible = false
    this.hand.add(this.plug)

    this.hand.rotation.set(0.1, 0.3, 0.18)
    this.applyPose(this.pose, 1)
    this.rig.add(this.hand)
    this.scene.add(this.rig)
    // Soft sky/ground fill plus a key light from above-left, so skin reads as rounded.
    this.scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x3a3026, 1.1))
    const key = new THREE.DirectionalLight(0xfff4ea, 1.6)
    key.position.set(-1, 2, 1)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x9fd8ff, 0.5)
    rim.position.set(1, 0.5, -1)
    this.scene.add(rim)
  }

  /** Moves the joints a fraction `k` of the way towards `p`. */
  private applyPose(p: Pose, k: number) {
    this.joints.forEach((chain, f) => chain.forEach((j, n) => (j.rotation.x += (-p.fingers[f][n] - j.rotation.x) * k)))
    const [swing, bend] = p.thumb
    this.thumb[0].rotation.y += (0.75 - swing * 0.6 - this.thumb[0].rotation.y) * k
    this.thumb[0].rotation.x += (-swing * 0.35 - this.thumb[0].rotation.x) * k
    this.thumb[1].rotation.x += (-bend - this.thumb[1].rotation.x) * k
  }

  /** Close the fingers around a plug of this colour, or open the hand (null). */
  setCarrying(color: string | null) {
    // Letting go of a cable (plugged in or dropped): one last reach, then the hand goes away.
    if (this.carrying && color === null) this.reach()
    this.carrying = color !== null
    this.plug.visible = color !== null
    if (color) (this.plug.material as THREE.MeshStandardMaterial).color.set(color)
  }

  /** Start a short reach towards a camera-space direction (from the cursor, or straight ahead). */
  reach(dir?: THREE.Vector3) {
    this.reachLeft = REACH_TIME
    this.reachDir.copy(dir ?? new THREE.Vector3(0, 0, -1)).normalize()
  }

  /** On screen only while carrying a cable or reaching to a port. */
  get showing() {
    return this.carrying || this.reachLeft > 0
  }

  /**
   * Follows the camera. `aim` (-1..1 screen coords) nudges the hand towards the
   * cursor in free-cursor mode, so it seems to point at what you hover.
   */
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
    // Pinch while holding a plug; point while reaching with an empty hand.
    const target = this.carrying ? POSES.grip : this.reachLeft > 0 ? POSES.point : POSES.relaxed
    if (appearing) this.applyPose(target, 1)
    else this.applyPose(target, Math.min(1, dt * 12))
    // Coming into view: rise from below the screen edge instead of popping in.
    if (appearing) this.hand.position.copy(p).add(new THREE.Vector3(0, -0.25, 0.1))
    this.hand.position.lerp(p, Math.min(1, dt * 14))
    // A slight idle sway of the wrist.
    this.hand.rotation.z = 0.18 + Math.sin(performance.now() / 900) * 0.015
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
