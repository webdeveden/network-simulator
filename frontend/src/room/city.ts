/**
 * The outside world for the overview: the building's facade, its grounds, roads,
 * a parking lot, street lights, trees, and a night-time city around it.
 * Deterministic (seeded), so the city looks the same every visit.
 */
import * as THREE from 'three'
import type { Box2 } from './layout'

const FONT = "'JetBrains Mono', ui-monospace, monospace"

/** Small seeded random generator, so the city is identical on every load. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function texture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/** Rows of windows, some lit: an office tower at night. */
function windowsTexture(seed: number, warm: boolean) {
  const r = rng(seed)
  return texture(128, 128, (g) => {
    g.fillStyle = '#141a24'
    g.fillRect(0, 0, 128, 128)
    for (let y = 6; y < 128; y += 16)
      for (let x = 6; x < 128; x += 14) {
        const lit = r() < 0.38
        g.fillStyle = lit ? (warm && r() < 0.5 ? '#ffd27a' : '#bfe4ff') : '#1f2836'
        g.fillRect(x, y, 8, 9)
      }
  })
}

export interface CityOptions {
  /** Building footprint (outer walls). */
  building: Box2
  height: number
  /** Corridor end where the front entrance is (west side). */
  entrance: { x: number; z: number }
  /** Doors in the south facade (onto balconies): no cladding there. */
  southOpenings?: { x0: number; x1: number }[]
  /** How far balconies stick out south of the facade (keep the lawn clear of them). */
  extraZ?: number
}

export function buildCity({ building: b, height, entrance, southOpenings = [], extraZ = 0 }: CityOptions): THREE.Group {
  const city = new THREE.Group()
  const r = rng(1337)
  const add = (m: THREE.Object3D) => (city.add(m), m)
  const flat = (w: number, d: number, x: number, z: number, y: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, y, z)
    return add(m)
  }
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(x, y, z)
    return add(m)
  }
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const W = b.maxX - b.minX
  const D = b.maxZ - b.minZ

  // Ground: asphalt city, a lawn around the building, a sidewalk ring.
  const asphaltTex = texture(128, 128, (g) => {
    g.fillStyle = '#1b2029'
    g.fillRect(0, 0, 128, 128)
    for (let k = 0; k < 900; k++) {
      g.fillStyle = k % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.12)'
      g.fillRect((k * 53) % 128, (k * 29 + (k >> 3)) % 128, 2, 2)
    }
  })
  asphaltTex.repeat.set(60, 60)
  flat(600, 600, cx, cz, -0.12, new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.95 }))
  const lawn = { minX: b.minX - 14, maxX: b.maxX + 26, minZ: b.minZ - 10, maxZ: b.maxZ + extraZ + 9 }
  flat(lawn.maxX - lawn.minX, lawn.maxZ - lawn.minZ, (lawn.minX + lawn.maxX) / 2, (lawn.minZ + lawn.maxZ) / 2, -0.09, new THREE.MeshStandardMaterial({ color: 0x1f3a2b, roughness: 1 }))
  flat(W + 4, D + 4, cx, cz, -0.06, new THREE.MeshStandardMaterial({ color: 0x4a5160, roughness: 0.9 }))

  // Facade: window cladding on the outside of the outer walls, and a parapet trim on top.
  const facadeTex = windowsTexture(7, false)
  const facade = (len: number, x: number, z: number, alongX: boolean) => {
    const tex = facadeTex.clone()
    tex.repeat.set(len / 4, 1)
    tex.needsUpdate = true
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35, roughness: 0.6 })
    box(alongX ? len : 0.06, height, alongX ? 0.06 : len, x, height / 2, z, mat)
  }
  facade(W + 0.12, cx, b.minZ - 0.06, true)
  // South facade, with gaps for balcony doors.
  let fx = b.minX - 0.06
  for (const o of [...southOpenings].sort((a, c) => a.x0 - c.x0)) {
    if (o.x0 - fx > 0.05) facade(o.x0 - fx, (fx + o.x0) / 2, b.maxZ + 0.06, true)
    fx = o.x1
  }
  if (b.maxX + 0.06 - fx > 0.05) facade(b.maxX + 0.06 - fx, (fx + b.maxX + 0.06) / 2, b.maxZ + 0.06, true)
  facade(D + 0.12, b.minX - 0.06, cz, false)
  facade(D + 0.12, b.maxX + 0.06, cz, false)
  const trim = new THREE.MeshStandardMaterial({ color: 0x9aa6b8, metalness: 0.6, roughness: 0.4 })
  box(W + 0.4, 0.25, 0.2, cx, height + 0.12, b.minZ - 0.1, trim)
  box(W + 0.4, 0.25, 0.2, cx, height + 0.12, b.maxZ + 0.1, trim)
  box(0.2, 0.25, D + 0.4, b.minX - 0.1, height + 0.12, cz, trim)
  box(0.2, 0.25, D + 0.4, b.maxX + 0.1, height + 0.12, cz, trim)

  // Entrance: glass doors at the corridor's west end, a canopy, and the company sign.
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.35, roughness: 0.05 })
  box(0.08, 2.3, 1.8, b.minX - 0.12, 1.15, entrance.z, glass)
  box(2.6, 0.12, 3.2, b.minX - 1.3, 2.7, entrance.z, trim)
  const signTex = texture(512, 128, (g) => {
    g.fillStyle = '#05080d'
    g.fillRect(0, 0, 512, 128)
    g.strokeStyle = '#22d3ee'
    g.lineWidth = 6
    g.strokeRect(3, 3, 506, 122)
    g.fillStyle = '#39ff88'
    g.font = `bold 64px ${FONT}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('NETSIM HQ', 256, 68)
  })
  const sign = box(6, 1.5, 0.3, b.minX - 6, 1.6, b.maxZ + 3, new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false }))
  sign.rotation.y = 0.5
  box(6.4, 0.5, 0.6, b.minX - 6, 0.25, b.maxZ + 3, trim).rotation.y = 0.5

  // Roads: one in front, one behind, one on each side, with dashed centre lines.
  const road = new THREE.MeshStandardMaterial({ color: 0x12161d, roughness: 0.9 })
  const dash = new THREE.MeshBasicMaterial({ color: 0xd8d2a0, toneMapped: false })
  const zebra = new THREE.MeshBasicMaterial({ color: 0xdfe6ee, toneMapped: false })
  const roadsX = [lawn.minZ - 5, lawn.maxZ + 5] // roads running along x, at these z
  const roadsZ = [lawn.minX - 5, lawn.maxX + 5] // roads running along z, at these x
  for (const z of roadsX) {
    flat(600, 10, cx, z, -0.05, road)
    for (let x = cx - 300; x < cx + 300; x += 6) flat(3, 0.2, x, z, -0.02, dash)
  }
  for (const x of roadsZ) {
    flat(10, 600, x, cz, -0.045, road)
    for (let z = cz - 300; z < cz + 300; z += 6) flat(0.2, 3, x, z, -0.02, dash)
  }
  // Crosswalks at the front corners.
  for (const x of roadsZ) for (let k = -4; k <= 4; k += 1.2) flat(0.7, 3, x + k, roadsX[1] - 6.5, -0.015, zebra)

  // Parking lot east of the building, with a few cars.
  const lot = { x0: b.maxX + 4, x1: lawn.maxX - 2, z0: b.minZ + 1, z1: b.maxZ - 0.5 }
  flat(lot.x1 - lot.x0, lot.z1 - lot.z0, (lot.x0 + lot.x1) / 2, (lot.z0 + lot.z1) / 2, -0.04, road)
  const carColors = [0xc0392b, 0x2e86de, 0xdfe6ee, 0x222831, 0xf1c40f, 0x16a085]
  for (let z = lot.z0 + 1.6; z < lot.z1 - 1.5; z += 3) {
    for (const x of [lot.x0 + 3, lot.x1 - 3]) {
      flat(4.6, 0.1, x, z - 1.5, -0.02, zebra)
      if (r() < 0.65) {
        const paint = new THREE.MeshStandardMaterial({ color: carColors[Math.floor(r() * carColors.length)], metalness: 0.5, roughness: 0.4 })
        box(4.2, 0.8, 1.8, x, 0.55, z, paint)
        box(2.2, 0.6, 1.6, x - 0.2, 1.25, z, new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.2, metalness: 0.4 }))
      }
    }
  }

  // Street lights along the front road, trees around the lawn.
  const pole = new THREE.MeshStandardMaterial({ color: 0x5b6475, metalness: 0.7, roughness: 0.4 })
  const lamp = new THREE.MeshBasicMaterial({ color: 0xffe2a8, toneMapped: false })
  for (let x = lawn.minX; x <= lawn.maxX; x += 12) {
    box(0.15, 6, 0.15, x, 3, roadsX[1] - 6, pole)
    box(1.2, 0.12, 0.3, x, 6, roadsX[1] - 5.5, lamp)
  }
  const trunk = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 })
  const leaves = new THREE.MeshStandardMaterial({ color: 0x2f6b45, roughness: 1 })
  const tree = (x: number, z: number) => {
    const s = 0.8 + r() * 0.6
    const t = add(new THREE.Mesh(new THREE.CylinderGeometry(0.15 * s, 0.2 * s, 2 * s, 6), trunk))
    t.position.set(x, s, z)
    const c = add(new THREE.Mesh(new THREE.SphereGeometry(1.3 * s, 8, 6), leaves))
    c.position.set(x, 2.4 * s, z)
  }
  for (let x = lawn.minX + 2; x < lawn.maxX - 1; x += 5) {
    tree(x, lawn.maxZ - 1.5)
    tree(x + 2.5, lawn.minZ + 1.5)
  }

  // The city: blocks of lit towers beyond the roads.
  const towerTexs = [windowsTexture(11, true), windowsTexture(23, false), windowsTexture(37, true)]
  const block = 26
  for (let gx = -6; gx <= 6; gx++)
    for (let gz = -6; gz <= 6; gz++) {
      const bx = cx + gx * block
      const bz = cz + gz * block
      // Keep the company's own plot and the roads around it clear.
      if (bx > roadsZ[0] - 18 && bx < roadsZ[1] + 18 && bz > roadsX[0] - 18 && bz < roadsX[1] + 18) continue
      if (r() < 0.15) continue
      const n = 1 + Math.floor(r() * 3)
      for (let k = 0; k < n; k++) {
        const w = 6 + r() * 8
        const d = 6 + r() * 8
        const h = 8 + Math.pow(r(), 2) * 55
        const tex = towerTexs[Math.floor(r() * towerTexs.length)].clone()
        tex.repeat.set(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)))
        tex.needsUpdate = true
        const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5, roughness: 0.7 })
        box(w, h, d, bx + (r() - 0.5) * (block - w - 4), h / 2, bz + (r() - 0.5) * (block - d - 4), mat)
      }
    }
  return city
}
