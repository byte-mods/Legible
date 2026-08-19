/**
 * Interactive 3D scenes.
 *
 * Each scene is a small parameterised world the reader can rotate with a drag
 * and drive with the same sliders the 2D simulators use. The model picks a kind
 * and fills in its parameters; nothing here executes model-supplied code — the
 * only dynamic input is an arithmetic expression, evaluated by the whitelist
 * parser in formula.js.
 *
 * mount(container, spec, values) -> { update(values), dispose() }
 */

import * as THREE from '/vendor/three/three.module.js';
import { compile } from '/formula.js';

const ACCENT = 0x7c5cff;
const ACCENT_2 = 0x22d3ee;
const WARM = 0xf472b6;

/* ─────────────────────────────── plumbing ─────────────────────────────── */

function makeRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(container.clientWidth || 480, container.clientHeight || 300, false);
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
  container.appendChild(renderer.domElement);
  return renderer;
}

/** Drag to orbit, wheel to zoom. Small enough not to need OrbitControls. */
function orbitCamera(camera, dom, target = new THREE.Vector3(0, 0, 0), radius = 9) {
  const st = { theta: Math.PI * 0.25, phi: Math.PI * 0.33, r: radius, dragging: false, lx: 0, ly: 0 };

  const apply = () => {
    camera.position.set(
      target.x + st.r * Math.sin(st.phi) * Math.cos(st.theta),
      target.y + st.r * Math.cos(st.phi),
      target.z + st.r * Math.sin(st.phi) * Math.sin(st.theta)
    );
    camera.lookAt(target);
  };
  apply();

  const down = (e) => {
    st.dragging = true;
    st.lx = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    st.ly = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    dom.style.cursor = 'grabbing';
  };
  const move = (e) => {
    if (!st.dragging) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    st.theta -= (x - st.lx) * 0.008;
    st.phi = Math.max(0.12, Math.min(Math.PI - 0.12, st.phi - (y - st.ly) * 0.008));
    st.lx = x;
    st.ly = y;
    apply();
    e.preventDefault?.();
  };
  const up = () => {
    st.dragging = false;
    dom.style.cursor = 'grab';
  };
  const wheel = (e) => {
    st.r = Math.max(2.5, Math.min(40, st.r + Math.sign(e.deltaY) * st.r * 0.12));
    apply();
    e.preventDefault();
  };

  dom.style.cursor = 'grab';
  dom.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  dom.addEventListener('wheel', wheel, { passive: false });
  dom.addEventListener('touchstart', down, { passive: true });
  dom.addEventListener('touchmove', move, { passive: false });
  dom.addEventListener('touchend', up);

  return {
    setTarget: (t) => target.copy(t),
    apply,
    dispose() {
      dom.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dom.removeEventListener('wheel', wheel);
    },
  };
}

function lights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(5, 8, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(ACCENT_2, 0.5);
  rim.position.set(-6, 3, -5);
  scene.add(rim);
}

const disposeTree = (obj) => {
  obj.traverse?.((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
    else o.material?.dispose?.();
  });
};

/* ─────────────────────────────── scene kinds ──────────────────────────── */

/**
 * z = f(x, y) as a solid surface. Covers most of maths, and an ML loss
 * landscape is just a surface with a descent path walked over it.
 */
function surfaceScene(scene, spec, values) {
  const compiled = compile(spec.expression ?? 'sin(x)*cos(y)');
  if (!compiled.ok) return { update() {}, error: compiled.error };

  const N = 56;
  const rangeX = [Number(spec.xMin ?? -3), Number(spec.xMax ?? 3)];
  const rangeY = [Number(spec.yMin ?? -3), Number(spec.yMax ?? 3)];
  const geo = new THREE.PlaneGeometry(6, 6, N, N);
  const mat = new THREE.MeshStandardMaterial({
    color: ACCENT,
    metalness: 0.15,
    roughness: 0.55,
    side: THREE.DoubleSide,
    flatShading: false,
    wireframe: !!spec.wireframe,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  scene.add(mesh);

  const grid = new THREE.GridHelper(6, 12, 0x333947, 0x232833);
  grid.position.y = -2.2;
  scene.add(grid);

  // a marker that walks downhill, for gradient-descent style stories
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 20, 20),
    new THREE.MeshStandardMaterial({ color: ACCENT_2, emissive: ACCENT_2, emissiveIntensity: 0.5 })
  );
  if (spec.descent) scene.add(ball);
  const trail = new THREE.BufferGeometry();
  const trailMat = new THREE.LineBasicMaterial({ color: WARM });
  const trailLine = new THREE.Line(trail, trailMat);
  if (spec.descent) scene.add(trailLine);

  let walker = { x: Number(spec.startX ?? 2), y: Number(spec.startY ?? 2), path: [] };

  const sample = (x, y, vars) => {
    try {
      const z = compiled.eval({ ...vars, x, y });
      return Number.isFinite(z) ? z : 0;
    } catch {
      return 0;
    }
  };

  const rebuild = (vars) => {
    const pos = geo.attributes.position;
    let lo = Infinity;
    let hi = -Infinity;
    const zs = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const u = (pos.getX(i) + 3) / 6;
      const v = (pos.getY(i) + 3) / 6;
      const x = rangeX[0] + u * (rangeX[1] - rangeX[0]);
      const y = rangeY[0] + v * (rangeY[1] - rangeY[0]);
      const z = sample(x, y, vars);
      zs[i] = z;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    const span = hi - lo || 1;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = (zs[i] - lo) / span;
      pos.setZ(i, t * 3 - 1.5); // normalise height so any formula is viewable
      colors[i * 3] = 0.25 + 0.55 * t;
      colors[i * 3 + 1] = 0.35 + 0.25 * (1 - t);
      colors[i * 3 + 2] = 0.75 + 0.2 * (1 - t);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mat.vertexColors = true;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return { lo, hi, span };
  };

  let scale = rebuild(values);

  const toWorld = (x, y, z) => {
    const u = (x - rangeX[0]) / (rangeX[1] - rangeX[0]);
    const v = (y - rangeY[0]) / (rangeY[1] - rangeY[0]);
    const t = (z - scale.lo) / (scale.span || 1);
    return new THREE.Vector3(u * 6 - 3, t * 3 - 1.5, -(v * 6 - 3));
  };

  return {
    update(vars) {
      scale = rebuild(vars);
      walker = { x: Number(spec.startX ?? 2), y: Number(spec.startY ?? 2), path: [] };
    },
    tick(vars) {
      if (!spec.descent) return;
      // numeric gradient, then a step downhill
      const rate = Number(vars[spec.rateKey ?? 'rate'] ?? spec.rate ?? 0.08);
      const h = 0.03;
      const gx = (sample(walker.x + h, walker.y, vars) - sample(walker.x - h, walker.y, vars)) / (2 * h);
      const gy = (sample(walker.x, walker.y + h, vars) - sample(walker.x, walker.y - h, vars)) / (2 * h);
      walker.x = Math.max(rangeX[0], Math.min(rangeX[1], walker.x - rate * gx));
      walker.y = Math.max(rangeY[0], Math.min(rangeY[1], walker.y - rate * gy));
      const p = toWorld(walker.x, walker.y, sample(walker.x, walker.y, vars));
      ball.position.copy(p).add(new THREE.Vector3(0, 0.12, 0));
      walker.path.push(p.clone());
      if (walker.path.length > 220) walker.path.shift();
      trail.setFromPoints(walker.path);
    },
  };
}

/** Atoms and bonds. Chemistry, and any "nodes joined by links" idea. */
function moleculeScene(scene, spec) {
  const atoms = Array.isArray(spec.atoms) ? spec.atoms.slice(0, 60) : [];
  const bonds = Array.isArray(spec.bonds) ? spec.bonds.slice(0, 120) : [];
  const group = new THREE.Group();
  scene.add(group);

  const COLORS = {
    H: 0xe8eaf0, C: 0x3b4252, N: 0x5b7cfa, O: 0xef4444, S: 0xfbbf24,
    P: 0xfb923c, Cl: 0x34d399, Na: 0xa78bfa, Fe: 0xf97316, default: 0x8f74ff,
  };
  const RADIUS = { H: 0.26, C: 0.4, N: 0.38, O: 0.36, default: 0.36 };

  const positions = atoms.map((a) => new THREE.Vector3(Number(a.x) || 0, Number(a.y) || 0, Number(a.z) || 0));

  atoms.forEach((a, i) => {
    const el = String(a.el ?? 'C');
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS[el] ?? RADIUS.default, 28, 28),
      new THREE.MeshStandardMaterial({
        color: COLORS[el] ?? COLORS.default,
        roughness: 0.35,
        metalness: 0.1,
      })
    );
    mesh.position.copy(positions[i]);
    group.add(mesh);
  });

  bonds.forEach((b) => {
    const a = positions[Number(b.a)];
    const c = positions[Number(b.b)];
    if (!a || !c) return;
    const dir = new THREE.Vector3().subVectors(c, a);
    const len = dir.length();
    if (!len) return;
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, len, 12),
      new THREE.MeshStandardMaterial({ color: 0x9aa0ad, roughness: 0.5 })
    );
    cyl.position.copy(a).add(dir.clone().multiplyScalar(0.5));
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    group.add(cyl);
  });

  // centre it so the orbit camera has something sensible to look at
  const box = new THREE.Box3().setFromObject(group);
  const centre = box.getCenter(new THREE.Vector3());
  group.position.sub(centre);

  return {
    update() {},
    tick() {
      if (spec.spin !== false) group.rotation.y += 0.004;
    },
  };
}

/** Projectile motion with real gravity. Physics, ballistics, game dev. */
function projectileScene(scene, spec) {
  const grid = new THREE.GridHelper(20, 20, 0x333947, 0x232833);
  scene.add(grid);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 24, 24),
    new THREE.MeshStandardMaterial({ color: ACCENT_2, emissive: ACCENT_2, emissiveIntensity: 0.35 })
  );
  scene.add(ball);

  const pathGeo = new THREE.BufferGeometry();
  const path = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: WARM }));
  scene.add(path);

  let t = 0;
  let pts = [];

  const params = (vars) => ({
    v: Number(vars[spec.speedKey ?? 'speed'] ?? 12),
    a: (Number(vars[spec.angleKey ?? 'angle'] ?? 45) * Math.PI) / 180,
    g: Number(vars[spec.gravityKey ?? 'gravity'] ?? 9.81),
  });

  const trajectory = (vars) => {
    const { v, a, g } = params(vars);
    const flight = (2 * v * Math.sin(a)) / (g || 9.81);
    const out = [];
    for (let i = 0; i <= 60; i++) {
      const s = (flight * i) / 60;
      out.push(new THREE.Vector3(v * Math.cos(a) * s - 8, Math.max(0, v * Math.sin(a) * s - 0.5 * g * s * s), 0));
    }
    return { out, flight };
  };

  let cache = trajectory({});

  return {
    update(vars) {
      cache = trajectory(vars);
      pts = cache.out;
      pathGeo.setFromPoints(pts);
      t = 0;
    },
    tick(vars) {
      const { v, a, g } = params(vars);
      t += 0.016;
      const flight = cache.flight || 1;
      if (t > flight) t = 0;
      ball.position.set(v * Math.cos(a) * t - 8, Math.max(0, v * Math.sin(a) * t - 0.5 * g * t * t), 0);
    },
  };
}

/** Two bodies under gravity. Physics, and any orbit/feedback story. */
function orbitScene(scene, spec) {
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 0.7 })
  );
  scene.add(sun);
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 28, 28),
    new THREE.MeshStandardMaterial({ color: ACCENT_2, roughness: 0.4 })
  );
  scene.add(planet);

  const ringGeo = new THREE.BufferGeometry();
  scene.add(new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: 0x50566a })));

  let angle = 0;
  return {
    update(vars) {
      const r = Number(vars[spec.radiusKey ?? 'radius'] ?? 4);
      const pts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      ringGeo.setFromPoints(pts);
    },
    tick(vars) {
      const r = Number(vars[spec.radiusKey ?? 'radius'] ?? 4);
      const m = Number(vars[spec.massKey ?? 'mass'] ?? 1);
      // Kepler: further out is slower, heavier centre is faster
      angle += (0.02 * Math.sqrt(Math.max(0.05, m))) / Math.max(0.5, Math.pow(r, 1.5) / 8);
      planet.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      sun.scale.setScalar(0.7 + 0.35 * Math.cbrt(m));
    },
  };
}

/** A vector or transform sandbox. Game development, linear algebra. */
function transformScene(scene, spec) {
  scene.add(new THREE.GridHelper(10, 10, 0x333947, 0x232833));
  scene.add(new THREE.AxesHelper(3));

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1.4, 1.4),
    new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.4, metalness: 0.15 })
  );
  scene.add(box);

  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1.4, 1.4),
    new THREE.MeshBasicMaterial({ color: 0x50566a, wireframe: true })
  );
  scene.add(ghost);

  return {
    update(vars) {
      const g = (k, d) => Number(vars[k] ?? d);
      box.position.set(g(spec.txKey ?? 'tx', 0), g(spec.tyKey ?? 'ty', 0), g(spec.tzKey ?? 'tz', 0));
      const s = g(spec.scaleKey ?? 'scale', 1);
      box.scale.setScalar(Math.max(0.05, s));
      box.rotation.set(
        (g(spec.rxKey ?? 'rx', 0) * Math.PI) / 180,
        (g(spec.ryKey ?? 'ry', 0) * Math.PI) / 180,
        (g(spec.rzKey ?? 'rz', 0) * Math.PI) / 180
      );
    },
    tick() {},
  };
}

const KINDS = {
  surface: surfaceScene,
  molecule: moleculeScene,
  projectile: projectileScene,
  orbit: orbitScene,
  transform: transformScene,
};

export const SCENE3D_KINDS = Object.keys(KINDS);

/* ──────────────────────────────── mount ───────────────────────────────── */

export function mount3D(container, spec, values = {}) {
  const build = KINDS[spec?.kind];
  if (!build) return null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50,
    (container.clientWidth || 480) / (container.clientHeight || 300),
    0.1,
    200
  );
  const renderer = makeRenderer(container);
  lights(scene);

  const impl = build(scene, spec, values);
  const cam = orbitCamera(camera, renderer.domElement, new THREE.Vector3(0, 0, 0), Number(spec.distance ?? 11));
  impl.update?.(values);

  let alive = true;
  let vars = values;
  const loop = () => {
    if (!alive) return;
    impl.tick?.(vars);
    renderer.render(scene, camera);
    // a timer rather than rAF, so a hidden pane does not freeze the scene
    setTimeout(loop, 1000 / 40);
  };
  loop();

  const onResize = () => {
    const w = container.clientWidth || 480;
    const h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  return {
    update(next) {
      vars = next;
      impl.update?.(next);
    },
    dispose() {
      alive = false;
      ro.disconnect();
      cam.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
