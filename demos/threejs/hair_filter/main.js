/**
 * Men's Hairstyle Try-On — v7
 * ═══════════════════════════════════════════════════════════════════
 * NEW IN v7
 * ──────────────────────────────────
 *  • Hair selector buttons now show a live 3-D model preview
 *    rendered into a 96×96 offscreen canvas using a dedicated
 *    thumbnail renderer (separate from the AR renderer).
 *  • Thumbnails load progressively in the background — buttons
 *    start with a spinner placeholder and update as each GLB loads.
 *  • Shared GLB cache: thumbnail load also populates CACHE so the
 *    first selected style appears instantly without re-fetching.
 * ═══════════════════════════════════════════════════════════════════
 */

// ── HAIRSTYLE NAMES ──────────────────────────────────────────────
const HAIR_NAMES = [
  'Buzz Cut',
  'Crew Cut',
  'Classic Undercut',
  'Modern Pompadour',
  'Slick Back',
  'Side Part',
  'Textured Quiff',
  'Faux Hawk',
  'French Crop',
  'Messy Waves',
  'Ivy League',
  'Man Bun',
];

// ── PRESET HAIR COLOURS ──────────────────────────────────────────
const HAIR_COLOURS = [
  { label: 'Natural',       hex: '#ffffff' },
  { label: 'Jet Black',     hex: '#1a1008' },
  { label: 'Dark Brown',    hex: '#3b1f0e' },
  { label: 'Chestnut',      hex: '#7b3f1e' },
  { label: 'Auburn',        hex: '#922b21' },
  { label: 'Caramel',       hex: '#c68642' },
  { label: 'Honey Blonde',  hex: '#d4a847' },
  { label: 'Platinum',      hex: '#e8dcc8' },
  { label: 'Rose Gold',     hex: '#e8a598' },
  { label: 'Pastel Pink',   hex: '#f4b8c8' },
  { label: 'Lilac',         hex: '#b39ddb' },
  { label: 'Midnight Blue', hex: '#1a237e' },
  { label: 'Teal',          hex: '#00695c' },
  { label: 'Fire Red',      hex: '#b71c1c' },
  { label: 'Copper',        hex: '#bf360c' },
  { label: 'Silver',        hex: '#9e9e9e' },
];

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const CROWN_Y    =  1.32;
const FOREHEAD_Y =  0.32;

const DEFAULTS = {
  crownOffset :  0.02,
  offsetZ     : -0.15, // Pushed slightly further back to prevent front-clipping of back hair
  scaleFactor :  1.0,
};

const HAIR_W_MULT           = 1.50;
const MIN_HAIR_HEIGHT_UNITS = 0.30;

// ── OCCLUDER GEOMETRY CONSTANTS ─────────────────────────────────
//
// COORDINATE REFERENCE (Jeeliz faceObject local space, 1 unit = head width)
//   Face centre X = 0    Ear X ≈ ±0.50
//   Nose tip Z   ≈ +0.22  Back of head Z ≈ -0.60
//   Crown Y      ≈ +0.55  Chin Y         ≈ -0.55
//
// OCCLUDER SIZING PHILOSOPHY:
//   — Occluders must NOT reach the ear line (X ≈ ±0.45)
//     so that side/ear hair renders naturally.
//   — Face disc (Layer A) covers only the inner face oval
//     (cheeks, mouth, chin) — NOT the temples.
//   — Head ellipsoid (Layer B) covers the skull volume
//     but is pushed back enough that it doesn't touch
//     the front-face or temple area.

// Layer A — face disc  (front face oval only, not temples)
const OCC_FACE = {
  rx : 0.44,    // Widened to cover cheeks and temples for short men's hairstyles
  ry : 0.75,    // Forehead to just below chin
  rz : 0.22,    // Thin disc at face surface
  cy : -0.08,
  cz :  0.18,   // Sits at skin surface
};

// Layer B — head/skull ellipsoid  (skull volume, pulled back from temples)
const OCC = {
  rx : 0.64,    // Widened to cover the sides of the head and ear area
  ry : 0.85,    // Crown to chin
  rz : 0.72,    // Front-to-back skull depth
  cy : 0.06,
  cz : -0.04,   // Pushed slightly forward from -0.10 to cover the temple/ear line and block back-hair overlap
};

// Layer C1 — neck cylinder
const OCC_NECK = {
  rx  : 0.28,   // ← NARROWED: neck width only, not shoulder hair
  ry  : 0.55,
  rz  : 0.26,
  cy  : -0.90,
  cz  :  0.00,
};

// Layer C2 — body/shoulder plane
const OCC_BODY = {
  width  : 4.0,
  height : 3.0,
  cy     : -2.20,
  cz     : -0.05,
};

const MODELS_PATH  = '../../../models/';
const HAIR_COUNT   = 12;
const THUMB_SIZE   = 96;   // px — offscreen canvas resolution

// ═══════════════════════════════════════════════════════════════════
// AR STATE
// ═══════════════════════════════════════════════════════════════════
let THREECAMERA   = null;
let FACE_OBJECT   = null;
let HAIR_GROUP    = null;
let HAIR_SCENE    = null;
let OCCLUDER      = null;   // head ellipsoid (Layer B)
let OCC_FACE_MESH = null;   // face disc (Layer A) — KEY: blocks through-face bleeding
let OCC_NECK_MESH = null;   // neck cylinder (Layer C1)
let OCC_BODY_MESH = null;   // shoulder plane (Layer C2)
let CURRENT_IDX   = 0;
let IS_LOADING    = false;
const CACHE       = {};   // shared: index → gltf

let BBOX_MAX_Y    = 0;
let BBOX_CENTER_X = 0;
let BBOX_CENTER_Z = 0;
let BBOX_WIDTH    = 1;
let BBOX_HEIGHT   = 1;
let LIVE_RY       = 0;

let CURRENT_COLOR = new THREE.Color(0xffffff);

// DOM refs
let statusEl, hairNameEl, slY, slZ, slS;
const S = Object.assign({}, DEFAULTS);

// ═══════════════════════════════════════════════════════════════════
// THUMBNAIL RENDERER  (one shared offscreen WebGL context)
// ═══════════════════════════════════════════════════════════════════
let THUMB_RENDERER = null;
let THUMB_SCENE    = null;
let THUMB_CAMERA   = null;
let THUMB_LIGHT_A  = null;

function initThumbnailRenderer() {
  const canvas = document.createElement('canvas');
  canvas.width  = THUMB_SIZE;
  canvas.height = THUMB_SIZE;

  THUMB_RENDERER = new THREE.WebGLRenderer({
    canvas      : canvas,
    antialias   : true,
    alpha       : true,
    preserveDrawingBuffer: true,   // needed for toDataURL()
  });
  THUMB_RENDERER.setSize(THUMB_SIZE, THUMB_SIZE);
  THUMB_RENDERER.setPixelRatio(1);
  THUMB_RENDERER.setClearColor(0x000000, 0);  // transparent bg

  THUMB_SCENE = new THREE.Scene();

  // Camera — orthographic gives cleaner profile view for thumbnails
  const half = 1.4;
  THUMB_CAMERA = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
  THUMB_CAMERA.position.set(0, 0.5, 4);
  THUMB_CAMERA.lookAt(0, 0.5, 0);

  // Lights — softer ambient light and balanced directional lighting to create clear 3D details
  THUMB_SCENE.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dl = new THREE.DirectionalLight(0xffffff, 0.85);
  dl.position.set(1, 2, 3);
  THUMB_SCENE.add(dl);
  const dl2 = new THREE.DirectionalLight(0xffe0cc, 0.35);
  dl2.position.set(-2, 0, -1);
  THUMB_SCENE.add(dl2);
}

/**
 * Render a single GLB scene into the offscreen canvas and
 * return a data-URL PNG string.
 * The model is centred + scaled to fill the view nicely.
 */
function renderThumbnail(gltfScene) {
  // Clone so we don't disturb the cached original
  const clone = gltfScene.clone(true);

  // Clone materials so we don't bleed color changes back to the original CACHE
  clone.traverse(function(node) {
    if (!node.isMesh || !node.material) return;
    node.material = Array.isArray(node.material)
      ? node.material.map(function(m) { return m.clone(); })
      : node.material.clone();
  });

  // Apply rotation first so that we calculate the bounding box on the rotated model
  // This prevents the hair model from swinging off-center during rotation
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, -0.3, 0);
  clone.scale.set(1, 1, 1);
  clone.updateMatrixWorld(true);

  const bbox   = new THREE.Box3().setFromObject(clone);
  const size   = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());

  // Scale with a smaller multiplier (1.7 instead of 2.2) to leave a nice margin inside the button
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const sv     = 1.7 / maxDim;
  clone.scale.setScalar(sv);

  // Centre horizontally and offset in Y/Z relative to camera target
  clone.position.set(
    -center.x * sv,
    -center.y * sv + 0.1,
    -center.z * sv
  );

  // Apply natural colors and styling to thumbnail materials
  clone.traverse(function(node) {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(function(m) {
      // Store original color for reference if not already done
      if (m.userData.originalColor === undefined && m.color) {
        m.userData.originalColor = m.color.clone();
      }
      // Use original color for the thumbnail preview (instead of forcing pure white)
      if (m.userData.originalColor && m.color) {
        m.color.copy(m.userData.originalColor);
      }
      m.side = THREE.FrontSide;
      m.needsUpdate = true;
    });
  });

  // Add to scene, render, remove
  THUMB_SCENE.add(clone);
  THUMB_RENDERER.render(THUMB_SCENE, THUMB_CAMERA);
  THUMB_SCENE.remove(clone);

  return THUMB_RENDERER.domElement.toDataURL('image/png');
}

/**
 * Load all models one by one in the background and set
 * button background-image as each finishes.
 * Uses a small delay between loads so the main thread stays responsive.
 */
function loadAllThumbnails() {
  let i = 0;
  function loadNext() {
    if (i >= HAIR_COUNT) return;
    const idx = i++;

    // If already in shared cache, render immediately
    if (CACHE[idx]) {
      applyThumbnail(idx, CACHE[idx]);
      setTimeout(loadNext, 10);
      return;
    }

    new THREE.GLTFLoader().load(
      MODELS_PATH + (idx + 1) + '.glb',
      function(gltf) {
        CACHE[idx] = gltf;          // store in shared cache
        applyThumbnail(idx, gltf);
        setTimeout(loadNext, 30);   // small gap → keeps UI responsive
      },
      undefined,
      function(err) {
        console.warn('Thumbnail load failed for Hair' + (idx + 1), err);
        setTimeout(loadNext, 30);
      }
    );
  }
  loadNext();
}

function applyThumbnail(idx, gltf) {
  const btn = document.getElementById('hair-btn-' + idx);
  if (!btn) return;
  const dataUrl = renderThumbnail(gltf.scene);
  // Replace spinner with rendered image
  btn.innerHTML = '';
  btn.style.backgroundImage    = 'url(' + dataUrl + ')';
  btn.style.backgroundSize     = 'cover';
  btn.style.backgroundPosition = 'center';
}


// ═══════════════════════════════════════════════════════════════════
// OCCLUDER SYSTEM  — 4 invisible depth-write meshes
// ═══════════════════════════════════════════════════════════════════
function makeOccluderMat() {
  return new THREE.MeshBasicMaterial({
    colorWrite : false,
    depthWrite : true,
    depthTest  : true,
    side       : THREE.FrontSide,
  });
}

/**
 * Layer A — FACE DISC
 * Thin ellipsoid covering the entire face front, positioned at
 * cz = +0.18 (slightly in front of the nose-bridge origin).
 * This is the critical mask: any back hair strand that would
 * poke through cheek / mouth / chin gets depth-rejected here.
 */
function createFaceOccluder() {
  const geo  = new THREE.SphereGeometry(1, 48, 32);
  const mesh = new THREE.Mesh(geo, makeOccluderMat());
  mesh.renderOrder   = -3;   // draw first, before head ellipsoid
  mesh.frustumCulled = false;
  mesh.scale.set(OCC_FACE.rx, OCC_FACE.ry, OCC_FACE.rz);
  mesh.position.set(0, OCC_FACE.cy, OCC_FACE.cz);
  return mesh;
}

/** Layer B — Head/skull ellipsoid */
function createOccluder() {
  const geo  = new THREE.SphereGeometry(1, 48, 36);
  const mesh = new THREE.Mesh(geo, makeOccluderMat());
  mesh.renderOrder   = -2;
  mesh.frustumCulled = false;
  mesh.scale.set(OCC.rx, OCC.ry, OCC.rz);
  mesh.position.set(0, OCC.cy, OCC.cz);
  return mesh;
}

/** Layer C1 — Neck cylinder */
function createNeckOccluder() {
  const geo  = new THREE.CylinderGeometry(
    OCC_NECK.rx, OCC_NECK.rx * 1.2,
    OCC_NECK.ry * 2,
    24, 1
  );
  const mesh = new THREE.Mesh(geo, makeOccluderMat());
  mesh.renderOrder   = -2;
  mesh.frustumCulled = false;
  mesh.scale.set(1, 1, OCC_NECK.rz / OCC_NECK.rx);
  mesh.position.set(0, OCC_NECK.cy, OCC_NECK.cz);
  return mesh;
}

/** Layer C2 — Body / shoulder plane */
function createBodyOccluder() {
  const geo  = new THREE.PlaneGeometry(OCC_BODY.width, OCC_BODY.height);
  const mesh = new THREE.Mesh(geo, makeOccluderMat());
  mesh.renderOrder   = -2;
  mesh.frustumCulled = false;
  mesh.position.set(0, OCC_BODY.cy, OCC_BODY.cz);
  return mesh;
}


// ═══════════════════════════════════════════════════════════════════
// FACE OCCLUDER YAW ADAPTATION  (called every frame from callbackTrack)
// ───────────────────────────────────────────────────────────────────
// When ry ≈ 0  (facing camera): face disc is fully active, blocks
//   back hair bleeding through mouth/chin area.
//
// When |ry| grows (head turns): the face disc X-scale shrinks using
//   cos(ry) as the natural falloff.  At ≈30° it's already thin
//   enough that side hair flows freely.  At ≈60° it's essentially
//   gone.  The disc also shifts in X so it stays centred on the
//   visible face half, not the nose bridge.
//
// The neck occluder also narrows slightly on turns so it doesn't
// cut the side strands that swing forward during rotation.
// ═══════════════════════════════════════════════════════════════════

// How quickly the face disc fades with yaw.
// Lower value = stays active longer before fading on rotation.
// 1.2 gives a gentler fade — disc starts stepping back at ~20° turn.
const FACE_OCC_YAW_SHARPNESS = 1.2;

function updateOccluderForYaw(ry) {
  if (!OCC_FACE_MESH) return;

  // cos falloff: 1.0 at ry=0 (front), 0.0 at ry=π/2 (profile)
  const absCos = Math.pow(Math.max(0, Math.cos(ry)), FACE_OCC_YAW_SHARPNESS);

  // Collapse face disc width as head turns — ear hair becomes visible
  OCC_FACE_MESH.scale.set(
    OCC_FACE.rx * absCos,
    OCC_FACE.ry,
    OCC_FACE.rz
  );

  // Shift disc slightly toward camera-facing cheek during rotation
  // so the inner face oval stays covered on the visible side
  OCC_FACE_MESH.position.x = -Math.sin(ry) * 0.08 * absCos;

  // Neck: keep mostly active but reduce depth on turns
  // so it doesn't cut side-hanging hair that wraps the neck
  if (OCC_NECK_MESH) {
    const baseZScale = OCC_NECK.rz / OCC_NECK.rx;
    OCC_NECK_MESH.scale.set(1, 1, baseZScale * Math.max(0.35, absCos));
  }
}
function patchMaterials(root) {
  root.traverse(function(node) {
    node.frustumCulled = false;
    if (!node.isMesh || !node.material) return;
    
    // Clone materials so color changes don't bleed back into CACHE
    node.material = Array.isArray(node.material)
      ? node.material.map(function(m) { return m.clone(); })
      : node.material.clone();

    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(function(m) {
      m.side       = THREE.FrontSide;  // only front faces — eliminates inner back-hair fragments
      m.depthTest  = true;             // respect occluder depth buffer
      m.depthWrite = true;
      m.renderOrder = 0;               // draw after occluders (renderOrder -2)
      if (m.color !== undefined) {
        // Cache the original model color
        if (m.userData.originalColor === undefined) {
          m.userData.originalColor = m.color.clone();
        }
        // If current color is white ("Natural"), use the original model color. Otherwise use color override.
        if (CURRENT_COLOR.getHexString() === 'ffffff') {
          m.color.copy(m.userData.originalColor);
        } else {
          m.color.copy(CURRENT_COLOR);
        }
      }
      m.needsUpdate = true;
    });
  });
}

function applyColorToHair() {
  if (!HAIR_SCENE) return;
  HAIR_SCENE.traverse(function(node) {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    mats.forEach(function(m) {
      if (m.color !== undefined) {
        // Cache original color if not already cached
        if (m.userData.originalColor === undefined) {
          m.userData.originalColor = m.color.clone();
        }
        // If current color is white ("Natural"), use original model color. Otherwise use color override.
        if (CURRENT_COLOR.getHexString() === 'ffffff') {
          m.color.copy(m.userData.originalColor);
        } else {
          m.color.copy(CURRENT_COLOR);
        }
        m.needsUpdate = true;
      }
    });
  });
}


// ═══════════════════════════════════════════════════════════════════
// BBOX CACHE
// ═══════════════════════════════════════════════════════════════════
function cacheBbox(scene) {
  scene.position.set(0, 0, 0);
  scene.rotation.set(0, 0, 0);
  scene.scale.set(1, 1, 1);
  scene.updateMatrixWorld(true);

  const bbox   = new THREE.Box3().setFromObject(scene);
  const size   = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());

  BBOX_MAX_Y    = bbox.max.y;
  BBOX_CENTER_X = center.x;
  BBOX_CENTER_Z = center.z;
  BBOX_WIDTH    = size.x || 1;
  BBOX_HEIGHT   = size.y || 1;
}


// ═══════════════════════════════════════════════════════════════════
// HAIR FITTING
// ═══════════════════════════════════════════════════════════════════
function refitHair() {
  if (!HAIR_SCENE || BBOX_WIDTH === 0) return;
  const svW = (HAIR_W_MULT * S.scaleFactor) / BBOX_WIDTH;
  const minH = MIN_HAIR_HEIGHT_UNITS / BBOX_HEIGHT;
  const sv   = Math.max(svW, minH * S.scaleFactor);

  HAIR_SCENE.scale.setScalar(sv);
  HAIR_SCENE.position.x = -BBOX_CENTER_X * sv;
  HAIR_SCENE.position.z = -BBOX_CENTER_Z * sv + S.offsetZ;
  const targetTopY      = CROWN_Y + S.crownOffset;
  HAIR_SCENE.position.y = targetTopY - BBOX_MAX_Y * sv;
}

function syncOccluder() {
  if (!OCCLUDER) return;
  const deltaY = S.crownOffset - DEFAULTS.crownOffset;

  // Layer A — face disc: only update Y/Z position here.
  // X-scale is managed per-frame by updateOccluderForYaw().
  if (OCC_FACE_MESH) {
    OCC_FACE_MESH.position.y = OCC_FACE.cy + deltaY * 0.5;
    OCC_FACE_MESH.position.z = OCC_FACE.cz;  // always keep at face-surface Z
  }

  // Layer B — head ellipsoid
  OCCLUDER.position.y = OCC.cy + deltaY * 0.6;
  OCCLUDER.position.z = OCC.cz + S.offsetZ * 0.25;

  // Layer C1 — neck (Y/Z only — X-scale managed by updateOccluderForYaw)
  if (OCC_NECK_MESH) {
    OCC_NECK_MESH.position.y = OCC_NECK.cy + deltaY * 0.6;
    OCC_NECK_MESH.position.z = OCC_NECK.cz + S.offsetZ * 0.20;
  }

  // Layer C2 — body plane
  if (OCC_BODY_MESH) {
    OCC_BODY_MESH.position.y = OCC_BODY.cy + deltaY * 0.6;
    OCC_BODY_MESH.position.z = OCC_BODY.cz + S.offsetZ * 0.15;
  }
}


// ═══════════════════════════════════════════════════════════════════
// LOAD / SWITCH HAIR
// ═══════════════════════════════════════════════════════════════════
function clearHair() {
  if (HAIR_GROUP && FACE_OBJECT) FACE_OBJECT.remove(HAIR_GROUP);
  HAIR_GROUP = null;
  HAIR_SCENE = null;
  BBOX_WIDTH = 1;
}

function attachGltf(gltf) {
  const scene = gltf.scene.clone(true);
  patchMaterials(scene);
  cacheBbox(scene);

  HAIR_GROUP = new THREE.Object3D();
  HAIR_GROUP.frustumCulled = false;
  HAIR_GROUP.renderOrder   = 0;   // renders after occluders at -2
  HAIR_GROUP.add(scene);
  HAIR_SCENE = scene;
  FACE_OBJECT.add(HAIR_GROUP);

  refitHair();
  IS_LOADING = false;
  setStatus('');
  showHairName(CURRENT_IDX);
}

function loadHair(index) {
  if (!FACE_OBJECT || IS_LOADING) return;
  IS_LOADING = true;
  clearHair();
  setStatus('Loading ' + HAIR_NAMES[index] + '…');
  hideHairName();

  if (CACHE[index]) { attachGltf(CACHE[index]); return; }

  new THREE.GLTFLoader().load(
    MODELS_PATH + (index + 1) + '.glb',
    function(gltf) { CACHE[index] = gltf; attachGltf(gltf); },
    undefined,
    function(err) {
      IS_LOADING = false;
      setStatus('Error loading Hair' + (index + 1));
      console.error(err);
    }
  );
}

function selectHair(idx) {
  CURRENT_IDX = idx;
  document.querySelectorAll('.hair-btn').forEach(function(b, i) {
    b.classList.toggle('active', i === idx);
  });
  loadHair(idx);
}


// ═══════════════════════════════════════════════════════════════════
// COLOUR SYSTEM
// ═══════════════════════════════════════════════════════════════════
function setHairColor(hex) {
  CURRENT_COLOR.set(hex);
  applyColorToHair();
  document.querySelectorAll('.color-swatch').forEach(function(sw) {
    sw.classList.toggle('active', sw.dataset.hex === hex);
  });
  const picker = document.getElementById('customColor');
  if (picker) picker.value = rgbToHex(CURRENT_COLOR);
}

function rgbToHex(color) {
  const r = Math.round(color.r * 255).toString(16).padStart(2, '0');
  const g = Math.round(color.g * 255).toString(16).padStart(2, '0');
  const b = Math.round(color.b * 255).toString(16).padStart(2, '0');
  return '#' + r + g + b;
}

function buildColorPanel() {
  const panel = document.getElementById('colorPanel');
  HAIR_COLOURS.forEach(function(c) {
    const sw = document.createElement('button');
    sw.className        = 'color-swatch' + (c.hex === '#ffffff' ? ' active' : '');
    sw.dataset.hex      = c.hex;
    sw.title            = c.label;
    sw.style.background = c.hex === '#ffffff'
      ? 'linear-gradient(135deg,#eee 25%,#bbb 25%,#bbb 50%,#eee 50%,#eee 75%,#bbb 75%)'
      : c.hex;
    sw.addEventListener('click', function() { setHairColor(c.hex); });
    panel.appendChild(sw);
  });

  const wrap = document.createElement('div');
  wrap.className = 'color-swatch custom-wrap';
  wrap.title = 'Custom colour';
  const picker = document.createElement('input');
  picker.type  = 'color';
  picker.id    = 'customColor';
  picker.value = '#ffffff';
  picker.addEventListener('input', function() {
    document.querySelectorAll('.color-swatch').forEach(function(sw) { sw.classList.remove('active'); });
    CURRENT_COLOR.set(picker.value);
    applyColorToHair();
  });
  wrap.appendChild(picker);
  panel.appendChild(wrap);
}


// ═══════════════════════════════════════════════════════════════════
// HAIRSTYLE NAME DISPLAY
// ═══════════════════════════════════════════════════════════════════
function showHairName(idx) {
  if (!hairNameEl) return;
  hairNameEl.textContent = HAIR_NAMES[idx] || ('Hair ' + (idx + 1));
  hairNameEl.classList.add('visible');
  clearTimeout(hairNameEl._hideTimer);
  hairNameEl._hideTimer = setTimeout(function() {
    hairNameEl.classList.remove('visible');
  }, 3000);
}

function hideHairName() {
  if (!hairNameEl) return;
  clearTimeout(hairNameEl._hideTimer);
  hairNameEl.classList.remove('visible');
}


// ═══════════════════════════════════════════════════════════════════
// SLIDERS
// ═══════════════════════════════════════════════════════════════════
function applySliders() {
  S.crownOffset = parseFloat(slY.value);
  S.offsetZ     = parseFloat(slZ.value);
  S.scaleFactor = parseFloat(slS.value);
  syncOccluder();
  refitHair();
}


// ═══════════════════════════════════════════════════════════════════
// SCENE INIT
// ═══════════════════════════════════════════════════════════════════
function init_threeScene(spec) {
  const threeStuffs = JeelizThreeHelper.init(spec, detect_callback);
  FACE_OBJECT = threeStuffs.faceObject;

  threeStuffs.scene.add(new THREE.AmbientLight(0xffffff, 0.80));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.85);
  d1.position.set(0, 3, 3);
  threeStuffs.scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffe0cc, 0.45);
  d2.position.set(-2, 0.5, -1);
  threeStuffs.scene.add(d2);
  const d3 = new THREE.DirectionalLight(0xccddff, 0.35);
  d3.position.set(0, -1, -3);
  threeStuffs.scene.add(d3);

  OCC_FACE_MESH = createFaceOccluder();
  OCCLUDER      = createOccluder();
  OCC_NECK_MESH = createNeckOccluder();
  OCC_BODY_MESH = createBodyOccluder();
  FACE_OBJECT.add(OCC_FACE_MESH);
  FACE_OBJECT.add(OCCLUDER);
  FACE_OBJECT.add(OCC_NECK_MESH);
  FACE_OBJECT.add(OCC_BODY_MESH);

  THREECAMERA = JeelizThreeHelper.create_camera();
  loadHair(CURRENT_IDX);
}


// ═══════════════════════════════════════════════════════════════════
// CALLBACKS
// ═══════════════════════════════════════════════════════════════════
function detect_callback(faceIndex, isDetected) {
  if (!isDetected) setStatus('No face detected');
  else if (!IS_LOADING) setStatus('');
}


// ═══════════════════════════════════════════════════════════════════
// UI BUILD
// ═══════════════════════════════════════════════════════════════════

/** Spinner SVG shown while a thumbnail is loading */
function spinnerSVG() {
  return '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<circle cx="14" cy="14" r="10" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>'
    + '<path d="M14 4 A10 10 0 0 1 24 14" stroke="#ff79c6" stroke-width="3" stroke-linecap="round">'
    + '<animateTransform attributeName="transform" type="rotate" from="0 14 14" to="360 14 14" dur="0.9s" repeatCount="indefinite"/>'
    + '</path></svg>';
}

function buildStrip() {
  const strip = document.getElementById('hairStrip');
  for (let i = 0; i < HAIR_COUNT; i++) {
    const name  = HAIR_NAMES[i];
    // Short label: first word only (fits in the card footer)
    const short = name.split(' ').slice(0, 2).join(' ');

    const btn = document.createElement('button');
    btn.id               = 'hair-btn-' + i;
    btn.className        = 'hair-btn' + (i === 0 ? ' active' : '');
    btn.title            = name;
    btn.dataset.short    = short;
    btn.innerHTML        = spinnerSVG();   // placeholder until thumbnail renders
    btn.addEventListener('click', (function(k) { return function() { selectHair(k); }; })(i));
    strip.appendChild(btn);
  }
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }


// ═══════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════
function main() {
  statusEl   = document.getElementById('status');
  hairNameEl = document.getElementById('hairName');
  slY        = document.getElementById('slY');
  slZ        = document.getElementById('slZ');
  slS        = document.getElementById('slS');

  // Synchronize HTML sliders with JavaScript defaults
  slY.value  = DEFAULTS.crownOffset;
  slZ.value  = DEFAULTS.offsetZ;
  slS.value  = DEFAULTS.scaleFactor;

  [slY, slZ, slS].forEach(function(sl) { sl.addEventListener('input', applySliders); });

  // Build the offscreen thumbnail renderer first
  initThumbnailRenderer();

  buildStrip();
  buildColorPanel();
  showHairName(CURRENT_IDX);

  // Start loading thumbnails in background (non-blocking)
  setTimeout(loadAllThumbnails, 200);

  JeelizResizer.size_canvas({
    canvasId: 'jeeFaceFilterCanvas',
    callback: function(isError, bestVideoSettings) {
      startFaceFilter(bestVideoSettings);
    }
  });
}

function startFaceFilter(videoSettings) {
  JEELIZFACEFILTER.init({
    followZRot      : true,
    canvasId        : 'jeeFaceFilterCanvas',
    NNCPath         : '../../../neuralNets/',
    maxFacesDetected: 1,

    callbackReady: function(errCode, spec) {
      if (errCode) { setStatus('ERROR: ' + errCode); console.error(errCode); return; }
      setStatus('Initialising…');
      init_threeScene(spec);
    },

    callbackTrack: function(detectState) {
      JeelizThreeHelper.render(detectState, THREECAMERA);
      LIVE_RY = detectState.ry || 0;
      if (detectState.detected > 0.5 && HAIR_SCENE) {
        refitHair();
        syncOccluder();
        updateOccluderForYaw(LIVE_RY);   // adapt face disc to head rotation
      }
    }
  });
}

window.addEventListener('load', main);
