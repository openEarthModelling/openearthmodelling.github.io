import * as THREE from 'three';

/* ============================================================
   Realistic Earth + layered model grids (docs/design/hero.md §4, v1.4.2)
   Layers (inside out):
     earth sphere (day/night shader)
     ocean grid  1.002R  azure blue, classified from day texture
     land grid   1.010R  cyan (site accent), nodes echo the org logo
     clouds      1.018/1.030R  double transparent shell (offset patterns)
     atmo grid   1.170R  pale ice cage, drifts with the clouds
     fresnel rim 1.240R
   ============================================================ */

export function initGlobe(canvas: HTMLCanvasElement, heroEl: HTMLElement, heroText: HTMLElement): void {
  // ---- tunables (spec §4 / §5) ----
  const R = 2;
  const SURFACE_DETAIL = { desktop: 9, mobile: 7 }; // ~1002 / ~642 cells
  const ATMO_DETAIL = { desktop: 8, mobile: 6 }; // ~812 / ~442 cells
  const OCEAN_R = R * 1.002,
    LAND_R = R * 1.01,
    ATMO_R = R * 1.17;
  const OCEAN_LINE = { color: 0x1d76c4, opacity: 0.22 }; // azure blue
  const LAND_LINE = { color: 0x22d3ee, opacity: 0.34 }; // cyan (site accent)
  const ATMO_LINE = { color: 0xc9e9f7, opacity: 0.22 }; // pale ice
  const AUTO_SPEED = 0.07; // rad/s
  const ATMO_DRIFT = 0.012; // rad/s eastward (clouds + atmosphere grid)
  const MAX_TILT = 1.1;
  const DPR_CAP = 2;
  const LAYOUT = {
    desktop: { x: 3.6, y: -0.05, scale: 1.0 },
    tablet: { x: 2.6, y: 0, scale: 0.95 },
    mobile: { x: 0, y: -1.15, scale: 0.85 },
  };
  const SUN = new THREE.Vector3(-1.2, 0.5, 0.9).normalize();
  const DAY_URLS = ['/textures/earth-blue-marble.jpg'];
  const NIGHT_URLS = ['/textures/earth-night.jpg'];
  const CLOUD_URLS = ['/textures/earth-clouds.png'];

  const isMobile = () => window.innerWidth < 768;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  // ---- renderer / scene / camera ----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, DPR_CAP));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
  camera.position.set(0, 0, 9);

  const parallaxGroup = new THREE.Group();
  const globeGroup = new THREE.Group();
  const atmoGroup = new THREE.Group(); // clouds + atmosphere grid drift together
  globeGroup.add(atmoGroup);
  parallaxGroup.add(globeGroup);
  scene.add(parallaxGroup);

  // lights only affect the Lambert cloud shells; the earth shader bakes
  // sun direction itself (kept consistent: same SUN vector)
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.copy(SUN).multiplyScalar(10);
  scene.add(sun);

  // ---- starfield (desktop only, spec §4.5) ----
  if (!isMobile()) {
    const sp: number[] = [];
    for (let i = 0; i < 650; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(18 + Math.random() * 22);
      sp.push(v.x, v.y, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    scene.add(
      new THREE.Points(
        g,
        new THREE.PointsMaterial({
          color: 0x8fb3c9,
          size: 0.05,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        }),
      ),
    );
  }

  // ---- interaction state (spec §5) ----
  const rot = { x: 0.24, y: -1.83 }; // initial view: East Asia
  const vel = { x: 0, y: 0 };
  let dragging = false,
    lastX = 0,
    lastY = 0,
    lastT = 0;
  let lastInteract = -1e9;
  let atmoAngle = 0;
  let par = { x: 0, y: 0 },
    parT = { x: 0, y: 0 };

  // ============================================================
  // hex grid lattice: dual of a subdivided icosahedron.
  // Returns unit-sphere segments (with midpoints) and vertices;
  // callers scale to their layer radius and classify ocean/land.
  // ============================================================
  function buildHexLattice(detail: number) {
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const pos = geo.attributes.position;
    const A = new THREE.Vector3(),
      B = new THREE.Vector3(),
      C = new THREE.Vector3();
    const faces: THREE.Vector3[][] = [];
    const centroids: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      A.fromBufferAttribute(pos, i);
      B.fromBufferAttribute(pos, i + 1);
      C.fromBufferAttribute(pos, i + 2);
      faces.push([A.clone(), B.clone(), C.clone()]);
      centroids.push(A.clone().add(B).add(C).normalize());
    }
    const Q = 1e5;
    const key = (v: THREE.Vector3) =>
      Math.round(v.x * Q) + ',' + Math.round(v.y * Q) + ',' + Math.round(v.z * Q);
    const edges = new Map<string, number[]>();
    faces.forEach((f, fi) => {
      for (let e = 0; e < 3; e++) {
        const k1 = key(f[e]!),
          k2 = key(f[(e + 1) % 3]!)!;
        const ek = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        const rec = edges.get(ek);
        if (rec) rec.push(fi);
        else edges.set(ek, [fi]);
      }
    });
    const segs: { a: THREE.Vector3; b: THREE.Vector3; mid: THREE.Vector3 }[] = [];
    edges.forEach((fl) => {
      if (fl.length !== 2) return;
      const a = centroids[fl[0]!]!,
        b = centroids[fl[1]!]!;
      segs.push({ a, b, mid: a.clone().add(b).normalize() });
    });
    const nodeMap = new Map<string, THREE.Vector3>();
    faces.forEach((f) => f.forEach((v) => nodeMap.set(key(v), v)));
    return { segs, nodes: [...nodeMap.values()] };
  }

  // ocean/land classifier from the day texture (spec §4.4):
  // downsample once to 1024x512, blue-dominant pixel = ocean
  function makeClassifier(dayTex: THREE.Texture | null) {
    if (!dayTex) return null;
    const img = dayTex.image as HTMLImageElement | HTMLCanvasElement;
    const w = 1024,
      h = 512;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    return (v: THREE.Vector3): 'ocean' | 'land' => {
      const lat = Math.asin(Math.max(-1, Math.min(1, v.y)));
      const lon = Math.atan2(v.x, v.z);
      const px = Math.min(w - 1, Math.max(0, Math.floor((lon / (2 * Math.PI) + 0.5) * w)));
      const py = Math.min(h - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * h)));
      const i = (py * w + px) * 4;
      const r = d[i]! / 255,
        b = d[i + 2]! / 255;
      return b > r + 0.06 && b > 0.16 ? 'ocean' : 'land';
    };
  }

  function lineObj(positions: number[], { color, opacity }: { color: number; opacity: number }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const l = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
      }),
    );
    l.renderOrder = 1;
    return l;
  }
  function nodeObj(
    positions: number[],
    { color, opacity, size }: { color: number; opacity: number; size: number },
  ) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const p = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color,
        size,
        sizeAttenuation: true,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    );
    p.renderOrder = 1;
    return p;
  }

  // ---- day/night earth shader (spec §4.2) ----
  const earthVert = `
    varying vec2 vUv;
    varying vec3 vWn;
    void main() {
      vUv = uv;
      vWn = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const earthFrag = `
    uniform sampler2D dayMap;
    uniform sampler2D nightMap;
    uniform vec3 sunDir;
    varying vec2 vUv;
    varying vec3 vWn;
    void main() {
      vec3 n = normalize(vWn);
      float d = dot(n, normalize(sunDir));
      float dayAmt = smoothstep(-0.15, 0.25, d);
      vec3 day = texture2D(dayMap, vUv).rgb;
      vec3 night = texture2D(nightMap, vUv).rgb;
      vec3 nightCol = night * 1.7 + day * 0.02;
      vec3 dayCol = day * (0.28 + 0.95 * clamp(d, 0.0, 1.0));
      gl_FragColor = vec4(mix(nightCol, dayCol, dayAmt), 1.0);
    }`;

  function build(day: THREE.Texture | null, night: THREE.Texture | null, clouds: THREE.Texture | null) {
    // earth sphere
    const earthGeo = new THREE.SphereGeometry(R, 96, 96);
    if (day) {
      globeGroup.add(
        new THREE.Mesh(
          earthGeo,
          new THREE.ShaderMaterial({
            uniforms: {
              dayMap: { value: day },
              nightMap: { value: night || day },
              sunDir: { value: SUN },
            },
            vertexShader: earthVert,
            fragmentShader: earthFrag,
          }),
        ),
      );
    } else {
      globeGroup.add(new THREE.Mesh(earthGeo, new THREE.MeshLambertMaterial({ color: 0x0d2438 })));
    }

    // clouds -> atmosphere group (drifts with the atmo grid)
    // two shells at different radii with offset rotation = thicker deck
    if (clouds) {
      [
        [1.018, 0.75, 0],
        [1.03, 0.5, 2.1],
      ].forEach(([rr, op, off]) => {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(R * rr, 96, 96),
          new THREE.MeshLambertMaterial({
            map: clouds,
            transparent: true,
            opacity: op,
            depthWrite: false,
          }),
        );
        m.renderOrder = 2;
        m.rotation.y = off;
        atmoGroup.add(m);
      });
    }

    // ---- surface layer: ocean grid + land grid (spec §4.4) ----
    const surf = buildHexLattice(isMobile() ? SURFACE_DETAIL.mobile : SURFACE_DETAIL.desktop);
    const classify = makeClassifier(day);
    const landSeg: number[] = [],
      oceanSeg: number[] = [],
      landNodes: number[] = [],
      oceanNodes: number[] = [];
    surf.segs.forEach((s) => {
      const isOcean = classify && classify(s.mid) === 'ocean';
      const rr = isOcean ? OCEAN_R : LAND_R;
      const buf = isOcean ? oceanSeg : landSeg;
      buf.push(s.a.x * rr, s.a.y * rr, s.a.z * rr, s.b.x * rr, s.b.y * rr, s.b.z * rr);
    });
    surf.nodes.forEach((v) => {
      const isOcean = classify && classify(v) === 'ocean';
      const rr = isOcean ? OCEAN_R : LAND_R;
      const buf = isOcean ? oceanNodes : landNodes;
      buf.push(v.x * rr, v.y * rr, v.z * rr);
    });
    globeGroup.add(lineObj(landSeg, LAND_LINE));
    globeGroup.add(lineObj(oceanSeg, OCEAN_LINE));
    globeGroup.add(nodeObj(landNodes, { color: 0x67e8f9, opacity: 0.55, size: 0.03 }));
    globeGroup.add(nodeObj(oceanNodes, { color: 0x86c5ee, opacity: 0.28, size: 0.022 }));

    // ---- atmosphere cage: coarse, pale, drifts with clouds ----
    const atmo = buildHexLattice(isMobile() ? ATMO_DETAIL.mobile : ATMO_DETAIL.desktop);
    const atmoSeg: number[] = [];
    atmo.segs.forEach((s) => {
      atmoSeg.push(s.a.x * ATMO_R, s.a.y * ATMO_R, s.a.z * ATMO_R, s.b.x * ATMO_R, s.b.y * ATMO_R, s.b.z * ATMO_R);
    });
    atmoGroup.add(lineObj(atmoSeg, ATMO_LINE));

    // ---- fresnel rim ----
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.24, 64, 64),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          varying vec3 vN;
          void main() {
            vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vN;
          void main() {
            float i = pow(clamp(0.62 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.0);
            gl_FragColor = vec4(0.28, 0.78, 0.92, 1.0) * i * 0.55;
          }`,
      }),
    );
    rim.renderOrder = 3;
    globeGroup.add(rim);

    applyRotation();
    canvas.classList.add('ready');
    if (reduced) renderOnce();
  }

  // ---- texture loader with fallback chain ----
  function loadTex(urls: string[]): Promise<THREE.Texture | null> {
    return new Promise((resolve) => {
      const tryAt = (i: number) => {
        if (i >= urls.length) return resolve(null);
        new THREE.TextureLoader().load(
          urls[i]!,
          (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            resolve(t);
          },
          undefined,
          () => tryAt(i + 1),
        );
      };
      tryAt(0);
    });
  }
  Promise.all([loadTex(DAY_URLS), loadTex(NIGHT_URLS), loadTex(CLOUD_URLS)]).then(([d, n, c]) =>
    build(d, n, c),
  );

  // ============================================================
  // interaction (spec §5)
  // ============================================================
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = performance.now();
    vel.x = vel.y = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    const k = 0.005;
    const dx = e.clientX - lastX,
      dy = e.clientY - lastY;
    rot.y += dx * k;
    rot.x = Math.max(-MAX_TILT, Math.min(MAX_TILT, rot.x + dy * k));
    vel.y = (dx / dt) * 1000 * k;
    vel.x = (dy / dt) * 1000 * k;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;
    applyRotation();
    if (reduced) renderOnce();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    lastInteract = performance.now();
    if (reduced) {
      vel.x = vel.y = 0;
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  if (finePointer && !reduced) {
    window.addEventListener('pointermove', (e) => {
      if (dragging) return;
      parT.x = e.clientX / window.innerWidth - 0.5;
      parT.y = e.clientY / window.innerHeight - 0.5;
    });
  }

  function applyRotation() {
    globeGroup.rotation.set(rot.x, rot.y, 0);
    atmoGroup.rotation.y = atmoAngle;
  }

  // ---- layout (spec §2) ----
  function layout() {
    const w = heroEl.clientWidth,
      h = heroEl.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const L = w >= 1024 ? LAYOUT.desktop : w >= 768 ? LAYOUT.tablet : LAYOUT.mobile;
    globeGroup.position.set(L.x, L.y, 0);
    globeGroup.scale.setScalar(L.scale);
    document.body.classList.toggle('mobile-hero', w < 768);
    if (reduced) renderOnce();
  }
  layout();
  window.addEventListener('resize', layout);

  // ---- frame loop (reduced-motion: render on demand instead) ----
  function renderOnce() {
    renderer.render(scene, camera);
  }

  if (!reduced) {
    let prev = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      if (!dragging) {
        rot.y += vel.y * dt;
        rot.x = Math.max(-MAX_TILT, Math.min(MAX_TILT, rot.x + vel.x * dt));
        const damp = Math.exp(-2.8 * dt);
        vel.x *= damp;
        vel.y *= damp;
        if (now - lastInteract > 1500) rot.y += AUTO_SPEED * dt;
      }
      atmoAngle += ATMO_DRIFT * dt;
      par.x += (parT.x - par.x) * 0.045;
      par.y += (parT.y - par.y) * 0.045;
      parallaxGroup.rotation.x = par.y * 0.1;
      parallaxGroup.rotation.y = par.x * 0.14;
      heroText.style.transform = `translate(${(-par.x * 8).toFixed(2)}px, ${(-par.y * 6).toFixed(2)}px)`;
      applyRotation();
      renderer.render(scene, camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
