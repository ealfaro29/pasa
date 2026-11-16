import {
  Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, GridHelper,
  Group, HemisphereLight, Matrix4, Mesh, MeshStandardMaterial,
  PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { inspectSTL, inspect3MF, crc32 } from './model-format.js';

const MAX_TRIANGLES = 2_000_000;
const MAX_INSTANCES = 2048;
const UNITS_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const DEFAULT_COLOR = new Color('#9bb47c');
const decoder = new TextDecoder('utf-8', { fatal: true });
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException('Vista previa cerrada.', 'AbortError');
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('No se pudo leer el modelo.');
}

function child(node, name) {
  return [...node.children].find(value => value.localName === name);
}

function children(node, name) {
  return node ? [...node.children].filter(value => value.localName === name) : [];
}

function number(value) {
  if (value === null || value.trim() === '') throw new Error('El modelo tiene coordenadas incompletas.');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e12) throw new Error('El modelo tiene coordenadas no válidas.');
  return parsed;
}

function index(value, length) {
  if (!/^(0|[1-9]\d*)$/.test(value || '')) throw new Error('El modelo contiene un índice no válido.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result >= length) throw new Error('Una cara del modelo apunta a un vértice que no existe.');
  return result;
}

function resolvePath(value, from = '') {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f]/.test(value) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
    throw new Error('El 3MF contiene una referencia externa o no válida.');
  }
  let path;
  try { path = decodeURIComponent(value.split(/[?#]/, 1)[0]); } catch { throw new Error('El 3MF contiene una ruta no válida.'); }
  const segments = path.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!segments.length) throw new Error('El 3MF contiene una ruta fuera del archivo.');
      segments.pop();
    } else segments.push(part);
  }
  return segments.join('/');
}

async function readEntry(source, entry, signal) {
  abortIfNeeded(signal);
  const compressed = source.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let bytes;
  if (entry.method === 0) bytes = compressed;
  else {
    if (typeof DecompressionStream === 'undefined') throw new Error('Actualiza tu navegador para abrir archivos 3MF.');
    let stream;
    try { stream = new DecompressionStream('deflate-raw'); }
    catch { throw new Error('Este navegador no admite la compresión de este 3MF. Prueba con una versión reciente.'); }
    const reader = new Blob([compressed]).stream().pipeThrough(stream).getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        abortIfNeeded(signal);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > entry.uncompressedSize) throw new Error('El contenido del 3MF supera el tamaño declarado.');
        parts.push(value);
      }
      if (size !== entry.uncompressedSize) throw new Error('El archivo 3MF está incompleto.');
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    } catch (error) {
      try { await reader.cancel(); } catch {}
      throw error;
    }
  }
  if (bytes.byteLength !== entry.uncompressedSize || crc32(bytes) !== entry.crc) throw new Error('El archivo 3MF está dañado o incompleto.');
  return bytes;
}

function xml(bytes) {
  let text;
  try { text = typeof bytes === 'string' ? bytes : decoder.decode(bytes); } catch { throw new Error('El XML del 3MF no es válido.'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('El 3MF contiene XML no admitido.');
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('El archivo 3MF contiene un modelo XML no válido.');
  return document;
}

function matrix(value) {
  if (!value) return new Matrix4();
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 12) throw new Error('El 3MF contiene una transformación incompleta.');
  const t = parts.map(number);
  return new Matrix4().set(t[0], t[3], t[6], t[9], t[1], t[4], t[7], t[10], t[2], t[5], t[8], t[11], 0, 0, 0, 1);
}

function displayColor(value) {
  if (!/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value || '')) return DEFAULT_COLOR;
  return new Color().setStyle(value.slice(0, 7), SRGBColorSpace);
}

function disposeObject(object) {
  const geometries = new Set();
  const materials = new Set();
  object?.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

// 3MF Production Extension paths and object IDs are scoped to their model part.
// The geometry parser never loads external references or executes archive data.
async function parse3MF(bytes, signal) {
  const archive = inspect3MF(bytes);
  const entries = new Map(archive.entries.map(entry => [entry.name, entry]));
  const rootRels = entries.get('_rels/.rels');
  if (!rootRels) throw new Error('El 3MF no contiene su archivo de relaciones.');
  const relationships = xml(await readEntry(bytes, rootRels, signal));
  const relation = [...relationships.getElementsByTagNameNS('*', 'Relationship')].find(node => /\/3dmodel$/.test(node.getAttribute('Type') || ''));
  if (!relation || relation.getAttribute('TargetMode') === 'External') throw new Error('El 3MF no contiene un modelo local para mostrar.');
  const rootPath = resolvePath(relation.getAttribute('Target'));
  const models = new Map();
  let sourceTriangles = 0;
  let sourceVertices = 0;
  for (const entry of archive.entries.filter(entry => /\.model$/i.test(entry.name))) {
    abortIfNeeded(signal);
    const data = await readEntry(bytes, entry, signal);
    // Count before constructing a potentially expensive XML tree.
    let text;
    try { text = decoder.decode(data); } catch { throw new Error('El XML del 3MF no es válido.'); }
    for (const _ of text.matchAll(/<(?:[\w.-]+:)?triangle(?:\s|\/?>)/g)) {
      if (++sourceTriangles > MAX_TRIANGLES) throw new Error('Este modelo es demasiado complejo para la vista previa. Puedes descargarlo para abrirlo en tu programa 3D.');
    }
    for (const _ of text.matchAll(/<(?:[\w.-]+:)?vertex(?:\s|\/?>)/g)) {
      if (++sourceVertices > MAX_TRIANGLES * 3) throw new Error('Este modelo es demasiado complejo para la vista previa. Puedes descargarlo para abrirlo en tu programa 3D.');
    }
    const document = xml(text);
    const model = document.documentElement;
    if (model.localName !== 'model') throw new Error('El 3MF no contiene un modelo válido.');
    const unitName = model.getAttribute('unit') || 'millimeter';
    const unit = Object.hasOwn(UNITS_MM, unitName) ? UNITS_MM[unitName] : undefined;
    if (!unit) throw new Error('El 3MF utiliza una unidad de medida no admitida.');
    const resources = child(model, 'resources');
    const objects = new Map();
    for (const object of children(resources, 'object')) {
      const id = object.getAttribute('id');
      if (!id || objects.has(id)) throw new Error('El 3MF contiene objetos duplicados o sin identificador.');
      objects.set(id, object);
    }
    const colors = new Map();
    for (const resource of resources?.children || []) {
      if (resource.localName === 'basematerials' || resource.localName === 'colorgroup') {
        const attribute = resource.localName === 'basematerials' ? 'displaycolor' : 'color';
        colors.set(resource.getAttribute('id'), [...resource.children].map(node => displayColor(node.getAttribute(attribute))));
      }
    }
    models.set(entry.name, { path: entry.name, unit, model, objects, colors });
    await nextFrame();
  }
  const root = models.get(rootPath);
  if (!root) throw new Error('No se encontró el modelo principal dentro del 3MF.');

  function reference(node, from) {
    const pathAttribute = [...node.attributes].find(attribute => attribute.localName === 'path');
    const source = pathAttribute ? models.get(resolvePath(pathAttribute.value, from.path)) : from;
    const id = node.getAttribute('objectid');
    if (!source || !source.objects.has(id)) throw new Error('El 3MF hace referencia a una pieza que no está incluida.');
    return { source, id };
  }

  const statistics = new Map();
  const walking = new Set();
  function measure(source, id, depth = 0) {
    const key = JSON.stringify([source.path, id]);
    if (depth > 64 || walking.has(key)) throw new Error('El 3MF contiene componentes circulares o demasiados niveles de piezas.');
    if (statistics.has(key)) return statistics.get(key);
    walking.add(key);
    const object = source.objects.get(id);
    const mesh = child(object, 'mesh');
    let result = { triangles: 0, meshes: 0, instances: 1 };
    if (mesh) result = { triangles: children(child(mesh, 'triangles'), 'triangle').length, meshes: 1, instances: 1 };
    else {
      const components = children(child(object, 'components'), 'component');
      for (const component of components) {
        const target = reference(component, source);
        const inner = measure(target.source, target.id, depth + 1);
        result = { triangles: result.triangles + inner.triangles, meshes: result.meshes + inner.meshes, instances: result.instances + inner.instances };
        if (result.triangles > MAX_TRIANGLES || result.instances > MAX_INSTANCES) throw new Error('Este conjunto tiene demasiadas piezas para la vista previa. Puedes descargarlo para abrirlo en tu programa 3D.');
      }
    }
    walking.delete(key);
    statistics.set(key, result);
    return result;
  }
  const items = children(child(root.model, 'build'), 'item').filter(node => node.getAttribute('printable') !== '0' && node.getAttribute('printable') !== 'false');
  let triangles = 0;
  let instances = 0;
  for (const item of items) {
    const target = reference(item, root);
    const measured = measure(target.source, target.id);
    triangles += measured.triangles;
    instances += measured.instances;
    if (triangles > MAX_TRIANGLES || instances > MAX_INSTANCES) throw new Error('Este conjunto es demasiado complejo para la vista previa. Puedes descargarlo completo.');
  }
  if (!triangles) throw new Error('Este 3MF no contiene caras de modelo para mostrar. Si contiene solo instrucciones de impresión, descarga el archivo.');
  const templates = new Map();
  const geometries = new Set();
  const materials = new Set();

  function makeMesh(source, object, mesh) {
    const vertexNodes = children(child(mesh, 'vertices'), 'vertex');
    const triangleNodes = children(child(mesh, 'triangles'), 'triangle');
    if (!vertexNodes.length || !triangleNodes.length) throw new Error('El 3MF contiene una malla vacía.');
    const vertices = new Float32Array(vertexNodes.length * 3);
    vertexNodes.forEach((node, i) => {
      vertices[i * 3] = number(node.getAttribute('x'));
      vertices[i * 3 + 1] = number(node.getAttribute('y'));
      vertices[i * 3 + 2] = number(node.getAttribute('z'));
    });
    const hasColors = Boolean(object.getAttribute('pid')) || triangleNodes.some(node => node.hasAttribute('pid'));
    const geometry = new BufferGeometry();
    geometries.add(geometry);
    if (hasColors) {
      const positions = new Float32Array(triangleNodes.length * 9);
      const colors = new Float32Array(triangleNodes.length * 9);
      triangleNodes.forEach((node, i) => {
        const pid = node.getAttribute('pid') || object.getAttribute('pid');
        const palette = source.colors.get(pid);
        const p1 = node.getAttribute('p1') ?? object.getAttribute('pindex') ?? '0';
        for (let corner = 0; corner < 3; corner++) {
          const vertex = index(node.getAttribute(`v${corner + 1}`), vertexNodes.length);
          const base = i * 9 + corner * 3;
          positions.set(vertices.subarray(vertex * 3, vertex * 3 + 3), base);
          const property = node.getAttribute(`p${corner + 1}`) ?? p1;
          const color = palette?.[Number(property)] || DEFAULT_COLOR;
          colors[base] = color.r; colors[base + 1] = color.g; colors[base + 2] = color.b;
        }
      });
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('color', new BufferAttribute(colors, 3));
    } else {
      const indices = new Uint32Array(triangleNodes.length * 3);
      triangleNodes.forEach((node, i) => {
        for (let corner = 0; corner < 3; corner++) indices[i * 3 + corner] = index(node.getAttribute(`v${corner + 1}`), vertexNodes.length);
      });
      geometry.setAttribute('position', new BufferAttribute(vertices, 3));
      geometry.setIndex(new BufferAttribute(indices, 1));
    }
    geometry.computeVertexNormals();
    const material = new MeshStandardMaterial({ color: hasColors ? 0xffffff : DEFAULT_COLOR, vertexColors: hasColors, roughness: 0.68, metalness: 0.05, side: DoubleSide });
    materials.add(material);
    const result = new Mesh(geometry, material);
    result.name = object.getAttribute('name') || '';
    return result;
  }

  function instance(source, id) {
    const key = JSON.stringify([source.path, id]);
    if (templates.has(key)) return templates.get(key).clone(true);
    const object = source.objects.get(id);
    const group = new Group();
    group.name = object.getAttribute('name') || '';
    const mesh = child(object, 'mesh');
    if (mesh) group.add(makeMesh(source, object, mesh));
    else {
      for (const component of children(child(object, 'components'), 'component')) {
        const target = reference(component, source);
        const result = instance(target.source, target.id);
        result.matrixAutoUpdate = false;
        result.matrix.makeScale(target.source.unit / source.unit, target.source.unit / source.unit, target.source.unit / source.unit);
        result.matrix.premultiply(matrix(component.getAttribute('transform')));
        group.add(result);
      }
    }
    templates.set(key, group);
    return group.clone(true);
  }
  try {
    const group = new Group();
    for (const item of items) {
      abortIfNeeded(signal);
      const target = reference(item, root);
      const object = instance(target.source, target.id);
      object.matrixAutoUpdate = false;
      object.matrix.makeScale(target.source.unit / root.unit, target.source.unit / root.unit, target.source.unit / root.unit);
      object.matrix.premultiply(matrix(item.getAttribute('transform')));
      group.add(object);
      await nextFrame();
    }
    group.scale.setScalar(root.unit);
    return { object: group, unit: 'mm' };
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    throw error;
  }
}

export async function parseModel(value, extension, { signal } = {}) {
  const bytes = asBytes(value);
  abortIfNeeded(signal);
  await nextFrame();
  let result;
  if (extension.toLowerCase().replace(/^\./, '') === '3mf') result = await parse3MF(bytes, signal);
  else if (extension.toLowerCase().replace(/^\./, '') === 'stl') {
    const inspection = inspectSTL(bytes);
    const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let geometry;
    try {
      geometry = new STLLoader().parse(data);
      const positions = geometry.getAttribute('position');
      if (!positions?.count || positions.count !== inspection.triangles * 3 || positions.count / 3 > MAX_TRIANGLES) throw new Error('El STL no contiene una malla completa que se pueda mostrar.');
      for (const value of positions.array) if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('El STL contiene coordenadas no válidas.');
      // Ignore supplied normals: many STL exporters emit zeros or nonfinite
      // normals even when the triangle coordinates themselves are valid.
      geometry.computeVertexNormals();
      const material = new MeshStandardMaterial({ color: geometry.hasColors ? 0xffffff : DEFAULT_COLOR, vertexColors: Boolean(geometry.hasColors), roughness: 0.68, metalness: 0.05, side: DoubleSide });
      result = { object: new Mesh(geometry, material), unit: 'unidades' };
    } catch (error) {
      geometry?.dispose();
      throw error;
    }
  } else throw new Error('Este formato no tiene un visor 3D disponible.');
  try {
    abortIfNeeded(signal);
    result.object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(result.object);
    const size = box.getSize(new Vector3());
    if (box.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite) || Math.max(size.x, size.y, size.z) <= 0) throw new Error('El modelo no contiene dimensiones válidas para mostrar.');
    let triangles = 0;
    let meshes = 0;
    result.object.traverse(node => {
      if (node.isMesh) { meshes++; triangles += (node.geometry.index?.count || node.geometry.getAttribute('position').count) / 3; }
    });
    if (triangles > MAX_TRIANGLES || meshes > MAX_INSTANCES) throw new Error('Este modelo es demasiado complejo para la vista previa. Puedes descargarlo completo.');
    return { ...result, info: { dimensions: [size.x, size.y, size.z], unit: result.unit, triangles, meshes } };
  } catch (error) { disposeObject(result.object); throw error; }
}

export async function mountModel(container, bytes, extension, { onInfo, signal, onError } = {}) {
  const { object, info } = await parseModel(bytes, extension, { signal });
  let renderer;
  try { renderer = new WebGLRenderer({ antialias: true, alpha: false }); }
  catch { disposeObject(object); throw new Error('No se pudo activar el visor 3D. Activa la aceleración gráfica del navegador o descarga el modelo.'); }
  const scene = new Scene();
  scene.background = new Color('#f1f3ec');
  const presentation = new Group();
  object.rotation.x = -Math.PI / 2;
  presentation.add(object);
  const bounds = new Box3().setFromObject(presentation);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  presentation.position.sub(center);
  scene.add(presentation);
  const radius = Math.max(size.length() / 2, 1e-8);
  const camera = new PerspectiveCamera(40, 1, Math.max(radius / 10000, 1e-9), radius * 150);
  scene.add(new HemisphereLight(0xffffff, 0x858f73, 2.6));
  const key = new DirectionalLight(0xffffff, 3.5); key.position.set(4, 6, 5); scene.add(key);
  const fill = new DirectionalLight(0xcbdce8, 1.2); fill.position.set(-4, 1, -3); scene.add(fill);
  const gridSize = Math.max(Math.max(size.x, size.z) * 1.8, radius * 1.5);
  const grid = new GridHelper(gridSize, 12, 0xb6c3a2, 0xd9e0ce);
  grid.position.y = -size.y / 2 - radius * 0.002;
  scene.add(grid);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.className = 'model-canvas';
  renderer.domElement.setAttribute('aria-label', 'Modelo 3D. Arrastra para girar y usa la rueda o dos dedos para acercar.');
  renderer.domElement.setAttribute('role', 'img');
  container.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.minDistance = radius * 0.03;
  controls.maxDistance = radius * 40;
  controls.maxPolarAngle = Math.PI;
  let disposed = false;
  let animation = 0;
  function requestRender() {
    if (disposed || animation) return;
    animation = requestAnimationFrame(() => {
      animation = 0;
      if (disposed) return;
      const changed = controls.update();
      renderer.render(scene, camera);
      if (changed) requestRender();
    });
  }
  function resize() {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    requestRender();
  }
  function reset() {
    if (disposed) return;
    const halfFovY = camera.fov * Math.PI / 360;
    const halfFovX = Math.atan(Math.tan(halfFovY) * camera.aspect);
    const distance = radius / Math.sin(Math.min(halfFovY, halfFovX)) * 1.16;
    camera.position.copy(new Vector3(1.25, 0.9, 1.45).normalize().multiplyScalar(distance));
    camera.up.set(0, 1, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    requestRender();
  }
  function contextLost(event) {
    event.preventDefault();
    if (!disposed) onError?.(new Error('El navegador perdió la vista 3D. Cierra y vuelve a abrir el modelo.'));
  }
  controls.addEventListener('change', requestRender);
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const api = {
    reset,
    setWireframe(value) {
      object.traverse(node => {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material) material.wireframe = Boolean(value);
      });
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animation);
      observer.disconnect();
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      signal?.removeEventListener('abort', api.dispose);
      disposeObject(object);
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
  signal?.addEventListener('abort', api.dispose, { once: true });
  resize();
  reset();
  if (signal?.aborted) { api.dispose(); abortIfNeeded(signal); }
  onInfo?.(info);
  return api;
}
