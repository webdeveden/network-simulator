/**
 * People in the building, built from rounded shapes (capsules, spheres, rounded
 * boxes) in a few poses. Each person gets a look from a seed: skin tone, hair style
 * and colour, clothes, height, sometimes glasses. The head and the forearms are
 * separate groups so the scene can animate them (looking around, typing, scrolling)
 * while the rest of the body is merged with the other static meshes.
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export type Pose = 'sit-laptop' | 'sit-phone' | 'stand-phone' | 'stand-railing'

export interface Person {
  group: THREE.Group
  /** Turns about the neck. */
  head: THREE.Group
  /** Forearms and hands: bob for typing or scrolling. */
  hands: THREE.Group
  pose: Pose
  phase: number
}

const SKIN = [0xf1c8a5, 0xe0ac69, 0xc68642, 0x8d5524, 0x6b4423, 0x4a2f1b]
const HAIR = [0x0e0e0e, 0x2b2018, 0x5a3825, 0x8a5a2b, 0xc9a26b, 0x7d7d80]
const SHIRT = [0x2e86de, 0xc0392b, 0x16a085, 0x8e44ad, 0xe67e22, 0x34495e, 0xecf0f1, 0x27ae60, 0xd4a017]
const PANTS = [0x22262e, 0x2f3d5c, 0x4a3a2a, 0x3b3f45, 0x1c2b4a]
const SHOES = [0x18191c, 0x5a3b22, 0xe8e8e8, 0x2a2f38]
type Hair = 'short' | 'long' | 'bun' | 'bald' | 'ponytail'
const HAIRSTYLES: Hair[] = ['short', 'long', 'short', 'bun', 'ponytail', 'bald', 'long', 'short']

/** Small deterministic random numbers from a seed, so a person looks the same after every rebuild. */
function rng(seed: number) {
  let s = (Math.floor(Math.abs(seed) * 9973) % 2147483646) + 1
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
}

/** A fresh material (the scene disposes them on rebuild); same colours still merge into one draw call. */
function mat(color: number, roughness = 0.8, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...extra })
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** A capsule between two points, optionally squashed across (sx, sz) for torsos. */
function limb(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, sx = 1, sz = 1) {
  const len = Math.max(0.001, a.distanceTo(b))
  const holder = new THREE.Group()
  holder.position.copy(a).add(b).multiplyScalar(0.5)
  holder.quaternion.setFromUnitVectors(v(0, 1, 0), b.clone().sub(a).normalize())
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 12), m)
  mesh.scale.set(sx, 1, sz)
  holder.add(mesh)
  parent.add(holder)
  return holder
}

function ball(parent: THREE.Object3D, at: THREE.Vector3, r: number, m: THREE.Material, scale?: [number, number, number]) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m)
  mesh.position.copy(at)
  if (scale) mesh.scale.set(...scale)
  parent.add(mesh)
  return mesh
}

function rbox(parent: THREE.Object3D, w: number, h: number, d: number, at: THREE.Vector3, m: THREE.Material, radius = 0.02) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2)), m)
  mesh.position.copy(at)
  parent.add(mesh)
  return mesh
}

/** Head on a pivot at the top of the neck: face, ears, nose, hair, maybe glasses. */
function buildHead(neckTop: THREE.Vector3, look: ReturnType<typeof lookOf>, tilt: number): THREE.Group {
  const head = new THREE.Group()
  head.position.copy(neckTop)
  head.rotation.x = tilt
  const c = v(0, 0.115, 0.01)
  ball(head, c, 0.1, look.skin, [0.88, 1.08, 1])
  ball(head, v(0, 0.06, 0.07), 0.055, look.skin, [1, 0.8, 0.9]) // jaw and chin
  for (const sx of [-1, 1]) ball(head, v(sx * 0.088, 0.11, 0.0), 0.022, look.skin, [0.5, 1, 0.8]) // ears
  limb(head, v(0, 0.125, 0.095), v(0, 0.095, 0.11), 0.012, look.skin) // nose
  for (const sx of [-1, 1]) ball(head, v(sx * 0.034, 0.135, 0.088), 0.009, look.eyes) // eyes
  const hairM = look.hair
  if (look.style !== 'bald') {
    // A cap of hair over the top and back of the head.
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.106, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), hairM)
    cap.scale.set(0.92, 1.08, 1.04)
    cap.position.set(0, 0.125, -0.002)
    cap.rotation.x = -0.25
    head.add(cap)
  }
  if (look.style === 'long') limb(head, v(0, 0.13, -0.06), v(0, -0.07, -0.08), 0.075, hairM, 1.25, 0.55)
  if (look.style === 'bun') ball(head, v(0, 0.2, -0.08), 0.045, hairM)
  if (look.style === 'ponytail') limb(head, v(0, 0.16, -0.1), v(0, 0.0, -0.13), 0.028, hairM)
  if (look.glasses) {
    const frame = look.dark
    for (const sx of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0035, 6, 16), frame)
      rim.position.set(sx * 0.036, 0.135, 0.1)
      head.add(rim)
    }
    limb(head, v(-0.014, 0.137, 0.104), v(0.014, 0.137, 0.104), 0.003, frame)
  }
  return head
}

function lookOf(seed: number) {
  const r = rng(seed)
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)]
  return {
    skin: mat(pick(SKIN), 0.6, { emissive: 0x1a0b05, emissiveIntensity: 0.2 }),
    hair: mat(pick(HAIR), 0.9),
    shirt: mat(pick(SHIRT), 0.85),
    pants: mat(pick(PANTS), 0.85),
    shoes: mat(pick(SHOES), 0.5),
    eyes: mat(0x1b1b1f, 0.3),
    dark: mat(0x15171b, 0.4),
    style: pick(HAIRSTYLES),
    glasses: r() < 0.3,
    height: 0.94 + r() * 0.12,
    build: 0.92 + r() * 0.18,
  }
}

/**
 * A person facing +z, standing on the floor at the origin. Sitting poses fit the
 * lounge chairs (seat at 0.42 m); `stand-*` poses lean on a railing ahead (z ≈ +0.4).
 */
export function buildPerson(pose: Pose, seed: number): Person {
  const look = lookOf(seed)
  const g = new THREE.Group()
  const hands = new THREE.Group()
  const sitting = pose.startsWith('sit')
  const w = look.build

  // Legs and shoes.
  if (sitting) {
    for (const sx of [-1, 1]) {
      const hip = v(sx * 0.09 * w, 0.48, -0.06)
      const knee = v(sx * 0.1 * w, 0.52, 0.32)
      const ankle = v(sx * 0.11 * w, 0.1, 0.4)
      limb(g, hip, knee, 0.068 * w, look.pants)
      limb(g, knee, ankle, 0.055 * w, look.pants)
      rbox(g, 0.09, 0.075, 0.23, v(sx * 0.11 * w, 0.04, 0.47), look.shoes, 0.03)
    }
  } else {
    for (const sx of [-1, 1]) {
      const hip = v(sx * 0.09 * w, 0.92, 0)
      const knee = v(sx * 0.095 * w, 0.5, 0.025)
      const ankle = v(sx * 0.1 * w, 0.09, 0)
      limb(g, hip, knee, 0.07 * w, look.pants)
      limb(g, knee, ankle, 0.056 * w, look.pants)
      rbox(g, 0.09, 0.075, 0.24, v(sx * 0.1 * w, 0.04, 0.06), look.shoes, 0.03)
    }
  }

  // Torso: hips, belly and chest as squashed capsules; then the neck.
  const pelvis = sitting ? v(0, 0.52, -0.08) : v(0, 0.98, 0)
  const chest = sitting ? v(0, 0.92, -0.17) : v(0, 1.36, 0.01)
  limb(g, pelvis, pelvis.clone().lerp(chest, 0.45), 0.12 * w, look.pants, 1.35, 0.8)
  limb(g, pelvis.clone().lerp(chest, 0.25), chest, 0.13 * w, look.shirt, 1.42, 0.82)
  const shoulderY = chest.y + 0.05
  for (const sx of [-1, 1]) ball(g, v(sx * 0.165 * w, shoulderY - 0.01, chest.z), 0.056 * w, look.shirt, [1, 0.85, 1])
  const neckBase = v(0, shoulderY + 0.03, chest.z)
  const neckTop = neckBase.clone().add(v(0, 0.075, 0.01))
  limb(g, neckBase, neckTop, 0.045, look.skin)

  // Arms: upper arms on the body; forearms and hands in their own group (animated).
  const shoulder = (sx: number) => v(sx * 0.19 * w, shoulderY - 0.02, chest.z)
  const arm = (sx: number, elbow: THREE.Vector3, wrist: THREE.Vector3, hand: THREE.Vector3) => {
    limb(g, shoulder(sx), elbow, 0.05 * w, look.shirt)
    limb(hands, elbow, wrist, 0.042 * w, look.shirt)
    limb(hands, wrist, hand, 0.03, look.skin, 1.15, 0.7)
  }
  let headTilt = 0.08
  if (pose === 'sit-laptop') {
    for (const sx of [-1, 1]) arm(sx, v(sx * 0.22 * w, 0.76, -0.04), v(sx * 0.11, 0.66, 0.15), v(sx * 0.085, 0.655, 0.22))
    headTilt = 0.35 // looking down at the screen
  } else if (pose === 'sit-phone') {
    arm(1, v(0.22 * w, 0.74, -0.02), v(0.12, 0.76, 0.16), v(0.1, 0.79, 0.22))
    arm(-1, v(-0.22 * w, 0.74, -0.02), v(-0.04, 0.75, 0.16), v(0.03, 0.77, 0.21))
    headTilt = 0.45
  } else if (pose === 'stand-phone') {
    arm(1, v(0.21 * w, 1.1, 0.08), v(0.18, 1.24, 0.28), v(0.19, 1.29, 0.34))
    arm(-1, v(-0.21 * w, 1.1, 0.12), v(-0.2, 1.06, 0.36), v(-0.19, 1.06, 0.44)) // forearm on the railing
    headTilt = 0.4
  } else {
    for (const sx of [-1, 1]) arm(sx, v(sx * 0.21 * w, 1.1, 0.12), v(sx * 0.2, 1.06, 0.36), v(sx * 0.19, 1.06, 0.44))
  }
  g.add(hands)
  const head = buildHead(neckTop, look, headTilt)
  g.add(head)
  head.userData.anim = true
  hands.userData.anim = true
  g.scale.setScalar(look.height)
  return { group: g, head, hands, pose, phase: (Math.abs(seed) * 7.31) % (Math.PI * 2) }
}

/** Idle motion: look around, type in bursts, scroll a phone. `t` in seconds. */
export function animatePerson(p: Person, t: number) {
  const ph = p.phase
  const baseTilt = p.pose === 'sit-laptop' ? 0.35 : p.pose === 'stand-railing' ? 0.08 : 0.42
  const glance = Math.sin(t * 0.23 + ph) > 0.85 ? 0.35 : 0
  p.head.rotation.y = Math.sin(t * 0.35 + ph) * 0.12 + glance * Math.sin(t * 0.9 + ph)
  p.head.rotation.x = baseTilt + Math.sin(t * 0.5 + ph * 2) * 0.03 - glance * 0.2
  if (p.pose === 'sit-laptop') {
    const typing = Math.sin(t * 0.7 + ph) > -0.2
    p.hands.position.y = typing ? Math.abs(Math.sin(t * 17 + ph)) * 0.005 : 0
  } else if (p.pose === 'sit-phone' || p.pose === 'stand-phone') {
    p.hands.position.y = Math.sin(t * 1.4 + ph) * 0.003
  }
}
