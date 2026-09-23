// F3 (render_3d_model, docs/_arch/verify_native_multimodal_tools_design.md, S2.4): codigo que corre DENTRO de la
// ventana oculta (three.js real) -- bundleado standalone por esbuild (ver package.json, script "model3d:bundle")
// a out/main/model-3d-viewer-bundle.js, servido por model-3d-reader.ts via su protocolo propio. Deliberadamente
// JavaScript plano (no .ts): corre en un contexto de NAVEGADOR (DOM/WebGL), no en Node -- incluirlo como .ts bajo
// src/main/**/*.ts haria que tsconfig.node.json (lib:["ES2022"], sin "DOM") lo typecheckeara con los tipos
// equivocados. esbuild no typecheckea, solo bundlea -- no hace falta un tsconfig aparte para esto.
//
// Expone UNA sola funcion global (window.__amatistaRenderModel) que main llama via executeJavaScript() -- misma
// arquitectura que video-frame-reader.ts (F2): el resultado vuelve como el valor resuelto de esa llamada, sin IPC
// ni preload propio.
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/** Limite real de seguridad (docs/_arch/verify_native_multimodal_tools_design.md S2.4: "<= ~5M triangulos") --
 *  un mesh mas grande no se renderiza (rechazo honesto), en vez de arriesgar colgar/matar la ventana. */
const MAX_TRIANGLES = 5_000_000
const JPEG_QUALITIES = [0.85, 0.7, 0.5]

function loaderFor(format) {
  if (format === 'obj') return new OBJLoader()
  if (format === 'stl') return new STLLoader()
  if (format === 'gltf' || format === 'glb') return new GLTFLoader()
  return null
}

/** OBJLoader -> Group; STLLoader -> BufferGeometry (sin material propio -- el formato STL no lo tiene); GLTFLoader
 *  -> {scene, ...} (glTF/GLB SI traen material/color propios, se preservan tal cual). Material por defecto para
 *  OBJ/STL: gris azulado neutro, ilumina bien con las 2 luces de abajo. */
function toObject3D(format, loaded) {
  if (format === 'stl') {
    const material = new THREE.MeshStandardMaterial({ color: 0x8fa8c2, metalness: 0.1, roughness: 0.7 })
    return new THREE.Mesh(loaded, material)
  }
  if (format === 'gltf' || format === 'glb') return loaded.scene
  // OBJ: OBJLoader ya arma un Group con sus propios materiales default (sin .mtl, que es un archivo
  // COMPANION aparte -- fuera de alcance de v1, mismo criterio que "glTF con recursos externos").
  return loaded
}

function countTriangles(object3d) {
  let triangles = 0
  object3d.traverse(child => {
    if (!child.isMesh || !child.geometry) return
    const geometry = child.geometry
    if (geometry.index) triangles += geometry.index.count / 3
    else if (geometry.attributes && geometry.attributes.position) triangles += geometry.attributes.position.count / 3
  })
  return Math.round(triangles)
}

/** Encuadra la camara desde un angulo 3/4 (isometrico-like) segun la caja envolvente REAL del modelo -- funciona
 *  para cualquier tamano/proporcion sin parametros a mano. */
function frameCamera(box, aspect) {
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  const camera = new THREE.PerspectiveCamera(45, aspect, maxDim / 1000, maxDim * 20)
  const distance = maxDim * 1.8
  camera.position.set(center.x + distance * 0.62, center.y + distance * 0.5, center.z + distance * 0.62)
  camera.lookAt(center)
  return { camera, center, size, maxDim }
}

/**
 * `url`: la ruta bajo ESTE MISMO origen que sirve el archivo del modelo (ver model-3d-reader.ts -- shell, este
 * bundle y el modelo comparten origen a proposito, leccion real de F2: un <video>/textura de OTRO origen deja el
 * canvas "tainted" y toDataURL() tira SecurityError; con three.js el riesgo real es mas acotado -- las texturas
 * EMBEBIDAS de un GLB salen del MISMO buffer ya fetcheado, nunca de una request aparte -- pero se sirve igual bajo
 * el mismo origen, sin excepcion, para no depender de ese razonamiento caso por caso).
 */
window.__amatistaRenderModel = async function renderModel(url, format, options) {
  const loader = loaderFor(format)
  if (!loader) return { ok: false, kind: 'unsupported-format', error: `Formato "${format}" no soportado por render_3d_model.` }

  let loaded
  try {
    loaded = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject))
  } catch (error) {
    return { ok: false, kind: 'load-failed', error: 'No se pudo cargar/parsear el modelo: ' + String((error && error.message) || error) }
  }

  let object3d
  try {
    object3d = toObject3D(format, loaded)
  } catch (error) {
    return { ok: false, kind: 'load-failed', error: 'El archivo no tiene la forma esperada para ' + format + ': ' + String((error && error.message) || error) }
  }

  const triangles = countTriangles(object3d)
  if (triangles === 0) {
    return { ok: false, kind: 'load-failed', error: 'El modelo no tiene ninguna geometria real (0 triangulos) -- puede estar vacio o mal formado.' }
  }
  if (triangles > MAX_TRIANGLES) {
    return { ok: false, kind: 'too-complex', error: `El modelo tiene ${triangles.toLocaleString('es')} triangulos, por encima del limite de ${MAX_TRIANGLES.toLocaleString('es')} de render_3d_model (proteccion contra un render que cuelgue/consuma memoria excesiva).` }
  }

  const box = new THREE.Box3().setFromObject(object3d)
  const size = box.getSize(new THREE.Vector3())
  if (!isFinite(size.x) || !isFinite(size.y) || !isFinite(size.z) || (size.x === 0 && size.y === 0 && size.z === 0)) {
    return { ok: false, kind: 'load-failed', error: 'El modelo no tiene dimensiones reales validas (caja envolvente vacia o infinita).' }
  }

  const width = options.width || 900
  const height = options.height || 675
  // preserveDrawingBuffer:true es necesario para que toDataURL() capture el frame real DESPUES de renderizar --
  // sin esto el buffer puede llegar vacio/parcial (gotcha real y conocido de WebGL para captura offscreen).
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })
  renderer.setSize(width, height, false)
  renderer.setClearColor(0xdcdfe3, 1)

  const scene = new THREE.Scene()
  scene.add(object3d)
  scene.add(new THREE.AmbientLight(0xffffff, 0.65))
  const { camera, center, maxDim } = frameCamera(box, width / height)
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9)
  keyLight.position.set(center.x + maxDim, center.y + maxDim * 2, center.z + maxDim)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.35)
  fillLight.position.set(center.x - maxDim, center.y + maxDim * 0.5, center.z - maxDim)
  scene.add(fillLight)

  try {
    renderer.render(scene, camera)
  } catch (error) {
    renderer.dispose()
    return { ok: false, kind: 'load-failed', error: 'Fallo al renderizar el modelo: ' + String((error && error.message) || error) }
  }

  const capRaw = options.capRaw
  let dataUrl = null
  for (const quality of JPEG_QUALITIES) {
    const candidate = renderer.domElement.toDataURL('image/jpeg', quality)
    const b64Length = candidate.length - candidate.indexOf(',') - 1
    if (!capRaw || b64Length <= capRaw) { dataUrl = candidate; break }
  }
  renderer.dispose()
  if (!dataUrl) return { ok: false, kind: 'too-big', error: 'No se pudo recodificar el render por debajo del limite de tamano de este proveedor.' }

  return {
    ok: true,
    dataUrl,
    triangles,
    dimensions: { x: size.x, y: size.y, z: size.z },
    outWidth: width,
    outHeight: height
  }
}
