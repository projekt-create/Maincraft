import * as THREE from "three";

const CHUNK_SIZE = 16;
const WORLD_MAX_Y = 32;
const REACH_DISTANCE = 7;
const GRAVITY = 21;
const WALK_SPEED = 5.5;
const AIR_SPEED = 4.5;
const JUMP_SPEED = 8.2;
const TURN_SPEED = 2.1;
const STREAM_RADIUS = 6;
const STREAM_NEAR_RADIUS = 2;
const STREAM_DOT_THRESHOLD = 0.05;
const CHUNK_LOAD_BUDGET = 3;
const CHUNK_REBUILD_BUDGET = 2;
const WATER_LEVEL = 9;

const BLOCK_TYPES = [
  { id: "grass", label: "Grass", color: 0x68b746, solid: true },
  { id: "dirt", label: "Dirt", color: 0x8c5b34, solid: true },
  { id: "stone", label: "Stone", color: 0x8f9399, solid: true },
  { id: "wood", label: "Wood", color: 0xa17344, solid: true },
  { id: "leaves", label: "Leaves", color: 0x4d8f38, solid: true, transparent: true, opacity: 0.9 },
  { id: "sand", label: "Sand", color: 0xd7c686, solid: true },
  { id: "water", label: "Water", color: 0x4ea6df, solid: false, transparent: true, opacity: 0.62 },
];

const HOTBAR_TYPES = [0, 1, 2, 3, 4, 5];

const BLOCK_INDEX_GRASS = 0;
const BLOCK_INDEX_DIRT = 1;
const BLOCK_INDEX_STONE = 2;
const BLOCK_INDEX_WOOD = 3;
const BLOCK_INDEX_LEAVES = 4;
const BLOCK_INDEX_SAND = 5;
const BLOCK_INDEX_WATER = 6;

const FACE_DIRECTIONS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
const blockMaterials = BLOCK_TYPES.map(
  (type) =>
    new THREE.MeshStandardMaterial({
      color: type.color,
      roughness: type.id === "water" ? 0.25 : 0.95,
      metalness: 0.04,
      transparent: Boolean(type.transparent),
      opacity: type.opacity ?? 1,
      depthWrite: !type.transparent || type.id === "leaves",
    })
);
const instanceDummy = new THREE.Object3D();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9acbff);
scene.fog = new THREE.Fog(0x9acbff, 36, 180);

const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 500);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const hemiLight = new THREE.HemisphereLight(0xd9edff, 0x86684f, 1.08);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 0.92);
sunLight.position.set(25, 35, 18);
scene.add(sunLight);

const targetOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
  new THREE.LineBasicMaterial({ color: 0x101010 })
);
targetOutline.visible = false;
scene.add(targetOutline);

const statusEl = document.getElementById("status");
const hotbarEl = document.getElementById("hotbar");
const mobileUiEl = document.getElementById("mobile-ui");
const movePadEl = document.getElementById("move-pad");
const moveStickEl = document.getElementById("move-stick");
const lookPadEl = document.getElementById("look-pad");
const jumpBtnEl = document.getElementById("jump-btn");
const breakBtnEl = document.getElementById("break-btn");
const placeBtnEl = document.getElementById("place-btn");
const isMobileInput = window.matchMedia("(hover: none) and (pointer: coarse)").matches || "ontouchstart" in window;

const state = {
  mode: "playing",
  time: 0,
  pointerLocked: false,
  selectedType: 0,
  keys: new Set(),
  target: null,
  loadedChunkCount: 0,
  player: {
    pos: new THREE.Vector3(0.5, 8, 0.5),
    vel: new THREE.Vector3(0, 0, 0),
    yaw: Math.PI,
    pitch: -0.65,
    radius: 0.34,
    height: 1.8,
    eyeHeight: 1.62,
    onGround: false,
  },
  mobile: {
    enabled: isMobileInput,
    move: {
      activeId: null,
      axisX: 0,
      axisY: 0,
    },
    look: {
      activeId: null,
      lastX: 0,
      lastY: 0,
    },
    jumpRequested: false,
  },
  hudTick: 0,
};

const loadedChunks = new Map();
const chunkEdits = new Map();
const dirtyChunkKeys = new Set();

if (state.mobile.enabled && mobileUiEl) {
  mobileUiEl.setAttribute("aria-hidden", "false");
}

function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

function parseChunkKey(key) {
  const parts = key.split(",");
  return { cx: Number(parts[0]), cz: Number(parts[1]) };
}

function worldToChunk(value) {
  return Math.floor(value / CHUNK_SIZE);
}

function worldToLocal(value) {
  const remainder = value % CHUNK_SIZE;
  return remainder < 0 ? remainder + CHUNK_SIZE : remainder;
}

function localBlockKey(lx, y, lz) {
  return `${lx}|${y}|${lz}`;
}

function parseLocalBlockKey(key) {
  const parts = key.split("|");
  return {
    lx: Number(parts[0]),
    y: Number(parts[1]),
    lz: Number(parts[2]),
  };
}

function hash2D(x, z) {
  let n = x * 374761393 + z * 668265263;
  n = (n ^ (n >>> 13)) * 1274126177;
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}

function getTerrainHeight(x, z) {
  const rolling = Math.sin(x * 0.13) * 3.2 + Math.cos(z * 0.11) * 3 + Math.sin((x + z) * 0.055) * 2.1;
  return THREE.MathUtils.clamp(Math.floor(8 + rolling), 3, WORLD_MAX_Y - 4);
}

function shouldGrowTree(x, z, terrainY) {
  if (terrainY <= WATER_LEVEL + 1) {
    return false;
  }
  const treeNoise = hash2D(x * 5 + 71, z * 7 + 17);
  return treeNoise > 0.985;
}

function getTreeHeight(x, z) {
  return 3 + Math.floor(hash2D(x * 3 + 101, z * 11 + 29) * 3);
}

function getBaseBlockType(x, y, z) {
  if (y < 0) {
    return BLOCK_INDEX_STONE;
  }
  if (y >= WORLD_MAX_Y) {
    return null;
  }

  const height = getTerrainHeight(x, z);
  if (y > height) {
    if (y <= WATER_LEVEL) {
      return BLOCK_INDEX_WATER;
    }
    return null;
  }
  if (y === height) {
    return BLOCK_INDEX_GRASS;
  }
  if (y >= height - 2) {
    return BLOCK_INDEX_DIRT;
  }
  if (y <= 1) {
    return BLOCK_INDEX_SAND;
  }
  return BLOCK_INDEX_STONE;
}

function getChunkEditMap(cx, cz, create) {
  const key = chunkKey(cx, cz);
  if (chunkEdits.has(key)) {
    return chunkEdits.get(key);
  }
  if (!create) {
    return null;
  }
  const map = new Map();
  chunkEdits.set(key, map);
  return map;
}

function getBlockType(x, y, z) {
  if (y < 0) {
    return BLOCK_INDEX_STONE;
  }
  if (y >= WORLD_MAX_Y) {
    return null;
  }

  const cx = worldToChunk(x);
  const cz = worldToChunk(z);
  const key = chunkKey(cx, cz);
  const lx = worldToLocal(x);
  const lz = worldToLocal(z);
  const lKey = localBlockKey(lx, y, lz);

  const loaded = loadedChunks.get(key);
  if (loaded) {
    const value = loaded.blocks.get(lKey);
    return value === undefined ? null : value;
  }

  const edits = chunkEdits.get(key);
  if (edits && edits.has(lKey)) {
    return edits.get(lKey);
  }

  return getBaseBlockType(x, y, z);
}

function isSolidBlock(x, y, z) {
  const typeIndex = getBlockType(x, y, z);
  if (typeIndex === null) {
    return false;
  }
  return BLOCK_TYPES[typeIndex].solid !== false;
}

function hasAnyBlock(x, y, z) {
  return getBlockType(x, y, z) !== null;
}

function markChunkDirty(cx, cz) {
  const key = chunkKey(cx, cz);
  const chunk = loadedChunks.get(key);
  if (!chunk) {
    return;
  }
  chunk.dirty = true;
  dirtyChunkKeys.add(key);
}

function markNeighborsDirtyOnBorder(cx, cz, lx, lz) {
  markChunkDirty(cx, cz);
  if (lx === 0) {
    markChunkDirty(cx - 1, cz);
  }
  if (lx === CHUNK_SIZE - 1) {
    markChunkDirty(cx + 1, cz);
  }
  if (lz === 0) {
    markChunkDirty(cx, cz - 1);
  }
  if (lz === CHUNK_SIZE - 1) {
    markChunkDirty(cx, cz + 1);
  }
}

function applyEditAndLoadedChunkUpdate(x, y, z, valueOrNull) {
  if (y < 0 || y >= WORLD_MAX_Y) {
    return false;
  }

  const cx = worldToChunk(x);
  const cz = worldToChunk(z);
  const lx = worldToLocal(x);
  const lz = worldToLocal(z);
  const key = chunkKey(cx, cz);
  const lKey = localBlockKey(lx, y, lz);

  const baseValue = getBaseBlockType(x, y, z);

  const edits = getChunkEditMap(cx, cz, true);
  if (valueOrNull === baseValue) {
    edits.delete(lKey);
  } else {
    edits.set(lKey, valueOrNull);
  }

  if (edits.size === 0) {
    chunkEdits.delete(key);
  }

  const loaded = loadedChunks.get(key);
  if (loaded) {
    if (valueOrNull === null) {
      loaded.blocks.delete(lKey);
    } else {
      loaded.blocks.set(lKey, valueOrNull);
    }
  }

  markNeighborsDirtyOnBorder(cx, cz, lx, lz);
  return true;
}

function setBlockType(x, y, z, typeIndex) {
  return applyEditAndLoadedChunkUpdate(x, y, z, typeIndex);
}

function removeBlockType(x, y, z) {
  return applyEditAndLoadedChunkUpdate(x, y, z, null);
}

function generateChunkBlocks(cx, cz) {
  const blocks = new Map();
  const columnHeights = Array.from({ length: CHUNK_SIZE }, () => Array(CHUNK_SIZE).fill(0));

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const worldX = cx * CHUNK_SIZE + lx;
      const worldZ = cz * CHUNK_SIZE + lz;
      const height = getTerrainHeight(worldX, worldZ);
      columnHeights[lx][lz] = height;

      const columnTop = Math.max(height, WATER_LEVEL);
      for (let y = 0; y <= columnTop; y++) {
        const type = getBaseBlockType(worldX, y, worldZ);
        if (type !== null) {
          blocks.set(localBlockKey(lx, y, lz), type);
        }
      }
    }
  }

  const trySetBlock = (lx, y, lz, typeIndex) => {
    if (y < 0 || y >= WORLD_MAX_Y) {
      return;
    }
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
      return;
    }
    const key = localBlockKey(lx, y, lz);
    if (!blocks.has(key)) {
      blocks.set(key, typeIndex);
    }
  };

  for (let lx = 2; lx < CHUNK_SIZE - 2; lx++) {
    for (let lz = 2; lz < CHUNK_SIZE - 2; lz++) {
      const worldX = cx * CHUNK_SIZE + lx;
      const worldZ = cz * CHUNK_SIZE + lz;
      const terrainY = columnHeights[lx][lz];
      if (!shouldGrowTree(worldX, worldZ, terrainY)) {
        continue;
      }

      const trunkHeight = getTreeHeight(worldX, worldZ);
      for (let i = 1; i <= trunkHeight; i++) {
        trySetBlock(lx, terrainY + i, lz, BLOCK_INDEX_WOOD);
      }

      const leafCenterY = terrainY + trunkHeight;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = -2; dy <= 2; dy++) {
            const spread = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
            if (spread <= 4) {
              trySetBlock(lx + dx, leafCenterY + dy, lz + dz, BLOCK_INDEX_LEAVES);
            }
          }
        }
      }
      trySetBlock(lx, leafCenterY + 2, lz, BLOCK_INDEX_LEAVES);
    }
  }

  const edits = chunkEdits.get(chunkKey(cx, cz));
  if (edits) {
    for (const [lKey, value] of edits.entries()) {
      if (value === null) {
        blocks.delete(lKey);
      } else {
        blocks.set(lKey, value);
      }
    }
  }

  return blocks;
}

function createChunkMesh(typeIndex, key, capacity) {
  const mesh = new THREE.InstancedMesh(blockGeometry, blockMaterials[typeIndex], Math.max(1, capacity));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = true;
  mesh.userData.typeIndex = typeIndex;
  mesh.userData.chunkKey = key;
  return {
    mesh,
    capacity: Math.max(1, capacity),
    instanceToLocal: [],
  };
}

function createChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  const group = new THREE.Group();
  group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);

  const chunk = {
    key,
    cx,
    cz,
    group,
    blocks: generateChunkBlocks(cx, cz),
    meshes: [],
    dirty: true,
  };

  for (let typeIndex = 0; typeIndex < BLOCK_TYPES.length; typeIndex++) {
    const meshEntry = createChunkMesh(typeIndex, key, 1);
    chunk.meshes.push(meshEntry);
    chunk.group.add(meshEntry.mesh);
  }

  return chunk;
}

function ensureChunkMeshCapacity(chunk, typeIndex, needed) {
  const meshEntry = chunk.meshes[typeIndex];
  if (needed <= meshEntry.capacity) {
    return meshEntry;
  }

  const nextCapacity = Math.ceil(needed * 1.25) + 16;
  chunk.group.remove(meshEntry.mesh);

  const replacement = createChunkMesh(typeIndex, chunk.key, nextCapacity);
  chunk.meshes[typeIndex] = replacement;
  chunk.group.add(replacement.mesh);

  return replacement;
}

function isBlockExposed(x, y, z) {
  for (const dir of FACE_DIRECTIONS) {
    if (!hasAnyBlock(x + dir.x, y + dir.y, z + dir.z)) {
      return true;
    }
  }
  return false;
}

function rebuildChunkMeshes(chunk) {
  const grouped = BLOCK_TYPES.map(() => []);

  for (const [lKey, typeIndex] of chunk.blocks.entries()) {
    const local = parseLocalBlockKey(lKey);
    const worldX = chunk.cx * CHUNK_SIZE + local.lx;
    const worldZ = chunk.cz * CHUNK_SIZE + local.lz;

    if (isBlockExposed(worldX, local.y, worldZ)) {
      grouped[typeIndex].push(local);
    }
  }

  for (let typeIndex = 0; typeIndex < BLOCK_TYPES.length; typeIndex++) {
    const positions = grouped[typeIndex];
    const meshEntry = ensureChunkMeshCapacity(chunk, typeIndex, positions.length);
    meshEntry.instanceToLocal = positions;
    meshEntry.mesh.count = positions.length;

    for (let i = 0; i < positions.length; i++) {
      const local = positions[i];
      instanceDummy.position.set(local.lx + 0.5, local.y + 0.5, local.lz + 0.5);
      instanceDummy.updateMatrix();
      meshEntry.mesh.setMatrixAt(i, instanceDummy.matrix);
    }

    meshEntry.mesh.instanceMatrix.needsUpdate = true;
    meshEntry.mesh.computeBoundingSphere();
  }

  chunk.dirty = false;
  dirtyChunkKeys.delete(chunk.key);
}

function loadChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  if (loadedChunks.has(key)) {
    return;
  }
  const chunk = createChunk(cx, cz);
  loadedChunks.set(key, chunk);
  scene.add(chunk.group);
  markChunkDirty(cx, cz);
}

function unloadChunk(key) {
  const chunk = loadedChunks.get(key);
  if (!chunk) {
    return;
  }
  scene.remove(chunk.group);
  loadedChunks.delete(key);
  dirtyChunkKeys.delete(key);
}

function processDirtyChunks(limit) {
  if (dirtyChunkKeys.size === 0) {
    return;
  }

  let processed = 0;
  for (const key of dirtyChunkKeys) {
    const chunk = loadedChunks.get(key);
    if (!chunk) {
      dirtyChunkKeys.delete(key);
      continue;
    }

    rebuildChunkMeshes(chunk);
    processed += 1;
    if (processed >= limit) {
      break;
    }
  }
}

function computeDesiredChunks() {
  const desired = new Set();
  const playerChunkX = worldToChunk(Math.floor(state.player.pos.x));
  const playerChunkZ = worldToChunk(Math.floor(state.player.pos.z));

  const forwardX = -Math.sin(state.player.yaw);
  const forwardZ = -Math.cos(state.player.yaw);

  for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx++) {
    for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz++) {
      const distance = Math.hypot(dx, dz);
      if (distance > STREAM_RADIUS) {
        continue;
      }

      const cx = playerChunkX + dx;
      const cz = playerChunkZ + dz;
      const key = chunkKey(cx, cz);

      if (distance <= STREAM_NEAR_RADIUS || distance === 0) {
        desired.add(key);
        continue;
      }

      const dirX = dx / distance;
      const dirZ = dz / distance;
      const dot = dirX * forwardX + dirZ * forwardZ;
      if (dot >= STREAM_DOT_THRESHOLD) {
        desired.add(key);
      }
    }
  }

  return desired;
}

function chunkDistanceFromPlayer(key) {
  const parsed = parseChunkKey(key);
  const playerChunkX = worldToChunk(Math.floor(state.player.pos.x));
  const playerChunkZ = worldToChunk(Math.floor(state.player.pos.z));
  return Math.hypot(parsed.cx - playerChunkX, parsed.cz - playerChunkZ);
}

function updateChunkStreaming(force) {
  const desired = computeDesiredChunks();

  for (const key of loadedChunks.keys()) {
    if (!desired.has(key)) {
      unloadChunk(key);
    }
  }

  const missing = [];
  for (const key of desired) {
    if (!loadedChunks.has(key)) {
      missing.push(key);
    }
  }

  missing.sort((a, b) => chunkDistanceFromPlayer(a) - chunkDistanceFromPlayer(b));

  const loadBudget = force ? missing.length : CHUNK_LOAD_BUDGET;
  for (let i = 0; i < Math.min(loadBudget, missing.length); i++) {
    const parsed = parseChunkKey(missing[i]);
    loadChunk(parsed.cx, parsed.cz);
  }

  processDirtyChunks(force ? Number.MAX_SAFE_INTEGER : CHUNK_REBUILD_BUDGET);
  state.loadedChunkCount = loadedChunks.size;
}

function collidesAtPosition(x, y, z) {
  const p = state.player;
  const minX = Math.floor(x - p.radius);
  const maxX = Math.floor(x + p.radius - 1e-4);
  const minY = Math.floor(y);
  const maxY = Math.floor(y + p.height - 1e-4);
  const minZ = Math.floor(z - p.radius);
  const maxZ = Math.floor(z + p.radius - 1e-4);

  for (let gx = minX; gx <= maxX; gx++) {
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gz = minZ; gz <= maxZ; gz++) {
        if (isSolidBlock(gx, gy, gz)) {
          return true;
        }
      }
    }
  }
  return false;
}

function movePlayerAxis(axis, delta) {
  if (delta === 0) {
    return true;
  }

  const direction = Math.sign(delta);
  const maxStep = 0.05;
  let remaining = delta;

  while (Math.abs(remaining) > 1e-5) {
    const step = Math.abs(remaining) > maxStep ? maxStep * direction : remaining;
    const x = axis === "x" ? state.player.pos.x + step : state.player.pos.x;
    const y = axis === "y" ? state.player.pos.y + step : state.player.pos.y;
    const z = axis === "z" ? state.player.pos.z + step : state.player.pos.z;

    if (collidesAtPosition(x, y, z)) {
      return false;
    }

    state.player.pos.set(x, y, z);
    remaining -= step;
  }

  return true;
}

function updateMovement(dt) {
  const p = state.player;

  let forward = 0;
  let strafe = 0;
  let turn = 0;

  if (state.keys.has("KeyW") || state.keys.has("ArrowUp")) {
    forward += 1;
  }
  if (state.keys.has("KeyS") || state.keys.has("ArrowDown")) {
    forward -= 1;
  }
  if (state.keys.has("KeyA")) {
    strafe -= 1;
  }
  if (state.keys.has("KeyD")) {
    strafe += 1;
  }
  if (state.keys.has("ArrowLeft") || state.keys.has("KeyQ")) {
    turn += 1;
  }
  if (state.keys.has("ArrowRight") || state.keys.has("KeyE")) {
    turn -= 1;
  }
  if (turn !== 0) {
    p.yaw += turn * TURN_SPEED * dt;
  }

  if (state.mobile.enabled) {
    forward += THREE.MathUtils.clamp(-state.mobile.move.axisY, -1, 1);
    strafe += THREE.MathUtils.clamp(state.mobile.move.axisX, -1, 1);
  }

  let inputX = 0;
  let inputZ = 0;
  if (forward !== 0 || strafe !== 0) {
    const len = Math.hypot(forward, strafe);
    const normF = forward / len;
    const normS = strafe / len;

    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);

    inputX = -sin * normF + cos * normS;
    inputZ = -cos * normF - sin * normS;
  }

  const speed = p.onGround ? WALK_SPEED : AIR_SPEED;
  const targetVX = inputX * speed;
  const targetVZ = inputZ * speed;

  const accel = p.onGround ? 15 : 7;
  const blend = Math.min(1, accel * dt);
  p.vel.x += (targetVX - p.vel.x) * blend;
  p.vel.z += (targetVZ - p.vel.z) * blend;

  const jumpPressed = state.keys.has("Space") || state.mobile.jumpRequested;
  if (jumpPressed && p.onGround) {
    p.vel.y = JUMP_SPEED;
    p.onGround = false;
  }
  state.mobile.jumpRequested = false;

  p.vel.y -= GRAVITY * dt;
  p.vel.y = Math.max(p.vel.y, -36);

  movePlayerAxis("x", p.vel.x * dt);
  movePlayerAxis("z", p.vel.z * dt);

  p.onGround = false;
  const movedY = movePlayerAxis("y", p.vel.y * dt);
  if (!movedY) {
    if (p.vel.y < 0) {
      p.onGround = true;
    }
    p.vel.y = 0;
  }
}

const raycaster = new THREE.Raycaster();
const centerNdc = new THREE.Vector2(0, 0);

function axisAlignedNormal(vector) {
  const absX = Math.abs(vector.x);
  const absY = Math.abs(vector.y);
  const absZ = Math.abs(vector.z);

  if (absX >= absY && absX >= absZ) {
    return { x: Math.sign(vector.x) || 1, y: 0, z: 0 };
  }
  if (absY >= absX && absY >= absZ) {
    return { x: 0, y: Math.sign(vector.y) || 1, z: 0 };
  }
  return { x: 0, y: 0, z: Math.sign(vector.z) || 1 };
}

function collectRaycastMeshes() {
  const meshes = [];
  for (const chunk of loadedChunks.values()) {
    for (const meshEntry of chunk.meshes) {
      if (meshEntry.mesh.count > 0) {
        meshes.push(meshEntry.mesh);
      }
    }
  }
  return meshes;
}

function updateTargetBlock() {
  const meshes = collectRaycastMeshes();
  if (meshes.length === 0) {
    state.target = null;
    targetOutline.visible = false;
    return;
  }

  raycaster.setFromCamera(centerNdc, camera);
  const hit = raycaster
    .intersectObjects(meshes, false)
    .find((candidate) => candidate.distance <= REACH_DISTANCE && candidate.instanceId !== undefined);

  if (!hit) {
    state.target = null;
    targetOutline.visible = false;
    return;
  }

  const hitChunk = loadedChunks.get(hit.object.userData.chunkKey);
  if (!hitChunk) {
    state.target = null;
    targetOutline.visible = false;
    return;
  }

  const typeIndex = hit.object.userData.typeIndex;
  const meshEntry = hitChunk.meshes[typeIndex];
  const local = meshEntry.instanceToLocal[hit.instanceId];
  if (!local) {
    state.target = null;
    targetOutline.visible = false;
    return;
  }

  const worldX = hitChunk.cx * CHUNK_SIZE + local.lx;
  const worldY = local.y;
  const worldZ = hitChunk.cz * CHUNK_SIZE + local.lz;

  const faceNormal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0);
  faceNormal.transformDirection(hit.object.matrixWorld);
  const normal = axisAlignedNormal(faceNormal);

  state.target = {
    x: worldX,
    y: worldY,
    z: worldZ,
    distance: hit.distance,
    normal,
    type: BLOCK_TYPES[typeIndex].id,
  };

  targetOutline.position.set(worldX + 0.5, worldY + 0.5, worldZ + 0.5);
  targetOutline.visible = true;
}

function playerIntersectsBlock(bx, by, bz) {
  const p = state.player;
  const minX = p.pos.x - p.radius;
  const maxX = p.pos.x + p.radius;
  const minY = p.pos.y;
  const maxY = p.pos.y + p.height;
  const minZ = p.pos.z - p.radius;
  const maxZ = p.pos.z + p.radius;

  return maxX > bx && minX < bx + 1 && maxY > by && minY < by + 1 && maxZ > bz && minZ < bz + 1;
}

function breakTargetBlock() {
  if (!state.target) {
    return;
  }
  if (state.target.y <= 0) {
    return;
  }
  removeBlockType(state.target.x, state.target.y, state.target.z);
  updateTargetBlock();
}

function placeSelectedBlock() {
  if (!state.target) {
    return;
  }

  const x = state.target.x + state.target.normal.x;
  const y = state.target.y + state.target.normal.y;
  const z = state.target.z + state.target.normal.z;

  if (y < 0 || y >= WORLD_MAX_Y) {
    return;
  }
  const existingType = getBlockType(x, y, z);
  if (existingType !== null && existingType !== BLOCK_INDEX_WATER) {
    return;
  }
  if (playerIntersectsBlock(x, y, z)) {
    return;
  }

  setBlockType(x, y, z, HOTBAR_TYPES[state.selectedType]);
  updateTargetBlock();
}

function updateCamera() {
  const p = state.player;
  camera.position.set(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch;
}

function updateSky(dt) {
  state.time += dt;
  const dayWave = (Math.sin(state.time * 0.08) + 1) * 0.5;
  const r = 0.38 + dayWave * 0.29;
  const g = 0.59 + dayWave * 0.25;
  const b = 0.82 + dayWave * 0.16;
  scene.background.setRGB(r, g, b);
  scene.fog.color.setRGB(r * 0.92, g * 0.95, b);
  hemiLight.intensity = 0.72 + dayWave * 0.55;
  sunLight.intensity = 0.45 + dayWave * 0.7;

  const waterMaterial = blockMaterials[BLOCK_INDEX_WATER];
  const shimmer = 0.78 + dayWave * 0.2;
  waterMaterial.color.setRGB(0.2, 0.45 * shimmer, 0.75 * shimmer);
}

function updateStatusText(force) {
  state.hudTick += 1;
  if (!force && state.hudTick % 5 !== 0) {
    return;
  }

  const p = state.player;
  const selectedType = BLOCK_TYPES[HOTBAR_TYPES[state.selectedType]];
  const targetText = state.target
    ? `Target ${state.target.type} @ ${state.target.x},${state.target.y},${state.target.z}`
    : "Target none";
  const controlsText = state.mobile.enabled
    ? "Mobile: Left pad move • Right pad look • Jump/Break/Place"
    : "Move: WASD/Arrows • Turn: Mouse or Q/E/Arrows • LMB/RMB or B/Enter";

  statusEl.textContent = `${state.pointerLocked ? "Mouse locked" : "Click canvas to lock mouse"} • ${targetText} • Chunks ${state.loadedChunkCount} • ${controlsText} • ${selectedType.label} • XYZ ${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}`;
}

const hotbarItems = [];

function selectHotbarSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_TYPES.length) {
    return;
  }
  state.selectedType = slot;
  refreshHotbarSelection();
  updateStatusText(true);
}

function buildHotbar() {
  hotbarEl.innerHTML = "";
  hotbarItems.length = 0;

  HOTBAR_TYPES.forEach((typeIndex, slot) => {
    const item = document.createElement("div");
    item.className = "hotbar-item";
    item.textContent = `${slot + 1}:${BLOCK_TYPES[typeIndex].label}`;
    item.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      selectHotbarSlot(slot);
    });
    hotbarEl.appendChild(item);
    hotbarItems.push(item);
  });

  refreshHotbarSelection();
}

function refreshHotbarSelection() {
  for (let i = 0; i < hotbarItems.length; i++) {
    hotbarItems[i].classList.toggle("active", i === state.selectedType);
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", onResize);
document.addEventListener("fullscreenchange", onResize);

window.addEventListener("keydown", (event) => {
  if (
    event.code === "ArrowUp" ||
    event.code === "ArrowDown" ||
    event.code === "ArrowLeft" ||
    event.code === "ArrowRight" ||
    event.code === "Space"
  ) {
    event.preventDefault();
  }

  if (event.code.startsWith("Digit")) {
    const value = Number(event.code.slice(5));
    if (Number.isFinite(value) && value >= 1 && value <= HOTBAR_TYPES.length) {
      selectHotbarSlot(value - 1);
    }
  }

  if (event.code === "KeyF") {
    toggleFullscreen();
  }
  if (event.code === "KeyB") {
    breakTargetBlock();
  }
  if (event.code === "Enter") {
    placeSelectedBlock();
  }

  if (
    !state.mobile.enabled &&
    !state.pointerLocked &&
    (event.code === "KeyW" ||
      event.code === "KeyA" ||
      event.code === "KeyS" ||
      event.code === "KeyD" ||
      event.code === "ArrowUp" ||
      event.code === "ArrowDown" ||
      event.code === "ArrowLeft" ||
      event.code === "ArrowRight")
  ) {
    try {
      renderer.domElement.requestPointerLock?.();
    } catch {
      // Browser may ignore pointer lock if key press isn't accepted as a gesture.
    }
  }

  state.keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  state.keys.delete(event.code);
});

window.addEventListener("blur", () => {
  state.keys.clear();
});

renderer.domElement.addEventListener("click", () => {
  if (state.mobile.enabled) {
    return;
  }
  renderer.domElement.requestPointerLock?.();
});

document.addEventListener("pointerlockchange", () => {
  state.pointerLocked = document.pointerLockElement === renderer.domElement;
  updateStatusText(true);
});

function applyMouseLook(moveXRaw, moveYRaw) {
  const sensitivityX = 0.0023;
  const sensitivityY = 0.0019;
  const moveX = THREE.MathUtils.clamp(moveXRaw, -80, 80);
  const moveY = THREE.MathUtils.clamp(moveYRaw, -80, 80);

  state.player.yaw -= moveX * sensitivityX;
  state.player.pitch -= moveY * sensitivityY;
  state.player.pitch = THREE.MathUtils.clamp(state.player.pitch, -1.54, 1.54);
}

document.addEventListener("mousemove", (event) => {
  if (!state.pointerLocked) {
    return;
  }
  applyMouseLook(event.movementX, event.movementY);
});

renderer.domElement.addEventListener("mousemove", (event) => {
  if (state.pointerLocked) {
    return;
  }
  applyMouseLook(event.movementX, event.movementY);
});

function findTouchById(touches, id) {
  for (let i = 0; i < touches.length; i++) {
    if (touches[i].identifier === id) {
      return touches[i];
    }
  }
  return null;
}

function setMoveStickVisual(axisX, axisY) {
  if (!moveStickEl) {
    return;
  }
  const maxOffset = 34;
  moveStickEl.style.transform = `translate(${axisX * maxOffset}px, ${axisY * maxOffset}px)`;
}

function clearMoveAxis() {
  state.mobile.move.activeId = null;
  state.mobile.move.axisX = 0;
  state.mobile.move.axisY = 0;
  setMoveStickVisual(0, 0);
}

function updateMoveAxisFromTouch(touch) {
  if (!movePadEl) {
    return;
  }
  const rect = movePadEl.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  let axisX = (touch.clientX - cx) / (rect.width * 0.5);
  let axisY = (touch.clientY - cy) / (rect.height * 0.5);
  const len = Math.hypot(axisX, axisY);
  if (len > 1) {
    axisX /= len;
    axisY /= len;
  }
  state.mobile.move.axisX = THREE.MathUtils.clamp(axisX, -1, 1);
  state.mobile.move.axisY = THREE.MathUtils.clamp(axisY, -1, 1);
  setMoveStickVisual(state.mobile.move.axisX, state.mobile.move.axisY);
}

function bindMobileControls() {
  if (!state.mobile.enabled || !movePadEl || !lookPadEl) {
    return;
  }

  movePadEl.addEventListener(
    "touchstart",
    (event) => {
      event.preventDefault();
      if (state.mobile.move.activeId !== null) {
        return;
      }
      const touch = event.changedTouches[0];
      state.mobile.move.activeId = touch.identifier;
      updateMoveAxisFromTouch(touch);
    },
    { passive: false }
  );

  movePadEl.addEventListener(
    "touchmove",
    (event) => {
      event.preventDefault();
      if (state.mobile.move.activeId === null) {
        return;
      }
      const touch = findTouchById(event.touches, state.mobile.move.activeId);
      if (touch) {
        updateMoveAxisFromTouch(touch);
      }
    },
    { passive: false }
  );

  const onMoveTouchEnd = (event) => {
    if (state.mobile.move.activeId === null) {
      return;
    }
    const finished = findTouchById(event.changedTouches, state.mobile.move.activeId);
    if (finished) {
      clearMoveAxis();
    }
  };
  movePadEl.addEventListener("touchend", onMoveTouchEnd);
  movePadEl.addEventListener("touchcancel", onMoveTouchEnd);

  lookPadEl.addEventListener(
    "touchstart",
    (event) => {
      event.preventDefault();
      if (state.mobile.look.activeId !== null) {
        return;
      }
      const touch = event.changedTouches[0];
      state.mobile.look.activeId = touch.identifier;
      state.mobile.look.lastX = touch.clientX;
      state.mobile.look.lastY = touch.clientY;
    },
    { passive: false }
  );

  lookPadEl.addEventListener(
    "touchmove",
    (event) => {
      event.preventDefault();
      if (state.mobile.look.activeId === null) {
        return;
      }
      const touch = findTouchById(event.touches, state.mobile.look.activeId);
      if (!touch) {
        return;
      }
      const dx = touch.clientX - state.mobile.look.lastX;
      const dy = touch.clientY - state.mobile.look.lastY;
      state.mobile.look.lastX = touch.clientX;
      state.mobile.look.lastY = touch.clientY;
      applyMouseLook(dx * 1.5, dy * 1.5);
    },
    { passive: false }
  );

  const onLookTouchEnd = (event) => {
    if (state.mobile.look.activeId === null) {
      return;
    }
    const finished = findTouchById(event.changedTouches, state.mobile.look.activeId);
    if (finished) {
      state.mobile.look.activeId = null;
    }
  };
  lookPadEl.addEventListener("touchend", onLookTouchEnd);
  lookPadEl.addEventListener("touchcancel", onLookTouchEnd);

  const tapHandler = (action) => (event) => {
    event.preventDefault();
    action();
  };
  if (jumpBtnEl) {
    jumpBtnEl.addEventListener("touchstart", tapHandler(() => (state.mobile.jumpRequested = true)), {
      passive: false,
    });
    jumpBtnEl.addEventListener("pointerdown", tapHandler(() => (state.mobile.jumpRequested = true)));
  }
  if (breakBtnEl) {
    breakBtnEl.addEventListener("touchstart", tapHandler(() => breakTargetBlock()), { passive: false });
    breakBtnEl.addEventListener("pointerdown", tapHandler(() => breakTargetBlock()));
  }
  if (placeBtnEl) {
    placeBtnEl.addEventListener("touchstart", tapHandler(() => placeSelectedBlock()), { passive: false });
    placeBtnEl.addEventListener("pointerdown", tapHandler(() => placeSelectedBlock()));
  }
}

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

window.addEventListener("mousedown", (event) => {
  if (event.button === 0) {
    breakTargetBlock();
  }
  if (event.button === 2) {
    placeSelectedBlock();
  }
});

function tick(dt) {
  updateMovement(dt);
  updateCamera();
  updateChunkStreaming(false);
  updateTargetBlock();
  updateSky(dt);
  updateStatusText(false);
}

function draw() {
  renderer.render(scene, camera);
}

let lastTime = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  tick(dt);
  draw();

  requestAnimationFrame(frame);
}

window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < steps; i++) {
    tick(1 / 60);
  }
  draw();
};

window.render_game_to_text = () => {
  const p = state.player;
  const payload = {
    mode: state.mode,
    coordinate_system: "origin is infinite-world coordinates, +x east/right, +y up, +z south/forward-grid",
    chunk_size: CHUNK_SIZE,
    world_max_y: WORLD_MAX_Y,
    water_level: WATER_LEVEL,
    loaded_chunks: state.loadedChunkCount,
    saved_edit_chunks: chunkEdits.size,
    mobile_enabled: state.mobile.enabled,
    mobile_move_axis: {
      x: Number(state.mobile.move.axisX.toFixed(3)),
      y: Number(state.mobile.move.axisY.toFixed(3)),
    },
    player: {
      x: Number(p.pos.x.toFixed(3)),
      y: Number(p.pos.y.toFixed(3)),
      z: Number(p.pos.z.toFixed(3)),
      vx: Number(p.vel.x.toFixed(3)),
      vy: Number(p.vel.y.toFixed(3)),
      vz: Number(p.vel.z.toFixed(3)),
      yaw: Number(p.yaw.toFixed(3)),
      pitch: Number(p.pitch.toFixed(3)),
      on_ground: p.onGround,
      pointer_locked: state.pointerLocked,
      chunk_x: worldToChunk(Math.floor(p.pos.x)),
      chunk_z: worldToChunk(Math.floor(p.pos.z)),
    },
    selected_block: BLOCK_TYPES[HOTBAR_TYPES[state.selectedType]].id,
    target: state.target
      ? {
          x: state.target.x,
          y: state.target.y,
          z: state.target.z,
          normal: state.target.normal,
          distance: Number(state.target.distance.toFixed(3)),
          type: state.target.type,
        }
      : null,
  };

  return JSON.stringify(payload);
};

const spawnHeight = getTerrainHeight(0, 0);
state.player.pos.set(0.5, spawnHeight + 2, 0.5);
buildHotbar();
bindMobileControls();
updateCamera();
for (let i = 0; i < 12; i++) {
  updateChunkStreaming(false);
}
updateTargetBlock();
updateStatusText(true);
requestAnimationFrame(frame);
