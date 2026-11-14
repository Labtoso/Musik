import * as THREE from 'three';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

function vinylTexture(accent, fontReady, img) {
  const S = 2048, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), R = S / 2;
  g.fillStyle = '#08080a';
  g.fillRect(0, 0, S, S);
  g.translate(R, R);
  // grooves
  for (let r = R * 0.98; r > R * 0.36; r -= 2.2) {
    const gap = [0.9, 0.78, 0.66, 0.53, 0.44].some((x) => Math.abs(r - R * x) < 4);
    g.strokeStyle = gap ? 'rgba(48,48,56,.6)' : (Math.random() < 0.5 ? 'rgba(30,30,34,.9)' : 'rgba(14,14,16,.9)');
    g.lineWidth = gap ? 3 : 1.2;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
  }
  // outer lip
  g.strokeStyle = 'rgba(55,55,62,.9)'; g.lineWidth = 10;
  g.beginPath(); g.arc(0, 0, R * 0.995, 0, Math.PI * 2); g.stroke();
  // label
  const lr = R * 0.33;
  if (img) {
    g.save(); g.beginPath(); g.arc(0, 0, lr, 0, Math.PI * 2); g.clip();
    g.drawImage(img, -lr, -lr, lr * 2, lr * 2);
    const v = g.createRadialGradient(0, 0, lr * 0.55, 0, 0, lr);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = v; g.fillRect(-lr, -lr, lr * 2, lr * 2);
    g.restore();
    g.fillStyle = '#000'; g.beginPath(); g.arc(0, 0, R * 0.018, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 3; g.beginPath(); g.arc(0, 0, lr, 0, Math.PI * 2); g.stroke();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; return tex;
  }
  const grad = g.createRadialGradient(-lr * 0.3, -lr * 0.3, lr * 0.1, 0, 0, lr);
  grad.addColorStop(0, accent.clone().offsetHSL(0, 0, 0.08).getStyle());
  grad.addColorStop(1, accent.clone().offsetHSL(0, 0, -0.08).getStyle());
  g.fillStyle = grad; g.beginPath(); g.arc(0, 0, lr, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 3;
  g.beginPath(); g.arc(0, 0, lr * 0.92, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(5,6,12,.92)'; g.textAlign = 'center';
  g.font = `italic 800 ${Math.round(lr * 0.36)}px ${fontReady ? 'Fraunces' : 'Georgia'}, serif`;
  g.fillText('Streyn', 0, -lr * 0.32);
  g.font = `500 ${Math.round(lr * 0.075)}px "JetBrains Mono", monospace`;
  g.fillText('LABTOSOSTUDIOS', 0, lr * 0.5);
  g.fillText('SIDE A  ·  33⅓ RPM', 0, lr * 0.64);
  // text along the rim of the label
  g.save();
  g.font = `500 ${Math.round(lr * 0.06)}px "JetBrains Mono", monospace`;
  const txt = 'SELF-HOSTED  ·  PROXMOX  ·  ANDROID  ·  WINDOWS  ·  LINUX  ·  ';
  const step = (Math.PI * 2) / txt.length;
  for (let i = 0; i < txt.length; i++) {
    g.save(); g.rotate(i * step); g.fillText(txt[i], 0, -lr * 0.8); g.restore();
  }
  g.restore();
  // spindle hole
  g.fillStyle = '#000'; g.beginPath(); g.arc(0, 0, R * 0.018, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function tube(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 20), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}

export function createTurntable(canvas, { accent = '#4c8dff', reduced = false, tracks = [], onTrack = () => {}, center = false, follow = true, manual = false, decor = null } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.2;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  const accentCol = new THREE.Color(accent);

  // ── lights
  // soft cool moonlight; the warm light comes from lamps and candles in the room
  const key = new THREE.DirectionalLight(0xb9c6ff, 1.05);
  key.position.set(-4, 9, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -18; key.shadow.camera.right = 18; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14; key.shadow.camera.far = 60;
  key.shadow.radius = 6; key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.PointLight(accentCol, 26, 18, 1.6);
  rim.position.set(-3.5, 2.2, -4);
  scene.add(rim);
  const fill = new THREE.PointLight(accentCol, 7, 14, 2);
  fill.position.set(4, 1.2, 4);
  scene.add(fill);

  const root = new THREE.Group();
  scene.add(root);

  // ── plinth
  const wood = new THREE.MeshPhysicalMaterial({ color: 0x14151b, roughness: 0.38, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.25 });
  const plinth = new THREE.Mesh(new RoundedBoxGeometry(6.6, 0.55, 4.9, 6, 0.16), wood);
  plinth.position.set(0.5, -0.36, -0.05);
  plinth.receiveShadow = true; plinth.castShadow = true;
  root.add(plinth);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(6.3, 0.04, 4.6, 4, 0.1), new THREE.MeshStandardMaterial({ color: 0x1c1e26, roughness: 0.55, metalness: 0.6 }));
  plate.position.set(0.5, -0.07, -0.05);
  plate.receiveShadow = true;
  root.add(plate);

  // ── platter + vinyl
  const metal = new THREE.MeshStandardMaterial({ color: 0xb9bcc6, roughness: 0.28, metalness: 1 });
  const platter = new THREE.Group();
  root.add(platter);
  const platterBody = new THREE.Mesh(new THREE.CylinderGeometry(1.84, 1.84, 0.13, 128), metal);
  platterBody.position.y = 0.0; platterBody.castShadow = true; platterBody.receiveShadow = true;
  platter.add(platterBody);
  // strobe dots on the edge
  const dotMat = new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.4, metalness: 0.8 });
  const dotGeo = new THREE.BoxGeometry(0.05, 0.05, 0.02);
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2, d = new THREE.Mesh(dotGeo, dotMat);
    d.position.set(Math.cos(a) * 1.845, 0.0, Math.sin(a) * 1.845);
    d.rotation.y = -a + Math.PI / 2;
    platter.add(d);
  }
  const mat = new THREE.Mesh(new THREE.CylinderGeometry(1.74, 1.74, 0.012, 128), new THREE.MeshStandardMaterial({ color: 0x15161d, roughness: 0.95, metalness: 0 }));
  mat.position.y = 0.071; mat.receiveShadow = true;
  platter.add(mat);
  const vinylMat = new THREE.MeshPhysicalMaterial({ map: vinylTexture(accentCol, false), roughness: 0.42, metalness: 0.05, clearcoat: 0.55, clearcoatRoughness: 0.22 });
  const vinylSide = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.3 });
  const vinylMatB = vinylMat.clone();
  const vinyl = new THREE.Mesh(new THREE.CylinderGeometry(1.72, 1.72, 0.03, 160), [vinylSide, vinylMat, vinylMatB]);
  vinyl.position.y = 0.08; vinyl.castShadow = true; vinyl.receiveShadow = true;
  platter.add(vinyl); // moved to the room below
  const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 24), metal);
  spindle.position.y = 0.15;
  platter.add(spindle);

  // ── the room around the turntable
  const accentBits = [];
  const TOP = -0.64, FLOOR = -6.6, WALL = -4.4;
  const loader = new THREE.TextureLoader();
  const loadTex = (url) => { const t = loader.load(url); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const coverTex = tracks.map((tr) => loadTex(tr.cover));
  // room decoration (crate, CDs, shelf, ledge, prints): the tracks by default, or any covers (e.g. the queue) via setDecor
  const deco = [];
  let decoTex = coverTex.slice();
  const decoMat = (i, opts, plain) => {
    const m = new THREE.MeshStandardMaterial({ ...opts });
    deco.push({ m, i, plain }); paintDeco(deco[deco.length - 1]); return m;
  };
  function paintDeco(d) {
    const n = decoTex.length, use = n && (d.plain == null || d.i < n);
    d.m.map = use ? decoTex[d.i % n] : null;
    d.m.color.set(use ? 0xffffff : (d.plain || '#2b2b30'));
    d.m.needsUpdate = true;
  }
  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
    return t;
  }
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const planks = canvasTex(1024, 1024, (g, w, h) => {
    for (let y = 0; y < h; y += 128) {
      let x = -rnd() * 400;
      while (x < w) {
        const len = 300 + rnd() * 400, l = 16 + rnd() * 8;
        g.fillStyle = `hsl(22, 30%, ${l * 0.78}%)`; g.fillRect(x, y, len, 126);
        for (let i = 0; i < 14; i++) { g.strokeStyle = `rgba(0,0,0,${0.05 + rnd() * 0.08})`; g.beginPath(); const yy = y + rnd() * 126; g.moveTo(x, yy); g.bezierCurveTo(x + len * 0.3, yy + rnd() * 8 - 4, x + len * 0.7, yy + rnd() * 8 - 4, x + len, yy); g.stroke(); }
        g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x + len - 2, y, 2, 126);
        x += len;
      }
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, y + 126, w, 2);
    }
  }, [5, 5]);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: planks, roughness: 0.62, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; floor.receiveShadow = true;
  root.add(floor);
  const wallTex = canvasTex(512, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#08090f'); gr.addColorStop(1, '#100f17');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 8) { g.fillStyle = 'rgba(255,236,210,.014)'; g.fillRect(x, 0, 1, h); }
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.02})`; g.fillRect(rnd() * w, rnd() * h, 1, 1); }
  });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(80, 30), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 }));
  wall.position.set(0, FLOOR + 15, WALL); wall.receiveShadow = true;
  root.add(wall);

  // sideboard
  const oak = canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = '#3a2a1e'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) { g.strokeStyle = `rgba(${rnd() < 0.5 ? '20,12,6' : '90,64,40'},${0.1 + rnd() * 0.2})`; g.lineWidth = 1 + rnd() * 2; g.beginPath(); const y = rnd() * h; g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y + rnd() * 20 - 10, w * 0.7, y + rnd() * 20 - 10, w, y + rnd() * 10 - 5); g.stroke(); }
  });
  const oakMat = new THREE.MeshStandardMaterial({ map: oak, roughness: 0.55 });
  const board = new THREE.Mesh(new RoundedBoxGeometry(24, 0.35, 6.2, 4, 0.08), oakMat);
  board.position.set(0.5, TOP - 0.175, -0.9); board.castShadow = board.receiveShadow = true;
  root.add(board);
  const body = new THREE.Mesh(new THREE.BoxGeometry(23.4, 4.6, 5.8), new THREE.MeshStandardMaterial({ color: 0x14151c, roughness: 0.7 }));
  body.position.set(0.5, TOP - 0.35 - 2.3, -0.95); body.castShadow = body.receiveShadow = true;
  root.add(body);
  for (const x of [-7.3, 0.5, 8.3]) {
    const door = new THREE.Mesh(new RoundedBoxGeometry(7.6, 4.3, 0.08, 2, 0.03), new THREE.MeshStandardMaterial({ color: 0x1a1c25, roughness: 0.55, metalness: 0.1 }));
    door.position.set(x, TOP - 0.35 - 2.3, 1.97); root.add(door);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.3, metalness: 1 }));
    knob.position.set(x + 3.2, TOP - 1.6, 2.06); root.add(knob);
  }
  for (const x of [-10.6, 11.6]) for (const z of [-3.4, 1.6]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.07, 1.3, 12), oakMat);
    leg.position.set(x, FLOOR + 0.65, z); leg.castShadow = true; root.add(leg);
  }
  // LED strip under the board, in the accent colour
  const strip = new THREE.Mesh(new THREE.BoxGeometry(23, 0.04, 0.04), new THREE.MeshBasicMaterial({ color: accentCol }));
  strip.position.set(0.5, TOP - 0.38, 2.15); root.add(strip);
    const under = new THREE.PointLight(accentCol, 6, 9, 2); under.position.set(0.5, TOP - 1.2, 3.2); root.add(under);

  // record crate with sleeves
  const crate = new THREE.Group(); crate.position.set(7.4, TOP, 0.1); crate.rotation.y = -0.18; root.add(crate);
  const crateMat = new THREE.MeshStandardMaterial({ map: oak, color: 0xc8a27a, roughness: 0.6 });
  const side = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), crateMat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; crate.add(m); };
  side(4.0, 0.12, 3.0, 0, 0.06, 0); side(0.12, 1.6, 3.0, -1.94, 0.8, 0); side(0.12, 1.6, 3.0, 1.94, 0.8, 0); side(4.0, 1.1, 0.12, 0, 0.55, 1.44); side(4.0, 1.6, 0.12, 0, 0.8, -1.44);
  const sleeveSide = new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.8 });
  const plainCols = ['#c4472f', '#1f3b63', '#e3b23c', '#2b2b30', '#5c7c5a', '#8a3b6e', '#d9d2c3'];
  for (let i = 0; i < 16; i++) {
    const face = decoMat(i, { roughness: 0.7 }, plainCols[i % plainCols.length]);
    const s = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.6, 0.045), [sleeveSide, sleeveSide, sleeveSide, sleeveSide, face, sleeveSide]);
    const z = 1.2 - i * 0.15;
    s.position.set((rnd() - 0.5) * 0.08, 1.85, z);
    s.rotation.x = -0.28 + i * 0.012; s.rotation.z = (rnd() - 0.5) * 0.03;
    s.castShadow = s.receiveShadow = true; crate.add(s);
  }

  // speaker: walnut cabinet on short feet, recessed baffle, real drivers built from turned profiles
  const spk = new THREE.Group(); spk.position.set(-6.4, TOP, -1.2); spk.rotation.y = 0.22; root.add(spk);
  const LIFT = 0.14, FRONT = 1.2 + 0.05;
  const walnut = new THREE.MeshPhysicalMaterial({ map: oak, color: 0x8a6448, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.4 });
  const cab = new THREE.Mesh(new RoundedBoxGeometry(2.6, 4.2, 2.4, 5, 0.09), walnut);
  cab.position.y = LIFT + 2.1; cab.castShadow = cab.receiveShadow = true; spk.add(cab);
  const baffle = new THREE.Mesh(new RoundedBoxGeometry(2.36, 3.96, 0.12, 4, 0.04), new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.78 }));
  baffle.position.set(0, LIFT + 2.1, 1.2 - 0.01); baffle.receiveShadow = true; spk.add(baffle);
  const footMat = new THREE.MeshStandardMaterial({ color: 0x1c1d22, roughness: 0.35, metalness: 0.8 });
  for (const [x, z] of [[-1.05, -0.95], [1.05, -0.95], [-1.05, 0.95], [1.05, 0.95]]) {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.09, LIFT, 24), footMat); f.position.set(x, LIFT / 2, z); f.castShadow = true; spk.add(f);
  }
  const satin = new THREE.MeshStandardMaterial({ color: 0x2c2d33, roughness: 0.32, metalness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0d0d10, roughness: 0.55 });
  const paper = new THREE.MeshStandardMaterial({ color: 0x55575f, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x17181d, roughness: 0.3, metalness: 0.2 });
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x3a3b42, roughness: 0.45, metalness: 0.35 });
  const hole = new THREE.MeshBasicMaterial({ color: 0x050506 });
  // profile points: [radius, depth] (depth > 0 sticks out of the baffle)
  const lathe = (pts, mat, parent, segs = 72) => {
    const m = new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, d]) => new THREE.Vector2(r, d)), segs), mat);
    m.rotation.x = Math.PI / 2; m.castShadow = true; parent.add(m); return m;
  };
  const arc = (r0, r1, d0, h, n = 10) => Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * Math.PI; return [r0 + (r1 - r0) * (i / n), d0 + Math.sin(a) * h]; });
  function driver(R, y) {
    const g = new THREE.Group(); g.position.set(0, LIFT + y, FRONT); spk.add(g);
    lathe([[R * 0.9, -0.01], [R * 1.04, -0.01], [R * 1.05, 0.012], [R * 1.02, 0.03], [R * 0.95, 0.034], [R * 0.9, 0.022]], satin, g);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const sc = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.025, R * 0.025, 0.02, 12), capMat);
      sc.rotation.x = Math.PI / 2; sc.position.set(Math.cos(a) * R * 0.975, Math.sin(a) * R * 0.975, 0.04); g.add(sc);
    }
    const moving = new THREE.Group(); g.add(moving);
    lathe(arc(R * 0.9, R * 0.74, 0.012, R * 0.07, 14).reverse(), rubber, moving);
    const cone = Array.from({ length: 13 }, (_, i) => { const k = i / 12; return [R * (0.74 - 0.47 * k), 0.012 - R * 0.36 * Math.pow(k, 0.75)]; });
    lathe(cone, paper, moving);
    const cr = R * 0.27, ch = R * 0.09, cd = cone[12][1];
    lathe(Array.from({ length: 11 }, (_, i) => { const k = i / 10; return [cr * Math.cos(k * Math.PI / 2) + 0.0001, cd + ch * Math.sin(k * Math.PI / 2)]; }), capMat, moving);
    return moving;
  }
  const woofer = driver(0.86, 1.62);
  // tweeter: shallow waveguide, metal ring and a soft dome
  const tw = new THREE.Group(); tw.position.set(0, LIFT + 3.3, FRONT); spk.add(tw);
  lathe([[0.36, -0.01], [0.42, -0.01], [0.43, 0.014], [0.41, 0.026], [0.36, 0.024]], satin, tw);
  lathe(Array.from({ length: 11 }, (_, i) => { const k = i / 10; return [0.36 - 0.21 * k, 0.024 - 0.07 * Math.sin(k * Math.PI / 2)]; }), new THREE.MeshStandardMaterial({ color: 0x1a1b20, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }), tw);
  lathe([[0.15, -0.046], [0.152, -0.04], [0.14, -0.036], [0.13, -0.04]], satin, tw);
  lathe(Array.from({ length: 11 }, (_, i) => { const k = i / 10; return [0.125 * Math.cos(k * Math.PI / 2) + 0.0001, -0.046 + 0.075 * Math.sin(k * Math.PI / 2)]; }), domeMat, tw);
  // slot port and a small badge
  const port = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.2, 0.06, 3, 0.03), hole); port.position.set(0, LIFT + 0.42, FRONT - 0.035); spk.add(port);
  const portLip = new THREE.Mesh(new RoundedBoxGeometry(1.58, 0.28, 0.04, 3, 0.04), new THREE.MeshStandardMaterial({ color: 0x0f1014, roughness: 0.5 })); portLip.position.set(0, LIFT + 0.42, FRONT - 0.045); spk.add(portLip);
  const badge = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.07, 0.015, 2, 0.006), satin); badge.position.set(0, LIFT + 2.78, FRONT + 0.005); spk.add(badge);

  // CDs: a stack and a few standing
  const cds = new THREE.Group(); cds.position.set(-9.7, TOP, 1.3); cds.rotation.y = 0.35; root.add(cds);
  const jewel = new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35 });
  for (let i = 0; i < 9; i++) {
    const top = decoMat(i + 2, { roughness: 0.4 });
    const spine = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(rnd(), 0.5, 0.45), roughness: 0.5 });
    const cd = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.24), [spine, spine, top, jewel, spine, spine]);
    cd.position.set((rnd() - 0.5) * 0.12, 0.06 + i * 0.125, (rnd() - 0.5) * 0.1); cd.rotation.y = (rnd() - 0.5) * 0.18;
    cd.castShadow = cd.receiveShadow = true; cds.add(cd);
  }
  for (let i = 0; i < 3; i++) {
    const face = decoMat(i + 4, { roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x111218 });
    const cd = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.24, 0.12), [dark, dark, dark, dark, face, dark]);
    cd.position.set(1.95 + i * 0.16, 0.62, 0.45 - i * 0.12); cd.rotation.set(-0.05, -0.3, 0.04 * i);
    cd.castShadow = true; cds.add(cd);
  }
  // a loose disc
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.012, 64), new THREE.MeshStandardMaterial({ color: 0xd8dbe6, roughness: 0.15, metalness: 1 }));
  disc.position.set(-0.2, 0.01, 1.35); cds.add(disc);
  const discLabel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.014, 48), decoMat(0, { roughness: 0.5 }));
  discLabel.position.set(-0.2, 0.012, 1.35); cds.add(discLabel);

  // floor shelf full of records, with an amplifier on top
  const SHX = 17.6, SHZ = -1.4; // rotated, so it stays clear of the wall and the sideboard
  const shelf = new THREE.Group(); shelf.position.set(SHX, FLOOR, SHZ); shelf.rotation.y = -0.25; root.add(shelf);
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.6 });
  const plank = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), shelfMat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; shelf.add(m); };
  const CW = 3.7, SW = CW * 2 + 0.3 * 3, SH_H = CW * 2 + 0.3 * 3;
  for (let i = 0; i < 3; i++) { plank(SW, 0.3, 3.8, 0, 0.15 + i * (CW + 0.3), 0); plank(0.3, SH_H, 3.8, -SW / 2 + 0.15 + i * (CW + 0.3), SH_H / 2, 0); }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH_H), new THREE.MeshStandardMaterial({ color: 0x1b1d26, roughness: 0.9 })); back.position.set(0, SH_H / 2, -1.85); shelf.add(back);
  const spineCols = ['#c4472f', '#1f3b63', '#e3b23c', '#2b2b30', '#5c7c5a', '#8a3b6e', '#d9d2c3', '#3d6f8f', '#f0e6d2', '#6b4a3a'];
  for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) {
    const x0 = -SW / 2 + 0.3 + cx * (CW + 0.3), y0 = 0.3 + cy * (CW + 0.3);
    if (cx === 1 && cy === 1) {
      // one cube shows a record face out
      const f = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.4, 0.05), [sleeveSide, sleeveSide, sleeveSide, sleeveSide, decoMat(3, { roughness: 0.7 }), sleeveSide]);
      f.position.set(x0 + CW / 2, y0 + 1.72, -0.4); f.rotation.x = -0.12; f.castShadow = true; shelf.add(f);
      continue;
    }
    let x = x0 + 0.05;
    while (x < x0 + CW - 0.12) {
      const th = 0.05 + rnd() * 0.06, lean = x > x0 + CW - 0.9 && rnd() < 0.5 ? 0.18 : 0;
      const sp = new THREE.Mesh(new THREE.BoxGeometry(th, 3.45, 3.45), new THREE.MeshStandardMaterial({ color: spineCols[Math.floor(rnd() * spineCols.length)], roughness: 0.75 }));
      sp.position.set(x + th / 2, y0 + 1.73, 0); sp.rotation.z = -lean; sp.castShadow = true; shelf.add(sp);
      x += th + 0.008;
      if (lean) break;
    }
  }
  // amplifier with glowing VU meters
  const amp = new THREE.Mesh(new RoundedBoxGeometry(6.2, 1.35, 3.2, 3, 0.06), new THREE.MeshStandardMaterial({ color: 0xb9bcc6, roughness: 0.32, metalness: 1 }));
  amp.position.set(0, SH_H + 0.68, 0); amp.castShadow = amp.receiveShadow = true; shelf.add(amp);
  const vuTex = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#f3d9a4'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2a1d10'; g.lineWidth = 2;
    for (let i = 0; i <= 12; i++) { const a = -0.9 + (i / 12) * 1.8; g.beginPath(); g.moveTo(w / 2 + Math.sin(a) * 90, h - 8 - Math.cos(a) * 90); g.lineTo(w / 2 + Math.sin(a) * (i % 3 ? 100 : 108), h - 8 - Math.cos(a) * (i % 3 ? 100 : 108)); g.stroke(); }
    g.fillStyle = '#b3261e'; g.fillRect(w / 2 + 48, 12, 30, 6);
    g.fillStyle = '#2a1d10'; g.font = '600 18px sans-serif'; g.fillText('VU', w / 2 - 12, h - 30);
  });
  const needles = [];
  for (const x of [-1.6, 1.6]) {
    const vu = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshStandardMaterial({ map: vuTex, emissive: 0xffb45a, emissiveMap: vuTex, emissiveIntensity: 0.9 }));
    vu.position.set(x, SH_H + 0.72, 1.61); shelf.add(vu);
    const nd = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.62, 0.01), new THREE.MeshBasicMaterial({ color: 0x1a1208 }));
    nd.geometry.translate(0, 0.31, 0); nd.position.set(x, SH_H + 0.3, 1.62); shelf.add(nd); needles.push(nd);
  }
  for (const x of [-2.75, 2.75]) {
    const k = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.2, 32), metal); k.rotation.x = Math.PI / 2; k.position.set(x, SH_H + 0.68, 1.68); shelf.add(k);
  }

  // headphones hanging on a stand: the band rests on the saddle, yokes hold the cups, pads face inwards
  const phones = new THREE.Group(); phones.position.set(11.3, TOP, 0.8); phones.rotation.y = -0.9; root.add(phones);
  const black = new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.45, metalness: 0.3 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x24252c, roughness: 0.85 });
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.1, 48), black); foot.position.y = 0.05; foot.castShadow = foot.receiveShadow = true; phones.add(foot);
  phones.add(tube(new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(0, 2.9, 0), 0.055, metal));
  const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.7, 6, 16), black); saddle.rotation.z = Math.PI / 2; saddle.position.y = 2.93; phones.add(saddle);
  const BR = 0.98, BY = 3.0 + 0.09 - BR;
  const band = new THREE.Mesh(new THREE.TorusGeometry(BR, 0.075, 16, 64, Math.PI), black); band.position.y = BY; band.castShadow = true; phones.add(band);
  const cushion = new THREE.Mesh(new THREE.TorusGeometry(BR - 0.1, 0.06, 12, 48, Math.PI * 0.62), leather); cushion.rotation.z = Math.PI * 0.19; cushion.position.y = BY; phones.add(cushion);
  for (const x of [-1, 1]) {
    phones.add(tube(new THREE.Vector3(x * BR, BY + 0.02, 0), new THREE.Vector3(x * 1.06, BY - 0.42, 0), 0.04, metal));
    const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.035, 8, 32, Math.PI), metal); yoke.rotation.y = Math.PI / 2; yoke.rotation.z = 0; yoke.position.set(x * 1.06, BY - 0.92, 0); phones.add(yoke);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.26, 40), black); cup.rotation.z = (x * Math.PI) / 2; cup.position.set(x * 1.12, BY - 0.92, 0); cup.castShadow = true; phones.add(cup);
    const pad = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.11, 12, 32), leather); pad.rotation.y = Math.PI / 2; pad.position.set(x * 0.9, BY - 0.92, 0); pad.castShadow = true; phones.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.018, 8, 48), new THREE.MeshBasicMaterial({ color: accentCol })); ring.rotation.y = Math.PI / 2; ring.position.set(x * 1.255, BY - 0.92, 0); phones.add(ring); accentBits.push(ring);
  }

  // coffee mug and cassettes next to the deck
  const mug = new THREE.Group(); mug.position.set(-3.7, TOP, 1.6); root.add(mug);
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xece6dc, roughness: 0.35 });
  // closed lathe profile: thick rim, inner wall and a real bottom, so it reads as a mug from every angle
  const prof = [[0, 0], [0.34, 0], [0.37, 0.02], [0.385, 0.06], [0.42, 0.9], [0.423, 0.935], [0.412, 0.955], [0.395, 0.95], [0.38, 0.92], [0.355, 0.14], [0.33, 0.11], [0, 0.11]].map(([x, y]) => new THREE.Vector2(x, y));
  const cupM = new THREE.Mesh(new THREE.LatheGeometry(prof, 56), ceramic); cupM.castShadow = true; cupM.receiveShadow = true; mug.add(cupM);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.372, 40), new THREE.MeshPhysicalMaterial({ color: 0x2a1609, roughness: 0.12, clearcoat: 1 })); coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.8; mug.add(coffee);
  // the handle: a vertical C on the side, both ends sitting in the wall
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.055, 14, 32, Math.PI), ceramic); handle.position.set(0.4, 0.5, 0); handle.rotation.z = -Math.PI / 2; handle.castShadow = true; mug.add(handle);
  // steam: soft round wisps that rise and fade (no flat panels)
  const puff = canvasTex(64, 64, (g, w) => { const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.5, 'rgba(255,255,255,.35)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, w); });
  const steam = [];
  for (let i = 0; i < 6; i++) {
    const st = new THREE.Sprite(new THREE.SpriteMaterial({ map: puff, transparent: true, opacity: 0, depthWrite: false }));
    st.position.set(0, 1, 0); mug.add(st); steam.push(st);
  }
  const tapes = new THREE.Group(); tapes.position.set(-3.85, TOP, -2.4); tapes.rotation.y = 0.5; root.add(tapes);
  for (let i = 0; i < 4; i++) {
    const shell = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(rnd(), 0.35, 0.3 + rnd() * 0.3), roughness: 0.4 });
    const lbl = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.8 });
    const tp = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.84), [shell, shell, lbl, shell, shell, shell]);
    tp.position.set((rnd() - 0.5) * 0.1, 0.08 + i * 0.165, 0); tp.rotation.y = (rnd() - 0.5) * 0.3; tp.castShadow = true; tapes.add(tp);
  }

  // record ledge on the wall with three sleeves
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(12, 0.18, 0.7), oakMat); ledge.position.set(10.8, 3.8, WALL + 0.35); ledge.castShadow = true; root.add(ledge);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(12, 0.3, 0.06), oakMat); lip.position.set(10.8, 3.95, WALL + 0.68); root.add(lip);
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.4, 0.05), [sleeveSide, sleeveSide, sleeveSide, sleeveSide, decoMat(i * 2 + 1, { roughness: 0.7 }), sleeveSide]);
    f.position.set(7.0 + i * 3.8, 3.89 + 1.7, WALL + 0.32); f.rotation.x = -0.1; f.castShadow = true; root.add(f);
  }

  // neon sign in the accent colour
  const neonTex = canvasTex(1024, 320, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.font = 'italic 600 210px Fraunces, Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = '#fff'; g.shadowBlur = 24; g.fillStyle = '#fff'; g.fillText('streyn', w / 2, h / 2);
  });
  const neon = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.0), new THREE.MeshBasicMaterial({ map: neonTex, color: accentCol, transparent: true, depthWrite: false }));
  neon.position.set(-11, 8.2, WALL + 0.12); root.add(neon); accentBits.push(neon);
  const neonGlow = new THREE.PointLight(accentCol, 14, 10, 2); neonGlow.position.set(-11, 8.2, WALL + 1.6); root.add(neonGlow);

  // round rug
  const rugTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#1d1a24'; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); g.fill();
    for (let r = 40; r < w / 2; r += 34) { g.strokeStyle = `rgba(255,255,255,${0.03 + (r % 68 ? 0.03 : 0)})`; g.lineWidth = 10; g.beginPath(); g.arc(w / 2, h / 2, r, 0, Math.PI * 2); g.stroke(); }
    for (let i = 0; i < 20000; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.15})`; g.fillRect(rnd() * w, rnd() * h, 1, 1); }
  });
  const rug = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshStandardMaterial({ map: rugTex, transparent: true, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(2, FLOOR + 0.02, 8); rug.receiveShadow = true; root.add(rug);

  // dust floating in the light
  const DUST = 260, dustPos = new Float32Array(DUST * 3), dustSeed = [];
  for (let i = 0; i < DUST; i++) { dustSeed.push([-14 + rnd() * 30, FLOOR + rnd() * 16, -3 + rnd() * 10, rnd() * 6]); }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xffe6c4, size: 0.05, transparent: true, opacity: 0.55, depthWrite: false }));
  root.add(dust);

  // framed print on the wall
  const pframe = new THREE.Mesh(new THREE.BoxGeometry(5.2, 5.2, 0.15), new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.5 }));
  pframe.scale.set(0.82, 0.82, 1); pframe.position.set(-4.6, 5.3, WALL + 0.08); pframe.castShadow = true; root.add(pframe);
  const print = new THREE.Mesh(new THREE.PlaneGeometry(3.45, 3.45), decoMat(0, { roughness: 0.6 }));
  print.position.set(-4.6, 5.3, WALL + 0.17); root.add(print);
  const frame2 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 0.12), pframe.material);
  frame2.position.set(-8.1, 4.9, WALL + 0.07); root.add(frame2);
  const print2 = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 2.05), decoMat(5, { roughness: 0.6 }));
  print2.position.set(-8.1, 4.9, WALL + 0.14); root.add(print2);

  // warm lamp glow from the left
  const LX = -14.2, LZ = -2.4;
  const lamp = new THREE.PointLight(0xffa860, 46, 26, 1.5); lamp.position.set(LX, 4.2, LZ); root.add(lamp);
  const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, 1.3, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xf2dfc4, emissive: 0xffb36b, emissiveIntensity: 0.8, side: THREE.DoubleSide, roughness: 0.9 }));
  lampShade.position.set(LX, 4.6, LZ); root.add(lampShade);
  const lampPole = tube(new THREE.Vector3(LX, FLOOR, LZ), new THREE.Vector3(LX, 4.0, LZ), 0.05, metal); root.add(lampPole);
  const lampFoot = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.12, 40), black); lampFoot.position.set(LX, FLOOR + 0.06, LZ); lampFoot.castShadow = true; root.add(lampFoot);

  // ════ the cozy part of the room: window, candles, lights, plants, chair, books, the queue on a line ════
  const warmCol = new THREE.Color(0xffa45a);
  const glowTex = canvasTex(64, 64, (g, w) => { const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, w); });
  const glowSprite = (col, s, op = 1) => { const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending })); m.scale.set(s, s, 1); return m; };
  const flames = [];

  // window with a rainy night outside: city lights, a moon, drops running down the glass
  const WX = 1.2, WY = 5.6, WW = 6.4, WH = 4.6;
  const winMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float time;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        vec2 uv = vUv; vec2 a = vec2(${(WW / WH).toFixed(3)}, 1.0);
        // drops on the glass bend the view a little
        vec2 g = uv * vec2(26.0, 9.0); vec2 id = floor(g); float sp = 0.25 + h(id) * 0.5;
        vec2 f = fract(g) - 0.5; float drop = smoothstep(0.09, 0.0, length(vec2(f.x * 1.6, (fract(uv.y * 9.0 + time * sp * 0.6 + h(id)) - 0.5))));
        float trail = 0.0;
        vec2 bend = vec2(f.x, 0.0) * (drop * 0.06 + trail * 0.01);
        vec2 p = uv + bend;
        // sky
        vec3 c = mix(vec3(0.006, 0.008, 0.022), vec3(0.022, 0.028, 0.065), p.y);
        // moon behind thin clouds
        vec2 mp = (p - vec2(0.76, 0.78)) * a; float md = length(mp);
        c += vec3(0.85, 0.88, 1.0) * smoothstep(0.075, 0.068, md) * 0.9 + vec3(0.25, 0.3, 0.5) * exp(-md * 9.0) * 0.5;
        // far city: blurred lights
        for (int i = 0; i < 26; i++) { float fi = float(i); vec2 lp = vec2(h(vec2(fi, 1.0)), 0.08 + h(vec2(fi, 2.0)) * 0.28);
          float r = 0.012 + h(vec2(fi, 3.0)) * 0.03; vec3 lc = mix(vec3(1.0, 0.62, 0.28), vec3(0.55, 0.7, 1.0), step(0.7, h(vec2(fi, 4.0))));
          c += lc * smoothstep(r, r * 0.2, length((p - lp) * a)) * (0.35 + 0.25 * sin(time * (0.3 + h(vec2(fi, 5.0))) + fi)); }
        // near rooftops with a few lit windows
        float roof = 0.1 + 0.12 * step(0.5, h(vec2(floor(p.x * 7.0), 9.0))) + 0.05 * h(vec2(floor(p.x * 13.0), 4.0));
        if (p.y < roof) { c = vec3(0.008, 0.009, 0.016); vec2 wq = floor(p * vec2(60.0, 40.0)); c += vec3(1.0, 0.7, 0.35) * step(0.93, h(wq)) * 0.35; }
        // rain streaks outside
        float st = step(0.985, h(vec2(floor(p.x * 140.0), 1.0))) * smoothstep(0.0, 0.3, fract(p.y * 2.0 + time * 1.8 + h(vec2(floor(p.x * 140.0), 2.0))));
        c += vec3(0.25, 0.3, 0.42) * st * 0.08;
        c += vec3(0.6, 0.7, 0.9) * (drop * 0.12 + trail * 0.03);
        // a bit of fog on the glass towards the bottom
        c = mix(c, vec3(0.05, 0.06, 0.1), smoothstep(0.35, 0.0, uv.y) * 0.5);
        gl_FragColor = vec4(c * 1.25, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(WW, WH), winMat); glass.position.set(WX, WY, WALL + 0.03); root.add(glass);
  const frameMat = new THREE.MeshStandardMaterial({ map: oak, color: 0x6a4a34, roughness: 0.6 });
  const wbar = (w, h, x, y, d = 0.3) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat); m.position.set(x, y, WALL + d / 2); m.castShadow = m.receiveShadow = true; root.add(m); };
  wbar(WW + 0.6, 0.3, WX, WY + WH / 2 + 0.15); wbar(WW + 0.6, 0.3, WX, WY - WH / 2 - 0.15); wbar(0.3, WH, WX - WW / 2 - 0.15, WY); wbar(0.3, WH, WX + WW / 2 + 0.15, WY);
  wbar(0.12, WH, WX, WY, 0.16); wbar(WW, 0.12, WX, WY + WH / 6, 0.16);
  const sill = new THREE.Mesh(new RoundedBoxGeometry(WW + 1.2, 0.2, 1.0, 3, 0.05), frameMat); sill.position.set(WX, WY - WH / 2 - 0.35, WALL + 0.5); sill.castShadow = sill.receiveShadow = true; root.add(sill);
  const SILL = WY - WH / 2 - 0.25;
  // cool light from the window and a soft beam with dust in it
  const winLight = new THREE.PointLight(0x7f98ff, 10, 16, 1.8); winLight.position.set(WX, WY, WALL + 1.4); root.add(winLight);
  const beamTex = canvasTex(64, 256, (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); const sx = g.createLinearGradient(0, 0, w, 0); sx.addColorStop(0, 'rgba(0,0,0,1)'); sx.addColorStop(0.2, 'rgba(0,0,0,0)'); sx.addColorStop(0.8, 'rgba(0,0,0,0)'); sx.addColorStop(1, 'rgba(0,0,0,1)'); g.globalCompositeOperation = 'destination-out'; g.fillStyle = sx; g.fillRect(0, 0, w, h); });
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(WW * 0.9, 9), new THREE.MeshBasicMaterial({ map: beamTex, color: 0x6f86c8, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  beam.geometry.translate(0, -4.5, 0); beam.position.set(WX, WY + WH / 2 - 0.2, WALL + 0.2); beam.rotation.x = -0.62; root.add(beam);

  // candles: a few on a tray on the sideboard, two on the window sill; flames flicker, one warm light
  const wax = new THREE.MeshStandardMaterial({ color: 0xf1e3c8, roughness: 0.55, emissive: 0xff9a40, emissiveIntensity: 0.05 });
  const flameTex = canvasTex(64, 128, (g, w, h) => { const r = g.createRadialGradient(w / 2, h * 0.68, 2, w / 2, h * 0.6, h * 0.5); r.addColorStop(0, 'rgba(255,250,230,1)'); r.addColorStop(0.25, 'rgba(255,190,90,.95)'); r.addColorStop(0.6, 'rgba(255,110,30,.35)'); r.addColorStop(1, 'rgba(255,80,0,0)'); g.fillStyle = r; g.beginPath(); g.ellipse(w / 2, h * 0.62, w * 0.3, h * 0.42, 0, 0, Math.PI * 2); g.fill(); });
  function candle(parent, x, z, hgt, rad) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 1.02, hgt, 28), wax); c.position.set(x, hgt / 2, z); c.castShadow = true; parent.add(c);
    const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6), new THREE.MeshBasicMaterial({ color: 0x141010 })); wick.position.set(x, hgt + 0.04, z); parent.add(wick);
    const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); fl.position.set(x, hgt + 0.2, z); fl.scale.set(0.16, 0.34, 1); parent.add(fl);
    const halo = glowSprite(0xff9a45, 1.1, 0.35); halo.position.set(x, hgt + 0.2, z); parent.add(halo);
    flames.push({ fl, halo, s: rnd() * 10 });
  }
  const candles = new THREE.Group(); candles.position.set(4.75, TOP, -2.75); root.add(candles);
  const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.05, 40), new THREE.MeshStandardMaterial({ color: 0x8a6a3c, roughness: 0.3, metalness: 0.9 })); tray.position.y = 0.025; tray.receiveShadow = true; candles.add(tray);
  candle(candles, -0.25, 0.12, 1.3, 0.22); candle(candles, 0.3, -0.18, 0.85, 0.2); candle(candles, 0.22, 0.38, 0.5, 0.16);
  const sillC = new THREE.Group(); sillC.position.set(WX, SILL, WALL + 0.55); root.add(sillC);
  candle(sillC, -2.4, 0, 0.55, 0.16); candle(sillC, -2.0, 0.12, 0.35, 0.14);
  const candleLight = new THREE.PointLight(0xff9440, 7, 9, 1.8); candleLight.position.set(4.75, TOP + 1.9, -2.3); root.add(candleLight);

  // table lamp at the right end of the sideboard
  const tl = new THREE.Group(); tl.position.set(11.7, TOP, -3.2); root.add(tl);
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.3, metalness: 1 });
  const tlBase = new THREE.Mesh(new THREE.LatheGeometry([[0, 0], [0.55, 0], [0.55, 0.06], [0.38, 0.22], [0.12, 0.36], [0.08, 0.5], [0, 0.5]].map(([x, y]) => new THREE.Vector2(x, y)), 40), brass); tlBase.castShadow = true; tl.add(tlBase);
  tl.add(tube(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 2.0, 0), 0.04, brass));
  const tlShade = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.85, 0.95, 40, 1, true), new THREE.MeshStandardMaterial({ color: 0xe9d4b0, emissive: 0xffa458, emissiveIntensity: 0.75, side: THREE.DoubleSide, roughness: 0.9 })); tlShade.position.y = 2.25; tl.add(tlShade);
  const tlGlow = glowSprite(0xffb066, 3.2, 0.25); tlGlow.position.y = 2.1; tl.add(tlGlow);
  const tableLight = new THREE.PointLight(0xffa862, 16, 13, 1.6); tableLight.position.set(11.6, TOP + 2.0, -2.6); root.add(tableLight);

  // books with a little plant on top, at the back left of the sideboard
  const books = new THREE.Group(); books.position.set(-10.0, TOP, -2.7); books.rotation.y = 0.12; root.add(books);
  const bookCols = ['#6b2f2a', '#2c4a3e', '#c9b48a', '#273450', '#7a5a2e', '#3b2d3f'];
  let by = 0;
  for (let i = 0; i < 4; i++) {
    const bw = 1.9 - i * 0.12 + rnd() * 0.1, bh = 0.22 + rnd() * 0.1, bd = 1.35 - i * 0.05;
    const cover = new THREE.MeshStandardMaterial({ color: bookCols[i % bookCols.length], roughness: 0.75 }), pages = new THREE.MeshStandardMaterial({ color: 0xe9dfc9, roughness: 0.9 });
    const b = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 2, 0.02), [cover, cover, cover, cover, pages, cover]);
    b.position.set((rnd() - 0.5) * 0.12, by + bh / 2, 0); b.rotation.y = (rnd() - 0.5) * 0.2; b.castShadow = b.receiveShadow = true; books.add(b); by += bh;
  }
  // leaves: a cut-out leaf shape, slightly bent, on a stem
  const leafTex = canvasTex(64, 128, (g, w, h) => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(w / 2, h); g.bezierCurveTo(0, h * 0.7, w * 0.05, h * 0.2, w / 2, 0); g.bezierCurveTo(w * 0.95, h * 0.2, w, h * 0.7, w / 2, h); g.fill(); });
  const leafGeo = new THREE.PlaneGeometry(0.42, 0.9, 1, 6); leafGeo.translate(0, 0.45, 0);
  { const pa = leafGeo.attributes.position; for (let i = 0; i < pa.count; i++) { const y = pa.getY(i); pa.setZ(i, -y * y * 0.35); } leafGeo.computeVertexNormals(); }
  const leafMats = [0x2f5a32, 0x3c6e3a, 0x264a2c].map((c) => new THREE.MeshStandardMaterial({ color: c, alphaMap: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 }));
  const swaying = [];
  function plant(parent, x, y, z, size, n, potCol = 0xc4683f) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.scale.setScalar(size); parent.add(g);
    const pot = new THREE.Mesh(new THREE.LatheGeometry([[0, 0], [0.32, 0], [0.42, 0.62], [0.46, 0.66], [0.46, 0.72], [0.4, 0.72], [0.38, 0.66], [0, 0.66]].map(([a, b]) => new THREE.Vector2(a, b)), 32), new THREE.MeshStandardMaterial({ color: potCol, roughness: 0.8 })); pot.castShadow = pot.receiveShadow = true; g.add(pot);
    const soil = new THREE.Mesh(new THREE.CircleGeometry(0.39, 24), new THREE.MeshStandardMaterial({ color: 0x1d140d, roughness: 1 })); soil.rotation.x = -Math.PI / 2; soil.position.y = 0.66; g.add(soil);
    const leaves = new THREE.Group(); leaves.position.y = 0.66; g.add(leaves);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.6, tilt = 0.35 + rnd() * 0.75, len = 0.75 + rnd() * 0.6;
      const stem = new THREE.Group(); stem.rotation.set(0, a, 0); leaves.add(stem);
      const arm = new THREE.Group(); arm.rotation.x = tilt; stem.add(arm);
      arm.add(tube(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, len, 0), 0.015, leafMats[2]));
      const l = new THREE.Mesh(leafGeo, leafMats[i % 2]); l.position.y = len * 0.92; l.rotation.x = 0.3 + rnd() * 0.4; l.scale.setScalar(0.8 + rnd() * 0.6); l.castShadow = true; arm.add(l);
    }
    swaying.push({ g: leaves, s: rnd() * 6 });
    return g;
  }
  plant(books, 0.2, by, 0, 0.75, 9, 0xd8cfc0);
  plant(sillC, 2.3, 0, 0, 0.55, 7, 0x5b6f86);
  plant(root, -19.6, FLOOR, -3.0, 2.5, 14);
  plant(root, 25.4, FLOOR, -2.4, 2.2, 12, 0x2c2c30);

  // an armchair with a blanket and a cushion, turned towards the music
  const chair = new THREE.Group(); chair.position.set(-15.6, FLOOR, 4.2); chair.rotation.y = 0.75; root.add(chair);
  const velvet = new THREE.MeshStandardMaterial({ color: 0x5c2f25, roughness: 0.92 });
  const cpart = (w, h, d, x, y, z, r = 0.18, rx = 0) => { const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, r), velvet); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = m.receiveShadow = true; chair.add(m); return m; };
  cpart(3.4, 1.1, 3.1, 0, 1.15, 0); cpart(2.7, 0.5, 2.6, 0, 1.92, 0.2, 0.2); cpart(3.4, 2.6, 0.7, 0, 2.6, -1.2, 0.25, -0.12);
  cpart(0.62, 1.7, 3.1, -1.55, 2.0, 0, 0.22); cpart(0.62, 1.7, 3.1, 1.55, 2.0, 0, 0.22);
  for (const [x, z] of [[-1.4, -1.3], [1.4, -1.3], [-1.4, 1.3], [1.4, 1.3]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.05, 0.6, 10), new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.5 })); l.position.set(x, 0.3, z); chair.add(l); }
  const plaid = canvasTex(256, 256, (g, w) => { g.fillStyle = '#b9a27a'; g.fillRect(0, 0, w, w); for (let i = 0; i < w; i += 32) { g.fillStyle = 'rgba(90,40,30,.45)'; g.fillRect(i, 0, 10, w); g.fillRect(0, i, w, 10); g.fillStyle = 'rgba(40,50,60,.25)'; g.fillRect(i + 18, 0, 3, w); g.fillRect(0, i + 18, w, 3); } }, [2, 2]);
  // the blanket hangs over the right arm: a cloth that follows the arm and falls down both sides
  const blGeo = new THREE.PlaneGeometry(2.4, 3.2, 10, 32); { const pa = blGeo.attributes.position; for (let i = 0; i < pa.count; i++) { const u = pa.getY(i), v = pa.getX(i); let x, y; const a = Math.abs(u); if (a < 0.34) { x = u; y = 0.02 * Math.cos(u * 4); } else { x = Math.sign(u) * (0.34 + 0.02); y = -(a - 0.34); } pa.setXYZ(i, x + Math.sign(u) * Math.max(0, a - 0.34) * 0.08, y + Math.sin(v * 3) * 0.03, v); } blGeo.computeVertexNormals(); }
  const blanket = new THREE.Mesh(blGeo, new THREE.MeshStandardMaterial({ map: plaid, roughness: 0.95, side: THREE.DoubleSide })); blanket.position.set(1.55, 2.86, 0.1); blanket.castShadow = true; chair.add(blanket);
  const pillow = new THREE.Mesh(new RoundedBoxGeometry(1.2, 1.2, 0.42, 4, 0.2), new THREE.MeshStandardMaterial({ color: 0xc89a3c, roughness: 0.9 })); pillow.position.set(-0.6, 2.75, -0.7); pillow.rotation.set(-0.25, 0.25, 0.12); pillow.castShadow = true; chair.add(pillow);
  // a small side table with a book and a glass next to the chair
  const side2 = new THREE.Group(); side2.position.set(-12.0, FLOOR, 5.6); root.add(side2);
  const st = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 36), oakMat); st.position.y = 2.2; st.castShadow = st.receiveShadow = true; side2.add(st);
  side2.add(tube(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2.15, 0), 0.06, brass));
  const sfoot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.06, 30), brass); sfoot.position.y = 0.03; side2.add(sfoot);
  const openBook = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.7), new THREE.MeshStandardMaterial({ color: 0xece2cc, roughness: 0.9 })); openBook.position.set(-0.15, 2.3, 0.1); openBook.rotation.y = 0.4; openBook.castShadow = true; side2.add(openBook);
  candle(side2, 0.45, -0.3, 0.45, 0.15);

  // the queue on a line along the wall: polaroids of the next songs, fairy lights between them
  const LINE_A = new THREE.Vector3(-9.6, 10.6, WALL + 0.25), LINE_B = new THREE.Vector3(16.6, 10.6, WALL + 0.25);
  const linePt = (k) => new THREE.Vector3(lerp0(LINE_A.x, LINE_B.x, k), LINE_A.y - Math.sin(k * Math.PI) * 0.7, LINE_A.z);
  function lerp0(a, b, k) { return a + (b - a) * k; }
  const wire = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 24 }, (_, i) => linePt(i / 23))), 80, 0.012, 5), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 })); root.add(wire);
  const polaroids = [];
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xc9a47a, roughness: 0.7 }), pfMat = new THREE.MeshStandardMaterial({ color: 0xf1ede4, roughness: 0.85 });
  for (let i = 0; i < 9; i++) {
    const k = (i + 0.7) / 9.6, p = linePt(k);
    const g = new THREE.Group(); g.position.copy(p); root.add(g);
    const card = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.55, 0.02), pfMat); card.position.y = -0.82; card.castShadow = true; g.add(card);
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 1.12), decoMat(i + 3, { roughness: 0.55 })); photo.position.set(0, -0.72, 0.012); g.add(photo);
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.36, 0.08), pinMat); pin.position.y = -0.08; g.add(pin);
    g.rotation.z = (rnd() - 0.5) * 0.16;
    polaroids.push({ g, s: rnd() * 6, z: g.rotation.z });
  }
  // fairy lights: along the line and under the record ledge
  const bulbs = [];
  for (let i = 0; i < 46; i++) bulbs.push(linePt(i / 45).add(new THREE.Vector3(0, -0.06, 0.05)));
  for (let i = 0; i < 20; i++) { const k = i / 19; bulbs.push(new THREE.Vector3(5.0 + k * 11.6, 3.45 - Math.sin(k * Math.PI) * 0.35, WALL + 0.62)); }
  const NB = bulbs.length, bulbPos = new Float32Array(NB * 3), bulbCol = new Float32Array(NB * 3), bulbSeed = [];
  bulbs.forEach((b, i) => { bulbPos.set([b.x, b.y, b.z], i * 3); bulbSeed.push([rnd() * 6, 0.6 + rnd() * 1.6]); });
  const bulbGeo = new THREE.BufferGeometry(); bulbGeo.setAttribute('position', new THREE.BufferAttribute(bulbPos, 3)); bulbGeo.setAttribute('color', new THREE.BufferAttribute(bulbCol, 3));
  const bulbGlow = new THREE.Points(bulbGeo, new THREE.PointsMaterial({ map: glowTex, size: 0.55, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  root.add(bulbGlow);
  const bulbCore = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), NB);
  { const m4 = new THREE.Matrix4(); bulbs.forEach((b, i) => bulbCore.setMatrixAt(i, m4.makeTranslation(b.x, b.y, b.z))); } root.add(bulbCore);
  const fairyCol = new THREE.Color(0xffc27a);

  // a pouf on the rug and a second, darker rug under the chair
  const pouf = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.2, 1.1, 40), new THREE.MeshStandardMaterial({ color: 0x2f3a33, roughness: 0.95 })); pouf.position.set(-5.5, FLOOR + 0.55, 7.6); pouf.castShadow = pouf.receiveShadow = true; root.add(pouf);
  const rug2Tex = canvasTex(256, 256, (g, w) => { g.fillStyle = '#3a2620'; g.fillRect(0, 0, w, w); for (let i = 0; i < 6; i++) { g.strokeStyle = `rgba(230,190,140,${0.05 + (i % 2) * 0.05})`; g.lineWidth = 6; g.strokeRect(14 + i * 14, 14 + i * 14, w - 28 - i * 28, w - 28 - i * 28); } for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.2})`; g.fillRect(rnd() * w, rnd() * w, 1, 1); } });
  const rug2 = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshStandardMaterial({ map: rug2Tex, roughness: 1 })); rug2.rotation.set(-Math.PI / 2, 0, 0.75); rug2.position.set(-15.2, FLOOR + 0.015, 4.6); rug2.receiveShadow = true; root.add(rug2);

  function cozyFrame(t, eS) {
    winMat.uniforms.time.value = t;
    let fl = 0;
    flames.forEach((f, i) => { const k = 0.85 + Math.sin(t * 9 + f.s) * 0.06 + Math.sin(t * 23 + f.s * 2) * 0.04 + Math.sin(t * 2.3 + f.s) * 0.05; f.fl.scale.set(0.16 * (2 - k), 0.34 * k, 1); f.fl.material.rotation = Math.sin(t * 3 + f.s) * 0.08; f.halo.material.opacity = 0.28 + k * 0.1; if (i < 3) fl += k; });
    candleLight.intensity = 6.2 * (fl / 3) + Math.sin(t * 17) * 0.25;
    for (let i = 0; i < NB; i++) { const [s, sp] = bulbSeed[i]; const b = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(t * sp + s), 2) + eS * 0.25; bulbCol[i * 3] = fairyCol.r * b; bulbCol[i * 3 + 1] = fairyCol.g * b; bulbCol[i * 3 + 2] = fairyCol.b * b; }
    bulbGeo.attributes.color.needsUpdate = true;
    polaroids.forEach((p) => { p.g.rotation.z = p.z + Math.sin(t * 0.6 + p.s) * 0.025; });
    swaying.forEach((p) => { p.g.rotation.z = Math.sin(t * 0.4 + p.s) * 0.02; p.g.rotation.x = Math.sin(t * 0.31 + p.s) * 0.015; });
  }

  // ── tonearm
  const PIVOT = new THREE.Vector3(2.25, 0, -1.55);
  const NEEDLE_R = 1.58, NEEDLE_A = 0.42;
  const target = new THREE.Vector3(Math.cos(NEEDLE_A) * NEEDLE_R, 0, Math.sin(NEEDLE_A) * NEEDLE_R);
  const toT = new THREE.Vector3().subVectors(target, PIVOT);
  const L = Math.hypot(toT.x, toT.z);
  const PLAY_Y = Math.atan2(toT.x, toT.z);
  const REST_Y = PLAY_Y + 0.62;
  const INNER_Y = PLAY_Y - 0.3;

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.16, 48), new THREE.MeshStandardMaterial({ color: 0x23252d, roughness: 0.35, metalness: 0.9 }));
  base.position.set(PIVOT.x, -0.01, PIVOT.z); base.castShadow = true;
  root.add(base);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.42, 24), metal);
  post.position.set(PIVOT.x, 0.2, PIVOT.z); post.castShadow = true;
  root.add(post);
  // arm rest
  const restA = REST_Y;
  const restPos = new THREE.Vector3(PIVOT.x + Math.sin(restA) * (L * 0.62), 0, PIVOT.z + Math.cos(restA) * (L * 0.62));
  const restPost = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.36, 16), metal);
  restPost.position.set(restPos.x, 0.12, restPos.z); restPost.castShadow = true;
  root.add(restPost);

  const yaw = new THREE.Group();
  yaw.position.set(PIVOT.x, 0.4, PIVOT.z);
  root.add(yaw);
  const pitch = new THREE.Group();
  yaw.add(pitch);
  const armMat = new THREE.MeshStandardMaterial({ color: 0xd9dbe2, roughness: 0.2, metalness: 1 });
  pitch.add(tube(new THREE.Vector3(0, 0, -0.55), new THREE.Vector3(0, 0, 0.1), 0.045, armMat));
  pitch.add(tube(new THREE.Vector3(0, 0, 0.1), new THREE.Vector3(0, -0.12, L - 0.42), 0.04, armMat));
  const hinge = new THREE.Mesh(new THREE.SphereGeometry(0.11, 32, 16), new THREE.MeshStandardMaterial({ color: 0x2a2c34, roughness: 0.3, metalness: 0.9 }));
  pitch.add(hinge);
  const cw = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 40), new THREE.MeshStandardMaterial({ color: 0x1b1c22, roughness: 0.35, metalness: 0.9 }));
  cw.rotation.x = Math.PI / 2; cw.position.set(0, 0, -0.62); cw.castShadow = true;
  pitch.add(cw);
  const shell = new THREE.Group();
  shell.position.set(0, -0.15, L - 0.36);
  shell.rotation.y = -0.38;
  pitch.add(shell);
  const shellBody = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.05, 0.42, 3, 0.02), new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.4, metalness: 0.7 }));
  shellBody.castShadow = true;
  shell.add(shellBody);
  const cart = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.2), new THREE.MeshStandardMaterial({ color: accentCol, roughness: 0.35, metalness: 0.3 }));
  cart.position.set(0, -0.07, 0.06); cart.castShadow = true;
  shell.add(cart);
  const lift = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.02), metal);
  lift.position.set(0.11, 0.02, -0.12);
  shell.add(lift);

  // ── layout / camera
  let wide = true, W = 1, H = 1, mx = 0, my = 0, tx = 0, ty = 0, scrollT = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    wide = W / H > 1.15;
    if (wide && !center) camera.setViewOffset(W, H, -W * 0.2, 0, W, H); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  const onMove = (e) => { tx = (e.clientX / innerWidth) * 2 - 1; ty = (e.clientY / innerHeight) * 2 - 1; };
  const onScroll = () => { scrollT = Math.min(1, scrollY / innerHeight); };
  addEventListener('resize', resize);
  resize();
  addEventListener('pointermove', onMove, { passive: true });
  if (follow) addEventListener('scroll', onScroll, { passive: true });

  // ── records
  const covers = tracks.map(() => null);
  const texs = [];
  const texFor = (i) => texs[i] || vinylMat.map;
  tracks.forEach((tr, i) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      covers[i] = im; texs[i] = vinylTexture(accentTo, true, im);
      if (i === cur) { vinylMat.map = texs[i]; vinylMat.needsUpdate = true; }
    };
    im.src = tr.cover;
  });

  // ── the sleeve that carries records between crate and turntable
  crate.updateMatrixWorld(true);
  crate.children.filter((m) => m.geometry && m.geometry.parameters && m.geometry.parameters.width === 3.6)[0].visible = false;
  const slot = new THREE.Object3D(); slot.position.set(0, 1.85, 1.2); slot.rotation.x = -0.28; crate.add(slot); crate.updateMatrixWorld(true);
  const SLOT_P = slot.getWorldPosition(new THREE.Vector3()), SLOT_Q = slot.getWorldQuaternion(new THREE.Quaternion());
  const sleeveMat = new THREE.MeshStandardMaterial({ map: coverTex[0], roughness: 0.7 });
  const sleeveBack = new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.8 });
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(3.66, 3.66, 0.09), [sleeveBack, sleeveBack, sleeveBack, sleeveBack, sleeveMat, sleeveBack]);
  sleeve.castShadow = true; root.add(sleeve);
  const HOVER_P = new THREE.Vector3(5.0, 3.7, 1.4), HOVER_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.06, -0.42, 0.02));
  const SX = new THREE.Vector3(1, 0, 0).applyQuaternion(HOVER_Q);
  const SIDE_P = HOVER_P.clone().addScaledVector(SX, -3.95);
  const UP_Q = HOVER_Q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
  root.add(vinyl); // the record moves freely; it follows the platter while it plays
  const REC_P = new THREE.Vector3(0, 0.08, 0);
  const bez = (a, b, c, d, k) => { const u = 1 - k; return new THREE.Vector3().addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * k).addScaledVector(c, 3 * u * k * k).addScaledVector(d, k * k * k); };
  const sine = (k) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));
  function sleevePath(k) { // crate slot -> hover
    const e = sine(k);
    return [bez(SLOT_P, SLOT_P.clone().add(new THREE.Vector3(0, 4.2, 0)), HOVER_P.clone().add(new THREE.Vector3(1.2, 1.4, 0)), HOVER_P, e), SLOT_Q.clone().slerp(HOVER_Q, sine((k - 0.25) / 0.75))];
  }
  const qFlat = (a) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0));
  function recordPath(k, a) { // platter -> beside the sleeve
    const e = sine(k);
    return [bez(REC_P, REC_P.clone().add(new THREE.Vector3(0, 2.6, 0)), SIDE_P.clone().add(new THREE.Vector3(-0.6, 0.8, 0.3)), SIDE_P, e), qFlat(a).slerp(UP_Q, sine((k - 0.15) / 0.7))];
  }

  // ── camera moves. Each move travels from pose a to pose b while it is on screen.
  // pose: [azimuth, elevation, distance, target, roll, fov]
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const MV = {
    room: { a: [-0.42, 0.3, 30, [1.5, -1.5, -1], 0, 30] },
    wide: { a: [-0.55, 0.62, 12.9, [0.5, -0.35, 0], 0, 30] },
    deck: { a: [-0.55, 0.42, 19, [3.4, 1.0, 0], -0.02, 30], b: [-0.25, 0.32, 16.5, [3.6, 1.2, 0], 0.01, 30] },
    deck2: { a: [-0.1, 0.3, 16, [2.4, 0.6, 0], 0.02, 30], b: [-0.45, 0.4, 14, [1.2, 0.2, 0], -0.02, 30] },
    sleeve: { a: [-0.8, 0.26, 12, [3.6, 3.0, 1.0], 0.03, 30], b: [-0.25, 0.12, 9.5, [2.6, 2.6, 1.0], -0.02, 32] },
    needle: { a: [-0.6, 0.38, 3.9, [1.35, 0.1, 0.7], -0.04, 30], b: [0.15, 0.14, 2.7, [1.3, 0.05, 0.7], 0.05, 30] },
    label: { a: [-1.2, 0.62, 5.6, [0, 0.1, 0], 0.12, 30], b: [-0.1, 1.35, 3.6, [0, 0.1, 0], -0.08, 30] },
    low: { a: [1.25, 0.05, 9, [0.5, 0.05, 0], 0.04, 30], b: [0.2, 0.13, 7, [0.5, 0.1, 0], -0.03, 30] },
    top: { a: [-1.0, 1.46, 13, [0.4, 0, 0], 0, 30], b: [0.6, 1.49, 9, [0.4, 0, 0], 0, 30] },
    arm: { a: [-1.6, 0.26, 4.6, [2.0, 0.35, -1.0], 0.05, 30], b: [-0.7, 0.5, 3.1, [1.6, 0.3, -0.6], -0.05, 30] },
    crate: { a: [-0.6, 0.45, 11, [7.4, 1.4, 0.4], 0.03, 30], b: [0.15, 0.22, 7, [7.6, 1.7, 0.4], -0.02, 30] },
    shelf: { a: [-0.9, 0.12, 23, [17.4, -1.5, -1.4], -0.03, 30], b: [-0.3, 0.28, 17, [17.0, 0, -1.4], 0.03, 30] },
    amp: { a: [-0.6, 0.3, 13, [17.2, 2.3, -1.0], 0.04, 30], b: [0.05, 0.1, 9, [17.5, 2.4, -1.0], -0.03, 30] },
    phones: { a: [-1.0, 0.35, 10, [11.3, 1.3, 0.8], 0.05, 30], b: [0.3, 0.2, 7.5, [11.3, 1.4, 0.8], -0.04, 30] },
    cds: { a: [1.1, 0.45, 8, [-9.2, 0.2, 1.5], -0.04, 30], b: [0.25, 0.22, 5.4, [-9.2, 0.3, 1.5], 0.04, 30] },
    mug: { a: [0.6, 0.32, 9, [-3.8, 0.4, 1.0], 0.04, 30], b: [-0.3, 0.2, 6.8, [-3.9, 0.3, 0.6], -0.03, 30] },
    // dolly zoom: the camera pulls back while the lens zooms in
    speaker: { a: [0.55, 0.2, 7, [-6.4, 1.6, -1.0], 0, 44], b: [0.75, 0.22, 15, [-6.4, 1.6, -1.0], 0, 21] },
    wall: { a: [-0.5, 0.02, 17, [-1.0, 5.2, -4.0], 0.02, 30], b: [0.3, 0.12, 13, [1.0, 5.4, -4.0], -0.02, 30] },
    neon: { a: [0.6, 0.0, 10, [-10.5, 7.2, -4.2], -0.05, 30], b: [-0.15, -0.08, 7, [-11, 7.8, -4.2], 0.04, 30] },
    ledge: { a: [-0.5, 0.05, 12, [9.0, 5.4, -4.0], 0.04, 30], b: [0.4, -0.05, 9, [12.0, 5.6, -4.0], -0.03, 30] },
    // wide views of the whole room
    roomL: { a: [0.62, 0.2, 36, [-1, -0.8, -2], -0.02, 30], b: [0.42, 0.26, 32, [1, -0.6, -2], 0.01, 30] },
    roomR: { a: [-0.72, 0.16, 38, [6, -0.8, -2], 0.02, 30], b: [-0.5, 0.22, 34, [4, -0.6, -2], -0.01, 30] },
    floorWide: { a: [0.25, -0.02, 30, [2.5, -0.6, -2], 0, 32], b: [-0.2, 0.02, 27, [3.5, -0.4, -2], 0, 32] },
    pullback: { a: [-0.3, 0.42, 9, [0.5, 0.1, 0], 0, 30], b: [-0.18, 0.24, 34, [3, -0.8, -2], 0, 30] },
    high: { a: [-0.35, 0.95, 32, [3, -2.2, -2], 0.02, 30], b: [0.25, 0.85, 28, [2, -2, -2], -0.02, 30] },
    along: { a: [-1.32, 0.1, 22, [1, 0.2, -1], 0.02, 32], b: [-1.18, 0.18, 19, [2.5, 0.4, -1], -0.01, 32] },
    alongR: { a: [1.12, 0.14, 21, [-3, 0.6, -1], -0.02, 32], b: [0.98, 0.2, 18, [-4, 0.8, -1], 0.01, 32] },
    spk2: { a: [0.05, 0.1, 12, [-6.1, 1.6, 0], 0.03, 30], b: [0.45, 0.18, 9.5, [-6.15, 1.5, 0], -0.03, 30] },
    // fly along the sideboard from the neon sign to the record shelf
    fly: { path: [V(-20, 10, 13), V(-13, 4.2, 11), V(-7, 2.4, 10.5), V(-1, 3.4, 10.5), V(5, 4.2, 11), V(10.5, 2.8, 10), V(15, 1.6, 13), V(22, 4.0, 17)],
      look: [V(-11, 7.5, -4), V(-9.0, 0.4, 0.6), V(-6.4, 1.8, -1), V(0.5, 0.2, 0), V(7.4, 1.6, 0.4), V(11, 1.2, -0.2), V(17, 1.0, -2.4), V(17, 2.4, -2.4)], roll: [0.06, -0.06] },
    // high sweep over the whole board
    // the cozy corners
    window: { a: [-0.35, 0.04, 12, [1.2, 5.4, -4.4], 0.02, 30], b: [0.22, -0.03, 9, [1.2, 5.6, -4.4], -0.02, 30] },
    rain: { a: [0.12, 0.02, 4.4, [0.2, 6.2, -4.4], -0.02, 30], b: [-0.14, 0.06, 3.3, [2.0, 5.2, -4.4], 0.03, 30] },
    candles: { a: [-0.5, 0.25, 4.6, [4.75, 0.3, -2.75], 0.03, 32], b: [-0.18, 0.12, 3.3, [4.75, 0.4, -2.75], -0.03, 34] },
    sill: { a: [0.35, 0.1, 5.5, [0.4, 3.6, -3.9], 0.02, 30], b: [-0.2, 0.18, 4.2, [1.6, 3.7, -3.9], -0.02, 30] },
    queue: { a: [-0.1, 0.06, 13, [-3, 9.3, -4.4], 0.02, 30], b: [0.1, 0.0, 13, [10, 9.3, -4.4], -0.02, 30] },
    polaroid: { a: [-0.25, 0.04, 6.2, [3, 9.1, -4.4], 0.03, 30], b: [0.2, -0.02, 4.6, [6.5, 9.1, -4.4], -0.02, 30] },
    chair: { a: [0.95, 0.32, 13, [-15.4, -4.2, 4.2], 0.02, 30], b: [0.45, 0.22, 10, [-15.4, -4.0, 4.2], -0.02, 30] },
    plant: { a: [0.7, 0.12, 11, [-19.6, -3.2, -3.0], 0.02, 30], b: [-0.1, 0.05, 8, [-19.6, -2.8, -3.0], -0.03, 30] },
    lampF: { a: [0.55, -0.12, 9, [-14.2, 3.8, -2.4], -0.03, 32], b: [0.1, -0.2, 7, [-14.2, 4.2, -2.4], 0.03, 32] },
    tlamp: { a: [-0.55, 0.15, 8, [11.5, 1.3, -2.6], 0.03, 30], b: [-0.12, 0.05, 6.4, [11.5, 1.5, -2.6], -0.02, 30] },
    books: { a: [0.5, 0.3, 6.5, [-10.0, 0.6, -2.7], -0.03, 30], b: [0.12, 0.2, 5, [-10.0, 0.8, -2.7], 0.03, 30] },
    side: { a: [0.2, 0.35, 8, [-12.0, -4.0, 5.6], 0.03, 32], b: [-0.3, 0.25, 6.2, [-12.0, -4.1, 5.6], -0.02, 32] },
    // crane up from the floor to the window and the queue on the line
    crane: { path: [V(3, -5.2, 15), V(2.5, -1.5, 13), V(1.8, 3.5, 11.5), V(1.4, 8.6, 12)], look: [V(1.5, -4.5, 1), V(1.2, -0.4, 0), V(1.2, 4.8, -4.4), V(2.5, 9.3, -4.4)], roll: [0, 0] },
    // half a circle around the turntable
    orbit: { path: Array.from({ length: 7 }, (_, i) => { const a = -1.15 + (i / 6) * 2.1; return V(0.5 + Math.sin(a) * 7.5, 3.0 - Math.cos(i) * 0.4, Math.cos(a) * 7.5); }), look: Array.from({ length: 7 }, () => V(0.6, 0.1, 0)), roll: [0.03, -0.03] },
    // from the armchair over to the record player
    cozy: { path: [V(-14, -1.5, 13), V(-9, 0.5, 10), V(-3, 1.8, 8), V(2, 2.6, 7)], look: [V(-15.4, -4.2, 4.2), V(-10, -1, 1), V(-3, 0.3, 0), V(1, 0.2, 0)], roll: [-0.03, 0.02] },
    // along the line of polaroids
    line: { path: [V(-8, 8.2, 2), V(-1, 8.6, 1.5), V(6, 8.4, 1.5), V(14, 8.2, 2)], look: [V(-6, 9.3, -4.4), V(1, 9.2, -4.4), V(8, 9.2, -4.4), V(15.5, 9.3, -4.4)], roll: [0.02, -0.02] },
    sweep: { path: [V(-14, 13, 14), V(-4, 9, 12), V(6, 8, 11), V(15, 11, 12)], look: [V(-6, -0.5, -1), V(-1, -0.2, 0), V(4, 0.2, 0), V(10, 0, -1)], roll: [-0.03, 0.04] },
  };
  for (const k in MV) if (MV[k].path) { MV[k].pc = new THREE.CatmullRomCurve3(MV[k].path, false, 'centripetal'); MV[k].lc = new THREE.CatmullRomCurve3(MV[k].look, false, 'centripetal'); }
  // between record changes the camera wanders: a random shot each time, none of the last few again
  const REST = Object.keys(MV).filter((k) => !['room', 'wide', 'deck', 'deck2', 'sleeve'].includes(k));
  let restCur = null; const recent = [];
  function restAt(t, from, limit) {
    if (!restCur || t >= restCur[2] || t < restCur[1] || restCur[1] < from) {
      let k; do { k = REST[Math.floor(Math.random() * REST.length)]; } while (recent.includes(k));
      recent.push(k); if (recent.length > 8) recent.shift();
      let e = t + (MV[k].path ? 11 + Math.random() * 2.5 : 6.5 + Math.random() * 2.8);
      if (limit - e < 3.5) e = Math.max(e, limit);
      restCur = [k, t, e];
    }
    return restCur;
  }
  const T0 = 24, C = 46, CH = 24; // first change, cycle length, change duration
  const SP = manual ? 1.85 : 1; // in the app the next song waits for the change, so it runs faster
  // manual mode: a record change only runs when next() is called (the real song changed);
  // otherwise one change every C seconds. → { k: change number, r: time into it, base: its start }
  const chg = [];
  let pending = null;
  function cyc(t) {
    const n = tracks.length || 1;
    if (!manual) { const k = Math.floor((t - T0) / C); return { k, r: t - T0 - k * C, base: T0 + k * C, prev: ((k % n) + n) % n, next: (k + 1) % n }; }
    if (!chg.length) { const r = CH + t - 7.2; return { k: -1, r, base: t - r, prev: 0, next: 0 }; }
    const k = chg.length - 1, c = chg[k]; return { k, r: (t - c.s) * SP, base: c.s, prev: k ? chg[k - 1].to : 0, next: c.to };
  }
  // returns [move, start, end]
  function shotAt(t) {
    if (t < 9) return ['intro', 0, 9];
    if (t < 16.5) return ['needle', 9, 16.5];
    if (t < T0) return ['label', 16.5, T0];
    const { base, r: u } = cyc(t);
    if (u < 7) return ['deck', base, base + 7 / SP];
    if (u < 17.5) return ['sleeve', base + 7 / SP, base + 17.5 / SP];
    if (u < CH) return ['deck2', base + 17.5 / SP, base + CH / SP];
    return restAt(t, base + CH / SP, manual ? Infinity : base + C);
  }
  const lerp = (a, b, k) => a + (b - a) * k;
  const smooth = (k) => k * k * (3 - 2 * k);
  // pose → { p: position, l: look-at, r: roll, f: fov }
  function orbit(P, narrow) {
    const [az, el, d0, T, r = 0, f = 30] = P;
    const d = narrow ? d0 * 0.82 : d0;
    return { p: V(T[0] + Math.sin(az) * Math.cos(el) * d, T[1] + Math.sin(el) * d, T[2] + Math.cos(az) * Math.cos(el) * d), l: V(...T), r, f };
  }
  function poseAt(name, t, s, e) {
    const k = Math.min(1, Math.max(0, (t - s) / (e - s)));
    if (name === 'intro') {
      const r = MV.room.a, w = MV.wide.a, i = sine(t / 8.5);
      const P = [lerp(r[0], w[0], i) + Math.sin(i * Math.PI) * 0.35, lerp(r[1], w[1], i), lerp(r[2], wide ? w[2] : w[2] - 3, i), r[3].map((v, j) => lerp(v, w[3][j], i)), Math.sin(i * Math.PI) * -0.05, 30];
      return orbit(P, false);
    }
    const m = MV[name];
    if (m.path) {
      const q = smooth(k) * 0.7 + k * 0.3;
      return { p: m.pc.getPoint(q), l: m.lc.getPoint(q), r: lerp(m.roll[0], m.roll[1], smooth(k)), f: wide ? 30 : 38 };
    }
    if (!m.b) return orbit(m.a, !wide && name !== 'wide');
    const q = smooth(k), A = m.a, B = m.b;
    const P = [lerp(A[0], B[0], q), lerp(A[1], B[1], q), lerp(A[2], B[2], q), A[3].map((v, j) => lerp(v, B[3][j], q)), lerp(A[4], B[4], q), lerp(A[5], B[5], q)];
    return orbit(P, !wide);
  }
  // ── shot transitions: the old and the new shot are drawn into two images and mixed in one of many ways
  const TRN = [
    ['glide', 3.6], ['fade', 1.6], ['black', 1.9], ['warm', 1.9], ['wipe', 1.4], ['diagonal', 1.5], ['iris', 1.6], ['blinds', 1.5],
    ['burn', 1.9], ['zoom', 1.25], ['push', 1.15], ['pixels', 1.5], ['focus', 1.7], ['doors', 1.4], ['ripple', 1.7], ['whip', 0.85]
  ];
  const compMat = new THREE.ShaderMaterial({
    uniforms: { A: { value: null }, B: { value: null }, p: { value: 0 }, mode: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, warm: { value: new THREE.Color(0xffa860) }, acc: { value: accentCol } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform sampler2D A; uniform sampler2D B; uniform float p; uniform int mode; uniform vec2 res; uniform vec3 warm; uniform vec3 acc;
      float h21(vec2 q){ return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
      float nz(vec2 q){ vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      vec4 tA(vec2 u){ return texture2D(A, clamp(u, 0.0, 1.0)); }
      vec4 tB(vec2 u){ return texture2D(B, clamp(u, 0.0, 1.0)); }
      vec4 blurA(vec2 u, float r){ vec4 c = vec4(0.0); for (int i = 0; i < 16; i++) { float a = float(i) * 2.39996, rr = sqrt((float(i) + 0.5) / 16.0) * r; c += tA(u + vec2(cos(a), sin(a)) * rr * vec2(res.y / res.x, 1.0)); } return c / 16.0; }
      vec4 blurB(vec2 u, float r){ vec4 c = vec4(0.0); for (int i = 0; i < 16; i++) { float a = float(i) * 2.39996, rr = sqrt((float(i) + 0.5) / 16.0) * r; c += tB(u + vec2(cos(a), sin(a)) * rr * vec2(res.y / res.x, 1.0)); } return c / 16.0; }
      void main(){
        vec2 uv = vUv; float q = smoothstep(0.0, 1.0, p), asp = res.x / res.y, bell = sin(p * 3.14159);
        vec4 a = tA(uv), b = tB(uv), c = mix(a, b, q);
        if (mode == 2) c = p < 0.5 ? a * (1.0 - smoothstep(0.0, 0.5, p)) : b * smoothstep(0.5, 1.0, p);
        else if (mode == 3) { c = mix(a, b, smoothstep(0.3, 0.7, p)); c.rgb = c.rgb * (1.0 - bell * 0.2) + warm * bell * bell * (0.5 + 0.7 * uv.y); }
        else if (mode == 4) { float e = q * 1.4 - 0.2; c = mix(b, a, smoothstep(e - 0.15, e + 0.15, uv.x)); }
        else if (mode == 5) { float d = (uv.x * asp + (1.0 - uv.y)) / (asp + 1.0), e = q * 1.3 - 0.15; c = mix(b, a, smoothstep(e - 0.06, e + 0.06, d)); }
        else if (mode == 6) { float r = length((uv - 0.5) * vec2(asp, 1.0)), e = q * (0.5 * length(vec2(asp, 1.0)) + 0.1); c = mix(b, a, smoothstep(e - 0.05, e + 0.01, r)); c.rgb *= 1.0 - 0.5 * bell * smoothstep(0.08, 0.0, abs(r - e)); }
        else if (mode == 7) { float s = fract(uv.y * 8.0 + uv.x * 0.6); c = mix(a, b, smoothstep(s - 0.06, s + 0.06, q * 1.12 - 0.06)); }
        else if (mode == 8) { float n = nz(uv * vec2(asp, 1.0) * 5.0) * 0.65 + nz(uv * 28.0) * 0.35, e = q * 1.24 - 0.12; c = mix(b, a, smoothstep(e - 0.025, e + 0.025, n)); c.rgb += warm * smoothstep(0.035, 0.0, abs(n - e)) * 1.1 * bell; }
        else if (mode == 9) { vec2 d = uv - 0.5; vec4 za = vec4(0.0), zb = vec4(0.0); for (int i = 0; i < 10; i++) { float k = float(i) / 9.0; za += tA(0.5 + d / (1.0 + p * 1.6 + k * 0.12 * bell)); zb += tB(0.5 + d / (1.0 + (1.0 - p) * 0.7 + k * 0.08 * bell)); } c = mix(za, zb, q) / 10.0; }
        else if (mode == 10) { float o = q; c = uv.x < 1.0 - o ? tA(uv + vec2(o, 0.0)) : tB(uv - vec2(1.0 - o, 0.0)); c.rgb *= 1.0 - 0.35 * smoothstep(0.03, 0.0, abs(uv.x - (1.0 - o))) * bell; }
        else if (mode == 11) { float s = 1.0 + 64.0 * bell; vec2 g = (floor(uv * res / s) + 0.5) * s / res; c = mix(tA(g), tB(g), step(0.5, p)); }
        else if (mode == 12) { float r = bell * 0.03; c = mix(blurA(uv, r), blurB(uv, r), q); }
        else if (mode == 13) { float d = abs(uv.x - 0.5), e = q * 0.5; c = d < e ? b : tA(vec2(uv.x < 0.5 ? uv.x + e : uv.x - e, uv.y)); c.rgb *= 1.0 - 0.45 * smoothstep(0.02, 0.0, abs(d - e)) * bell; }
        else if (mode == 14) { float r = length((uv - 0.5) * vec2(asp, 1.0)); vec2 dd = normalize(uv - 0.5 + 1e-5) * sin(r * 38.0 - p * 18.0) * 0.014 * bell; c = mix(tA(uv + dd), tB(uv + dd), q); }
        else if (mode == 15) { float s = bell * 0.09; vec4 ca = vec4(0.0), cb = vec4(0.0); for (int i = 0; i < 12; i++) { float k = float(i) / 11.0 - 0.5; ca += tA(uv + vec2(k * s + q * 0.35, 0.0)); cb += tB(uv + vec2(k * s - (1.0 - q) * 0.35, 0.0)); } c = mix(ca, cb, smoothstep(0.35, 0.65, p)) / 12.0; }
        gl_FragColor = c;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false
  });
  const compScene = new THREE.Scene(), compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat));
  let rtA = null, rtB = null;
  const _sz = new THREE.Vector2();
  function targets() {
    renderer.getDrawingBufferSize(_sz);
    if (!rtA) { const o = { type: THREE.HalfFloatType, samples: 4 }; rtA = new THREE.WebGLRenderTarget(_sz.x, _sz.y, o); rtB = new THREE.WebGLRenderTarget(_sz.x, _sz.y, o); }
    else if (rtA.width !== _sz.x || rtA.height !== _sz.y) { rtA.setSize(_sz.x, _sz.y); rtB.setSize(_sz.x, _sz.y); }
    compMat.uniforms.res.value.copy(_sz);
  }
  let trn = null, lastTrn = -1;
  const testTr = new URLSearchParams(location.search).get('tr');
  function pickTransition() {
    if (reduced) return 1;
    let i; do { i = Math.floor(Math.random() * TRN.length); } while (i === lastTrn);
    lastTrn = i; return i;
  }

  let shotE = 9, shot = 'intro', shotS = 0, from = null, switchT = 0, lastP = null, glideT = 3.6;
  const _up = V(0, 1, 0), _f = V(), _rt = V();
  function aim(P) {
    _f.copy(P.l).sub(P.p).normalize(); _rt.crossVectors(_f, _up).normalize();
    camera.position.copy(P.p).addScaledVector(_rt, mx * 0.35).addScaledVector(_up, -my * 0.2);
    camera.up.set(0, 1, 0).applyAxisAngle(_f, P.r);
    camera.lookAt(P.l);
    if (Math.abs(camera.fov - P.f) > 0.01) { camera.fov = P.f; camera.updateProjectionMatrix(); }
  }

  // ── animation timeline (seconds)
  const T_SWING = [1.2, 5.2], T_DROP = [5.2, 7.2], T_SPIN = [6.2, 9.4];
  const RPM = (33.333 / 60) * Math.PI * 2;
  const clock = new THREE.Clock();
  let eS = 0, lastNow = performance.now();
  const accentTo = accentCol.clone(), _c = new THREE.Color();
  const accentMats = () => [rim, fill, cart.material, strip.material, under, neonGlow, ...accentBits.map((m) => m.material)];
  let angle = 0, energy = 0, raf = 0, visible = true, lastT = 0, cur = 0, shown = -1;
  const fixed = new URLSearchParams(location.search).get('tt'), testShot = new URLSearchParams(location.search).get('shot');
  const start = reduced ? -10 : 0;
  if (reduced) lastT = 10;

  let heard = -1, playOn = true, playK = 1, changing = false;
  function frame() {
    const t = fixed !== null ? +fixed : clock.getElapsedTime() - start;
    if (pending !== null && t >= T0) {
      const c = chg.length ? t - chg[chg.length - 1].s : Infinity;
      if (c * SP >= CH + 1.6) { chg.push({ s: t, to: pending }); pending = null; }
    }
    const now = performance.now(), rdt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
    // energy follows the music gently; colours fade over to the next record
    eS += (energy - eS) * (1 - Math.exp(-rdt * (energy > eS ? 7 : 2.5)));
    if (!accentCol.equals(accentTo)) {
      _c.copy(accentCol).lerp(accentTo, fixed !== null ? 1 : 1 - Math.exp(-rdt * 2.2));
      if (Math.abs(_c.r - accentTo.r) + Math.abs(_c.g - accentTo.g) + Math.abs(_c.b - accentTo.b) < 0.003) _c.copy(accentTo);
      accentCol.copy(_c); accentMats().forEach((m) => m.color.copy(_c));
    }
    changing = false;
    let armY, up, spin, idx = manual && reduced ? tracks.length - 1 : 0, now3 = idx;
    let recP = REC_P, recQ = null, recVis = true, slP = SLOT_P, slQ = SLOT_Q, slTex = 0;
    const playY = (since) => PLAY_Y + (INNER_Y - PLAY_Y) * 0.1 * Math.min(1, Math.max(0, since / 20));
    if (t < T0 || reduced || !tracks.length) {
      const swing = sine((t - T_SWING[0]) / (T_SWING[1] - T_SWING[0]));
      const drop = sine((t - T_DROP[0]) / (T_DROP[1] - T_DROP[0]));
      spin = sine((t - T_SPIN[0]) / (T_SPIN[1] - T_SPIN[0]));
      armY = REST_Y + (playY(t - T_DROP[1]) - REST_Y) * swing;
      up = swing < 1 ? 0.17 * sine(swing * 2.5) + 0.01 : 0.18 * (1 - drop);
    } else {
      // change: arm up and parked, old record back into its sleeve, sleeve into the crate,
      // next sleeve out, record out of it and onto the platter, needle down
      const { r, prev, next } = cyc(t);
      const ph = (a, b) => sine((r - a) / (b - a));
      const lastPlay = playY(C);
      if (r < CH) {
        changing = true;
        const raise = ph(0, 1.6), park = ph(1.6, 4.4), back = ph(19.6, 22), drop = ph(22, 23.8);
        armY = r < 19.6 ? lerp(r < 1.6 ? playY(C) : lastPlay, REST_Y, park) : lerp(REST_Y, PLAY_Y, back);
        up = r < 22 ? 0.18 * raise : 0.18 * (1 - drop);
        spin = r < 0.6 ? 1 : r < 4.2 ? 1 - ph(0.6, 4.2) : r < 22.6 ? 0 : 0;
        // sleeve A (current record) comes out of the crate
        if (r < 4.2) { slTex = prev; }
        else if (r < 7.2) { [slP, slQ] = sleevePath(ph(4.2, 7.2)); slTex = prev; }
        else if (r < 11.6) { slP = HOVER_P; slQ = HOVER_Q; slTex = prev; }
        else if (r < 14) { [slP, slQ] = sleevePath(1 - ph(11.6, 14)); slTex = prev; }
        else if (r < 16.4) { [slP, slQ] = sleevePath(ph(14, 16.4)); slTex = next; }
        else if (r < 19.6) { slP = HOVER_P; slQ = HOVER_Q; slTex = next; }
        else if (r < 22) { [slP, slQ] = sleevePath(1 - ph(19.6, 22)); slTex = next; }
        else slTex = next;
        // the record
        const frozen = -angle;
        if (r < 6.4) { recP = REC_P; recQ = qFlat(frozen); }
        else if (r < 9.6) { [recP, recQ] = recordPath(ph(6.4, 9.6), frozen); }
        else if (r < 11.6) { recP = SIDE_P.clone().lerp(HOVER_P, ph(9.6, 11.6)); recQ = UP_Q; recVis = r < 11.5; }
        else if (r < 16.4) { recVis = false; }
        else if (r < 18) { recP = HOVER_P.clone().lerp(SIDE_P, ph(16.4, 18)); recQ = UP_Q; }
        else if (r < 21) { [recP, recQ] = recordPath(1 - ph(18, 21), frozen); }
        else { recP = REC_P; recQ = qFlat(frozen); }
        if (r > 22.4) { spin = ph(22.4, 25.4); recQ = null; }
        idx = r < 16.4 ? prev : next;
        now3 = prev;
      } else {
        armY = playY(r - CH);
        up = 0;
        spin = r < 25.4 ? ph(22.4, 25.4) : 1;
        slTex = next; idx = next; now3 = next;
      }
    }
    // the song is "on" once its record is down and spinning
    if (now3 !== heard) { heard = now3; if (tracks.length) onTrack(now3); }
    if (idx !== cur || shown < 0) {
      cur = idx; shown = idx;
      vinylMat.map = texFor(idx); vinylMat.needsUpdate = true;
    }
    if (sleeveMat.map !== coverTex[slTex]) { sleeveMat.map = coverTex[slTex]; sleeveMat.needsUpdate = true; }
    sleeve.position.copy(slP); sleeve.quaternion.copy(slQ);
    yaw.rotation.y = armY;
    pitch.rotation.x = -up + (up < 0.01 ? Math.sin(t * 9) * 0.0012 : 0);
    const dt = Math.min(0.05, Math.max(0, t - lastT)); lastT = t;
    playK += ((playOn ? 1 : 0) - playK) * (1 - Math.exp(-dt * 1.6));
    angle += RPM * spin * (changing ? 1 : playK) * dt;
    platter.rotation.y = -angle;
    vinyl.visible = recVis;
    vinyl.position.copy(recP);
    if (recQ) vinyl.quaternion.copy(recQ); else vinyl.quaternion.copy(qFlat(-angle));
    for (let i = 0; i < DUST; i++) { const d = dustSeed[i]; dustPos[i * 3] = d[0] + Math.sin(t * 0.07 + d[3]) * 0.8; dustPos[i * 3 + 1] = d[1] + Math.sin(t * 0.05 + d[3] * 2) * 0.6; dustPos[i * 3 + 2] = d[2] + Math.cos(t * 0.06 + d[3]) * 0.5; }
    dustGeo.attributes.position.needsUpdate = true;
    steam.forEach((st, i) => { const k = ((t * 0.18 + i / steam.length) % 1); st.position.set(Math.sin(t * 0.9 + i * 2.1) * 0.08 * k, 0.95 + k * 1.1, Math.cos(t * 0.7 + i) * 0.06 * k); st.material.opacity = Math.sin(k * Math.PI) * 0.09; const sc = 0.25 + k * 0.55; st.scale.set(sc, sc * 1.3, 1); });
    needles.forEach((n, i) => { n.rotation.z = -0.8 + Math.min(1.5, eS * 2.4 + 0.15 + Math.sin(t * (7 + i * 3)) * 0.06 * (spin > 0.5 ? 1 : 0)) * spin; });
    neon.material.opacity = 0.92 + Math.sin(t * 31) * 0.02 - Math.max(0, Math.sin(t * 1.7) - 0.99) * 30;
    woofer.position.z = eS * 0.03;
    cozyFrame(t, eS);

    // camera
    let cur3 = testShot ? [testShot, 0, 1] : scrollT > 0.05 ? ['wide', t, t + 1] : shotAt(t);
    if (cur3[0] !== shot || (cur3[1] !== shotS && shot !== 'wide')) {
      const m = cur3[0] === 'wide' || shot === 'wide' || !lastP ? 0 : pickTransition();
      if (m === 0) { from = lastP; switchT = t; glideT = shot === 'wide' || cur3[0] === 'wide' ? 5 : TRN[0][1]; trn = null; }
      else { from = null; trn = { m, t0: t, d: TRN[m][1], name: shot, s: shotS, e: shotE }; }
      shot = cur3[0]; shotS = cur3[1]; shotE = cur3[2];
    }
    let P = poseAt(cur3[0], t, cur3[1], cur3[2]);
    if (shot === 'wide') { const o = orbit([MV.wide.a[0] + scrollT * 0.3, MV.wide.a[1] - scrollT * 0.1, wide ? MV.wide.a[2] : 9.9, MV.wide.a[3]], false); P = o; }
    const bk = Math.min(1, Math.max(0, (t - switchT) / glideT)), blend = from ? bk * bk * bk * (bk * (bk * 6 - 15) + 10) : 1;
    if (from && blend < 1) {
      // travel on an arc between the two moves instead of a straight line
      const dist = from.p.distanceTo(P.p);
      const p = from.p.clone().lerp(P.p, blend); p.y += Math.sin(blend * Math.PI) * Math.min(4, dist * 0.12);
      P = { p, l: from.l.clone().lerp(P.l, blend), r: lerp(from.r, P.r, blend), f: lerp(from.f, P.f, blend) };
    }
    lastP = P;
    mx += (tx - mx) * 0.02; my += (ty - my) * 0.02;
    rim.intensity = 26 + eS * 90;
    fill.intensity = 7 + eS * 28;
    if (testTr !== null && testShot) trn = { m: +testTr, t0: t - (+new URLSearchParams(location.search).get('trp') || 0.5) * TRN[+testTr][1], d: TRN[+testTr][1], name: new URLSearchParams(location.search).get('from') || 'roomL', s: 0, e: 1 };
    if (trn && t - trn.t0 < trn.d && t >= trn.t0) {
      // both shots keep moving while one turns into the other
      targets();
      aim(poseAt(trn.name, t, trn.s, trn.e)); renderer.setRenderTarget(rtA); renderer.render(scene, camera);
      aim(P); renderer.setRenderTarget(rtB); renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      compMat.uniforms.A.value = rtA.texture; compMat.uniforms.B.value = rtB.texture;
      compMat.uniforms.p.value = (t - trn.t0) / trn.d; compMat.uniforms.mode.value = trn.m;
      renderer.render(compScene, compCam);
    } else {
      trn = null;
      aim(P); renderer.render(scene, camera);
    }
    raf = visible ? requestAnimationFrame(frame) : 0;
  }
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  });
  io.observe(canvas);
  raf = requestAnimationFrame(frame);

  const names = { crate, phones, cds, spk, tapes, mug, books, candles, tl, shelf, chair, side2, pouf, plinth };
  for (const k in names) names[k].name = k;
  const api = {
    scene,
    setAccent(hex) { accentTo.set(hex); },
    setEnergy(v) { energy = v; },
    // paused music: the record slows down and stands still, like a real one
    setPlaying(on) { playOn = !!on; },
    // swap the record (label and sleeve) for another cover, e.g. the song that plays now
    setCover(url, i = 0) {
      if (!url || !tracks[i] || tracks[i].cover === url) return;
      tracks[i].cover = url;
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; coverTex[i] = t; });
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => { covers[i] = im; texs[i] = vinylTexture(accentTo, true, im); if (cur === i) { vinylMat.map = texs[i]; vinylMat.needsUpdate = true; } };
      im.src = url;
    },
    // manual mode: the song changed → put the new record on with the full change animation
    // (waits for a running change to finish; only the newest pending song is played)
    next(url) {
      if (!url) return;
      const i = tracks.length;
      tracks.push({ cover: url });
      coverTex[i] = loadTex(url);
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => { covers[i] = im; texs[i] = vinylTexture(accentTo, true, im); if (cur === i) { vinylMat.map = texs[i]; vinylMat.needsUpdate = true; } };
      im.src = url;
      if (!reduced) pending = i;
      return i;
    },
    // the covers the room is decorated with (crate, CDs, shelf, wall), e.g. the upcoming songs
    setDecor(urls) {
      const list = (urls || []).filter(Boolean);
      if (list.join('|') === (decoTex.urls || []).join('|')) return;
      const old = new Map((decoTex.urls || []).map((u, i) => [u, decoTex[i]]));
      decoTex = list.length ? list.map((u) => old.get(u) || loadTex(u)) : coverTex.slice();
      decoTex.urls = list;
      deco.forEach(paintDeco);
    },
    dispose() {
      cancelAnimationFrame(raf); raf = 0; visible = false; io.disconnect();
      removeEventListener('resize', resize); removeEventListener('pointermove', onMove); removeEventListener('scroll', onScroll);
      rtA?.dispose(); rtB?.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    }
  };
  if (decor) api.setDecor(decor);
  return api;
}
