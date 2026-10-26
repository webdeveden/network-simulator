/**
 * Draw-call batching. The room is built from many small meshes (desk legs, LEDs,
 * chair parts, wall panels…), each one a separate draw call. Meshes that never
 * change after a build and look the same (same material settings) are merged into
 * one geometry per look, so the GPU draws them in one go.
 *
 * Anything interactive or animated is left alone: the caller's `keep` test skips
 * those objects and everything under them.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

type Mat = THREE.Material & {
  color?: THREE.Color
  emissive?: THREE.Color
  emissiveIntensity?: number
  roughness?: number
  metalness?: number
  flatShading?: boolean
  wireframe?: boolean
  map?: THREE.Texture | null
  alphaMap?: THREE.Texture | null
}

/** Materials that render identically get the same key. */
function lookOf(m: Mat): string {
  return [
    m.type,
    m.color?.getHex(),
    m.emissive?.getHex(),
    m.emissiveIntensity,
    m.roughness,
    m.metalness,
    m.side,
    m.opacity,
    m.toneMapped,
    m.flatShading,
    m.wireframe,
    m.depthTest,
    m.depthWrite,
    m.polygonOffset,
    m.polygonOffsetFactor,
    m.polygonOffsetUnits,
  ].join('|')
}

function mergeable(o: THREE.Object3D, textured: boolean): o is THREE.Mesh {
  const mesh = o as THREE.Mesh
  if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) return false
  if (Array.isArray(mesh.material)) return false
  const m = mesh.material as Mat
  // Textured and see-through surfaces stay separate (unique canvases, draw order).
  if (m.transparent || m.alphaMap || (m.map && !textured)) return false
  if (!mesh.geometry.attributes.position || mesh.geometry.morphAttributes.position) return false
  // A mirrored transform would flip the triangles' winding once baked in.
  return mesh.matrixWorld.determinant() > 0
}

/**
 * Merges the static meshes under `root` (in place). Returns how many draw calls were saved.
 * `keep` returns true for objects to leave untouched, including everything under them.
 */
export function mergeStatic(root: THREE.Object3D, keep: (o: THREE.Object3D) => boolean = () => false, opts: { textured?: boolean } = {}): number {
  root.updateMatrixWorld(true)
  const toRoot = root.matrixWorld.clone().invert()
  const groups = new Map<string, THREE.Mesh[]>()
  const walk = (o: THREE.Object3D) => {
    if (o !== root && (keep(o) || !o.visible)) return
    if (o !== root && mergeable(o, !!opts.textured)) {
      const mat = o.material as Mat
      // Textured meshes merge only when they share the very same material (and texture).
      const k = mat.map ? `tex:${mat.uuid}` : lookOf(mat)
      const list = groups.get(k)
      if (list) list.push(o)
      else groups.set(k, [o])
    }
    for (const c of o.children) walk(c)
  }
  walk(root)

  let saved = 0
  const removedGeos = new Set<THREE.BufferGeometry>()
  const removedMats = new Set<THREE.Material>()
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue
    const m = new THREE.Matrix4()
    const geos = meshes.map((mesh) => {
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
      const textured = !!(mesh.material as Mat).map
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && !(textured && name === 'uv')) g.deleteAttribute(name)
      if (!g.attributes.normal) g.computeVertexNormals()
      g.morphAttributes = {}
      g.clearGroups()
      g.applyMatrix4(m.multiplyMatrices(toRoot, mesh.matrixWorld))
      return g
    })
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) continue
    const batch = new THREE.Mesh(merged, meshes[0].material)
    batch.name = 'batched'
    batch.matrixAutoUpdate = false
    root.add(batch)
    for (const mesh of meshes) {
      mesh.removeFromParent()
      removedGeos.add(mesh.geometry)
      removedMats.add(mesh.material as THREE.Material)
    }
    saved += meshes.length - 1
  }
  // Free what no remaining mesh uses (geometries and materials can be shared).
  const geoInUse = new Set<THREE.BufferGeometry>()
  const matInUse = new Set<THREE.Material>()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    geoInUse.add(mesh.geometry)
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) matInUse.add(mat)
  })
  for (const g of removedGeos) if (!geoInUse.has(g)) g.dispose()
  for (const mat of removedMats) if (!matInUse.has(mat)) mat.dispose()
  return saved
}
