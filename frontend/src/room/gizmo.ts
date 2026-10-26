/**
 * Scene orientation gizmo, like Unity's: X (red), Y (green) and Z (blue) arrows in a
 * corner of the 3D view, turning with the camera. Grey dots mark the negative ends.
 * Clicking an arrow (or dot) tells the scene which way to look.
 */
import * as THREE from 'three'

export type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

export const AXIS_DIR: Record<Axis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
}

const COLORS = { x: 0xff4d5e, y: 0x39ff88, z: 0x4d9bff }
/** Size on screen (CSS px) and where it sits: top-right, under the 2D/3D toggle. */
const SIZE = 96
const TOP = 52
const RIGHT = 10

function label(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.font = 'bold 44px ui-monospace, monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  g.fillText(text, 32, 34)
  const tex = new THREE.CanvasTexture(c)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  s.scale.setScalar(0.55)
  return s
}

export class AxisGizmo {
  readonly scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10)
  private axes = new THREE.Group()
  private pickables: THREE.Object3D[] = []
  private raycaster = new THREE.Raycaster()
  private hovered: Axis | null = null
  private materials = new Map<Axis, THREE.MeshBasicMaterial>()

  constructor() {
    this.camera.position.set(0, 0, 5)
    this.camera.lookAt(0, 0, 0)
    this.scene.add(this.axes)
    // A faint disc behind the arrows so they read on any background.
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.62, 40), new THREE.MeshBasicMaterial({ color: 0x0f1520, transparent: true, opacity: 0.55, depthWrite: false }))
    disc.position.z = -2
    disc.renderOrder = -1
    this.scene.add(disc)
    this.axes.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshBasicMaterial({ color: 0x8892a6 })))
    for (const k of ['x', 'y', 'z'] as const) {
      const dir = AXIS_DIR[`+${k}`]
      const color = COLORS[k]
      const mat = new THREE.MeshBasicMaterial({ color })
      this.materials.set(`+${k}`, mat)
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.85, 8), mat)
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 16), mat)
      const up = new THREE.Vector3(0, 1, 0)
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir)
      shaft.quaternion.copy(q)
      shaft.position.copy(dir).multiplyScalar(0.5)
      cone.quaternion.copy(q)
      cone.position.copy(dir).multiplyScalar(1.05)
      cone.userData.axis = `+${k}`
      shaft.userData.axis = `+${k}`
      const text = label(k.toUpperCase(), color)
      text.position.copy(dir).multiplyScalar(1.48)
      // The negative end: a grey dot.
      const negMat = new THREE.MeshBasicMaterial({ color: 0x5b6475 })
      this.materials.set(`-${k}`, negMat)
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), negMat)
      dot.position.copy(dir).multiplyScalar(-0.95)
      dot.userData.axis = `-${k}`
      this.axes.add(shaft, cone, text, dot)
      this.pickables.push(cone, shaft, dot)
    }
  }

  /** The gizmo's square on screen, in client coordinates. */
  private box(canvas: HTMLCanvasElement) {
    const r = canvas.getBoundingClientRect()
    return { x: r.right - RIGHT - SIZE, y: r.top + TOP, w: SIZE, h: SIZE }
  }

  contains(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
    const b = this.box(canvas)
    return clientX >= b.x && clientX <= b.x + b.w && clientY >= b.y && clientY <= b.y + b.h
  }

  /** The axis under the pointer, or null. */
  axisAt(canvas: HTMLCanvasElement, clientX: number, clientY: number): Axis | null {
    if (!this.contains(canvas, clientX, clientY)) return null
    const b = this.box(canvas)
    const at = new THREE.Vector2(((clientX - b.x) / b.w) * 2 - 1, -((clientY - b.y) / b.h) * 2 + 1)
    this.raycaster.setFromCamera(at, this.camera)
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0]
    return (hit?.object.userData.axis as Axis | undefined) ?? null
  }

  /** Highlights the axis under the pointer (brighter), like Unity. */
  setHover(axis: Axis | null) {
    if (axis === this.hovered) return
    this.hovered = axis
    for (const [k, m] of this.materials) {
      const base = k.startsWith('+') ? COLORS[k[1] as 'x' | 'y' | 'z'] : 0x5b6475
      m.color.setHex(base)
      if (k === axis) m.color.offsetHSL(0, 0, 0.18)
    }
  }

  /** Draws the gizmo in its corner, turned to match `view` (the main camera). */
  render(renderer: THREE.WebGLRenderer, view: THREE.Camera) {
    const canvas = renderer.domElement
    const r = canvas.getBoundingClientRect()
    if (r.width < SIZE * 2 || r.height < SIZE + TOP) return
    this.axes.quaternion.copy(view.quaternion).invert()
    const x = r.width - RIGHT - SIZE
    const y = r.height - TOP - SIZE
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setScissorTest(true)
    renderer.setScissor(x, y, SIZE, SIZE)
    renderer.setViewport(x, y, SIZE, SIZE)
    renderer.clearDepth()
    renderer.render(this.scene, this.camera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, r.width, r.height)
    renderer.autoClear = autoClear
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mat = m.material as THREE.Material | undefined
      if (mat) {
        ;(mat as THREE.SpriteMaterial).map?.dispose()
        mat.dispose()
      }
    })
  }
}

/** Where the gizmo's position readout goes, under the gizmo (CSS px from the top-right). */
export const GIZMO_BOX = { size: SIZE, top: TOP, right: RIGHT }
