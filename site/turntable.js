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
  g.fillText('Musik', 0, -lr * 0.32);
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

export function createTurntable(canvas, { accent = '#4c8dff', reduced = false, tracks = [], onTrack = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.4;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  const accentCol = new THREE.Color(accent);

  // ── lights
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(-4, 9, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -18; key.shadow.camera.right = 18; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14; key.shadow.camera.far = 60;
  key.shadow.radius = 6; key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.PointLight(accentCol, 40, 18, 1.6);
  rim.position.set(-3.5, 2.2, -4);
  scene.add(rim);
  const fill = new THREE.PointLight(accentCol, 12, 14, 2);
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
  const coverTex = tracks.map((tr) => { const t = loader.load(tr.cover); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; });
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
        g.fillStyle = `hsl(24, 28%, ${l}%)`; g.fillRect(x, y, len, 126);
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
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#0d0f18'); gr.addColorStop(1, '#151826');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.025})`; g.fillRect(rnd() * w, rnd() * h, 1, 1); }
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
  const crate = new THREE.Group(); crate.position.set(7.6, TOP, 0.1); crate.rotation.y = -0.18; root.add(crate);
  const crateMat = new THREE.MeshStandardMaterial({ map: oak, color: 0xc8a27a, roughness: 0.6 });
  const side = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), crateMat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; crate.add(m); };
  side(4.0, 0.12, 3.0, 0, 0.06, 0); side(0.12, 1.6, 3.0, -1.94, 0.8, 0); side(0.12, 1.6, 3.0, 1.94, 0.8, 0); side(4.0, 1.1, 0.12, 0, 0.55, 1.44); side(4.0, 1.6, 0.12, 0, 0.8, -1.44);
  const sleeveSide = new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.8 });
  const plainCols = ['#c4472f', '#1f3b63', '#e3b23c', '#2b2b30', '#5c7c5a', '#8a3b6e', '#d9d2c3'];
  for (let i = 0; i < 16; i++) {
    const ci = i % (tracks.length + plainCols.length);
    const face = ci < tracks.length ? new THREE.MeshStandardMaterial({ map: coverTex[ci], roughness: 0.7 }) : new THREE.MeshStandardMaterial({ color: plainCols[ci - tracks.length], roughness: 0.75 });
    const s = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.6, 0.045), [sleeveSide, sleeveSide, sleeveSide, sleeveSide, face, sleeveSide]);
    const z = 1.2 - i * 0.15;
    s.position.set((rnd() - 0.5) * 0.08, 1.85, z);
    s.rotation.x = -0.28 + i * 0.012; s.rotation.z = (rnd() - 0.5) * 0.03;
    s.castShadow = s.receiveShadow = true; crate.add(s);
  }

  // speaker
  const spk = new THREE.Group(); spk.position.set(-6.4, TOP, -1.2); spk.rotation.y = 0.22; root.add(spk);
  const cab = new THREE.Mesh(new RoundedBoxGeometry(2.6, 4.2, 2.4, 4, 0.06), new THREE.MeshStandardMaterial({ map: oak, color: 0x9a7656, roughness: 0.5 }));
  cab.position.y = 2.1; cab.castShadow = cab.receiveShadow = true; spk.add(cab);
  const baffle = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 3.9), new THREE.MeshStandardMaterial({ color: 0x101117, roughness: 0.9 }));
  baffle.position.set(0, 2.1, 1.205); spk.add(baffle);
  const cone = (r, y) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.08, 12, 48), new THREE.MeshStandardMaterial({ color: 0x2a2b33, roughness: 0.4, metalness: 0.6 }));
    ring.position.set(0, y, 1.22); spk.add(ring);
    const c = new THREE.Mesh(new THREE.ConeGeometry(r * 0.95, r * 0.5, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x1a1b22, roughness: 0.8, side: THREE.DoubleSide }));
    c.rotation.x = -Math.PI / 2; c.position.set(0, y, 1.0); spk.add(c);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x30323b, roughness: 0.3, metalness: 0.5 }));
    cap.rotation.x = Math.PI / 2; cap.position.set(0, y, 1.0); spk.add(cap);
    return c;
  };
  const woofer = cone(0.85, 1.35); cone(0.32, 3.25);

  // CDs: a stack and a few standing
  const cds = new THREE.Group(); cds.position.set(-9.4, TOP, 0.9); cds.rotation.y = 0.35; root.add(cds);
  const jewel = new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35 });
  for (let i = 0; i < 9; i++) {
    const ci = i % tracks.length;
    const top = new THREE.MeshStandardMaterial({ map: coverTex[(ci + 2) % tracks.length], roughness: 0.4 });
    const spine = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(rnd(), 0.5, 0.45), roughness: 0.5 });
    const cd = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.24), [spine, spine, top, jewel, spine, spine]);
    cd.position.set((rnd() - 0.5) * 0.12, 0.06 + i * 0.125, (rnd() - 0.5) * 0.1); cd.rotation.y = (rnd() - 0.5) * 0.18;
    cd.castShadow = cd.receiveShadow = true; cds.add(cd);
  }
  for (let i = 0; i < 3; i++) {
    const face = new THREE.MeshStandardMaterial({ map: coverTex[(i + 4) % tracks.length], roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x111218 });
    const cd = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.24, 0.12), [dark, dark, dark, dark, face, dark]);
    cd.position.set(1.7 + i * 0.16, 0.62, -0.2 - i * 0.15); cd.rotation.set(-0.05, -0.3, 0.04 * i);
    cd.castShadow = true; cds.add(cd);
  }
  // a loose disc
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.012, 64), new THREE.MeshStandardMaterial({ color: 0xd8dbe6, roughness: 0.15, metalness: 1 }));
  disc.position.set(1.0, 0.01, 1.3); cds.add(disc);
  const discLabel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.014, 48), new THREE.MeshStandardMaterial({ map: coverTex[0], roughness: 0.5 }));
  discLabel.position.set(1.0, 0.012, 1.3); cds.add(discLabel);

  // floor shelf full of records, with an amplifier on top
  const SHX = 17.2, SHZ = -2.4;
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
      const f = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.4, 0.05), [sleeveSide, sleeveSide, sleeveSide, sleeveSide, new THREE.MeshStandardMaterial({ map: coverTex[3 % tracks.length], roughness: 0.7 }), sleeveSide]);
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

  // headphones on a stand
  const phones = new THREE.Group(); phones.position.set(11.0, TOP, -0.2); phones.rotation.y = -0.5; root.add(phones);
  const black = new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.45, metalness: 0.3 });
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 0.12, 48), black); foot.position.y = 0.06; foot.castShadow = true; phones.add(foot);
  phones.add(tube(new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(0, 3.0, 0), 0.07, metal));
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.11, 16, 48, Math.PI), black); band.position.y = 2.15; band.castShadow = true; phones.add(band);
  for (const x of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.38, 40), black); cup.rotation.z = Math.PI / 2; cup.position.set(x * 1.0, 1.75, 0); cup.castShadow = true; phones.add(cup);
    const pad = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.13, 12, 32), new THREE.MeshStandardMaterial({ color: 0x2a2b33, roughness: 0.9 })); pad.rotation.y = Math.PI / 2; pad.position.set(x * 0.8, 1.75, 0); phones.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.025, 8, 48), new THREE.MeshBasicMaterial({ color: accentCol })); ring.rotation.y = Math.PI / 2; ring.position.set(x * 1.2, 1.75, 0); phones.add(ring); accentBits.push(ring);
  }

  // coffee mug and cassettes next to the deck
  const mug = new THREE.Group(); mug.position.set(-3.7, TOP, 1.6); root.add(mug);
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xece6dc, roughness: 0.35 });
  const cupM = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.38, 0.95, 40, 1, true), ceramic); cupM.position.y = 0.48; cupM.castShadow = true; mug.add(cupM);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.4, 32), new THREE.MeshStandardMaterial({ color: 0x2a1609, roughness: 0.15 })); coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.82; mug.add(coffee);
  const mugBase = new THREE.Mesh(new THREE.CircleGeometry(0.38, 32), ceramic); mugBase.rotation.x = -Math.PI / 2; mugBase.position.y = 0.01; mug.add(mugBase);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 10, 24, Math.PI * 1.3), ceramic); handle.position.set(0.44, 0.5, 0); handle.rotation.z = -Math.PI * 0.65; mug.add(handle);
  const steam = [];
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 1.2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
    st.position.set((i - 1) * 0.12, 1.5, 0); mug.add(st); steam.push(st);
  }
  const tapes = new THREE.Group(); tapes.position.set(-4.2, TOP, -1.6); tapes.rotation.y = 0.5; root.add(tapes);
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
    const f = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.4, 0.05), [sleeveSide, sleeveSide, sleeveSide, sleeveSide, new THREE.MeshStandardMaterial({ map: coverTex[(i * 2 + 1) % tracks.length], roughness: 0.7 }), sleeveSide]);
    f.position.set(7.0 + i * 3.8, 3.89 + 1.7, WALL + 0.32); f.rotation.x = -0.1; f.castShadow = true; root.add(f);
  }

  // neon sign in the accent colour
  const neonTex = canvasTex(1024, 320, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.font = 'italic 600 210px Fraunces, Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = '#fff'; g.shadowBlur = 24; g.fillStyle = '#fff'; g.fillText('musik', w / 2, h / 2);
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
  pframe.position.set(2.0, 5.6, WALL + 0.08); pframe.castShadow = true; root.add(pframe);
  const print = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), new THREE.MeshStandardMaterial({ map: coverTex[0], roughness: 0.6 }));
  print.position.set(2.0, 5.6, WALL + 0.17); root.add(print);
  const frame2 = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 0.12), pframe.material);
  frame2.position.set(-4.4, 6.6, WALL + 0.07); root.add(frame2);
  const print2 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshStandardMaterial({ map: coverTex[5 % tracks.length], roughness: 0.6 }));
  print2.position.set(-4.4, 6.6, WALL + 0.14); root.add(print2);

  // warm lamp glow from the left
  const lamp = new THREE.PointLight(0xffb36b, 30, 26, 1.6); lamp.position.set(-11, 4.5, -1.5); root.add(lamp);
  const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, 1.3, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xf2dfc4, emissive: 0xffb36b, emissiveIntensity: 0.8, side: THREE.DoubleSide, roughness: 0.9 }));
  lampShade.position.set(-11, 4.5, -1.5); root.add(lampShade);
  const lampPole = tube(new THREE.Vector3(-11, FLOOR, -1.5), new THREE.Vector3(-11, 3.9, -1.5), 0.05, metal); root.add(lampPole);

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
    if (wide) camera.setViewOffset(W, H, -W * 0.2, 0, W, H); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();
  addEventListener('pointermove', (e) => { tx = (e.clientX / innerWidth) * 2 - 1; ty = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  addEventListener('scroll', () => { scrollT = Math.min(1, scrollY / innerHeight); }, { passive: true });

  // ── records
  const covers = tracks.map(() => null);
  const texs = [];
  const texFor = (i) => texs[i] || vinylMat.map;
  tracks.forEach((tr, i) => {
    const im = new Image();
    im.onload = () => {
      covers[i] = im; texs[i] = vinylTexture(accentCol, true, im);
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
    shelf: { a: [-0.9, 0.12, 23, [17, -1.5, -2.4], -0.03, 30], b: [-0.3, 0.28, 17, [16.6, 0, -2.4], 0.03, 30] },
    amp: { a: [-0.6, 0.3, 13, [16.4, 2.2, -2.0], 0.04, 30], b: [0.05, 0.1, 9, [16.8, 2.3, -2.0], -0.03, 30] },
    phones: { a: [-1.0, 0.35, 10, [11.0, 1.1, -0.2], 0.05, 30], b: [0.3, 0.2, 7.5, [11.0, 1.2, -0.2], -0.04, 30] },
    cds: { a: [1.1, 0.45, 8, [-9.0, 0.2, 0.6], -0.04, 30], b: [0.25, 0.22, 5.4, [-9.0, 0.3, 0.6], 0.04, 30] },
    mug: { a: [0.6, 0.32, 9, [-3.8, 0.4, 1.0], 0.04, 30], b: [-0.3, 0.2, 6.8, [-3.9, 0.3, 0.6], -0.03, 30] },
    // dolly zoom: the camera pulls back while the lens zooms in
    speaker: { a: [0.55, 0.2, 7, [-6.4, 1.6, -1.0], 0, 44], b: [0.75, 0.22, 15, [-6.4, 1.6, -1.0], 0, 21] },
    wall: { a: [-0.5, 0.02, 17, [-1.0, 5.2, -4.0], 0.02, 30], b: [0.3, 0.12, 13, [1.0, 5.4, -4.0], -0.02, 30] },
    neon: { a: [0.6, 0.0, 10, [-10.5, 7.2, -4.2], -0.05, 30], b: [-0.15, -0.08, 7, [-11, 7.8, -4.2], 0.04, 30] },
    ledge: { a: [-0.5, 0.05, 12, [9.0, 5.4, -4.0], 0.04, 30], b: [0.4, -0.05, 9, [12.0, 5.6, -4.0], -0.03, 30] },
    // fly along the sideboard from the neon sign to the record shelf
    fly: { path: [V(-20, 10, 13), V(-13, 4.2, 11), V(-7, 2.4, 10.5), V(-1, 3.4, 10.5), V(5, 4.2, 11), V(10.5, 2.8, 10), V(15, 1.6, 13), V(22, 4.0, 17)],
      look: [V(-11, 7.5, -4), V(-9.0, 0.4, 0.6), V(-6.4, 1.8, -1), V(0.5, 0.2, 0), V(7.4, 1.6, 0.4), V(11, 1.2, -0.2), V(17, 1.0, -2.4), V(17, 2.4, -2.4)], roll: [0.06, -0.06] },
    // high sweep over the whole board
    sweep: { path: [V(-14, 13, 14), V(-4, 9, 12), V(6, 8, 11), V(15, 11, 12)], look: [V(-6, -0.5, -1), V(-1, -0.2, 0), V(4, 0.2, 0), V(10, 0, -1)], roll: [-0.03, 0.04] },
  };
  for (const k in MV) if (MV[k].path) { MV[k].pc = new THREE.CatmullRomCurve3(MV[k].path, false, 'centripetal'); MV[k].lc = new THREE.CatmullRomCurve3(MV[k].look, false, 'centripetal'); }
  const REST = [['needle', 'fly'], ['label', 'shelf', 'amp'], ['speaker', 'sweep'], ['phones', 'ledge', 'mug'], ['arm', 'neon', 'crate'], ['low', 'cds', 'top'], ['wall', 'fly']];
  const T0 = 24, C = 46, CH = 24; // first change, cycle length, change duration
  // returns [move, start, end]
  function shotAt(t) {
    if (t < 9) return ['intro', 0, 9];
    if (t < 16.5) return ['needle', 9, 16.5];
    if (t < T0) return ['label', 16.5, T0];
    const k = Math.floor((t - T0) / C), base = T0 + k * C, u = t - base;
    if (u < 7) return ['deck', base, base + 7];
    if (u < 17.5) return ['sleeve', base + 7, base + 17.5];
    if (u < CH) return ['deck2', base + 17.5, base + CH];
    const rest = REST[k % REST.length], len = (C - CH) / rest.length, j = Math.min(rest.length - 1, Math.floor((u - CH) / len));
    return [rest[j], base + CH + j * len, base + CH + (j + 1) * len];
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
  let shot = 'intro', from = null, switchT = 0, lastP = null;
  const _up = V(0, 1, 0), _f = V(), _rt = V();

  // ── animation timeline (seconds)
  const T_SWING = [1.2, 5.2], T_DROP = [5.2, 7.2], T_SPIN = [6.2, 9.4];
  const RPM = (33.333 / 60) * Math.PI * 2;
  const clock = new THREE.Clock();
  let angle = 0, energy = 0, raf = 0, visible = true, lastT = 0, cur = 0, shown = -1;
  const fixed = new URLSearchParams(location.search).get('tt');
  const start = reduced ? -10 : 0;
  if (reduced) lastT = 10;

  function frame() {
    const t = fixed !== null ? +fixed : clock.getElapsedTime() - start;
    let armY, up, spin, idx = 0;
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
      const k = Math.floor((t - T0) / C), r = t - T0 - k * C;
      const prev = k % tracks.length, next = (k + 1) % tracks.length;
      const ph = (a, b) => sine((r - a) / (b - a));
      const lastPlay = playY(C);
      if (r < CH) {
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
      } else {
        armY = playY(r - CH);
        up = 0;
        spin = r < 25.4 ? ph(22.4, 25.4) : 1;
        slTex = next; idx = next;
      }
    }
    if (idx !== cur || shown < 0) {
      cur = idx; shown = idx;
      vinylMat.map = texFor(idx); vinylMat.needsUpdate = true;
      if (tracks.length) onTrack(idx);
    }
    if (sleeveMat.map !== coverTex[slTex]) { sleeveMat.map = coverTex[slTex]; sleeveMat.needsUpdate = true; }
    sleeve.position.copy(slP); sleeve.quaternion.copy(slQ);
    yaw.rotation.y = armY;
    pitch.rotation.x = -up + (up < 0.01 ? Math.sin(t * 9) * 0.0012 : 0);
    const dt = Math.min(0.05, Math.max(0, t - lastT)); lastT = t;
    angle += RPM * spin * dt;
    platter.rotation.y = -angle;
    vinyl.visible = recVis;
    vinyl.position.copy(recP);
    if (recQ) vinyl.quaternion.copy(recQ); else vinyl.quaternion.copy(qFlat(-angle));
    for (let i = 0; i < DUST; i++) { const d = dustSeed[i]; dustPos[i * 3] = d[0] + Math.sin(t * 0.07 + d[3]) * 0.8; dustPos[i * 3 + 1] = d[1] + Math.sin(t * 0.05 + d[3] * 2) * 0.6; dustPos[i * 3 + 2] = d[2] + Math.cos(t * 0.06 + d[3]) * 0.5; }
    dustGeo.attributes.position.needsUpdate = true;
    steam.forEach((st, i) => { const k = ((t * 0.25 + i / 3) % 1); st.position.y = 1.1 + k * 1.4; st.material.opacity = Math.sin(k * Math.PI) * 0.07; st.rotation.y = t * 0.3 + i; st.scale.x = 1 + k; });
    needles.forEach((n, i) => { n.rotation.z = -0.8 + Math.min(1.5, energy * 2.4 + 0.15 + Math.sin(t * (7 + i * 3)) * 0.06 * (spin > 0.5 ? 1 : 0)) * spin; });
    neon.material.opacity = 0.92 + Math.sin(t * 31) * 0.03 + (Math.sin(t * 1.7) > 0.995 ? -0.5 : 0);
    woofer.position.z = 1.0 + energy * 0.08;

    // camera
    let cur3 = scrollT > 0.05 ? ['wide', t, t + 1] : shotAt(t);
    if (cur3[0] !== shot) { from = lastP; shot = cur3[0]; switchT = t; }
    let P = poseAt(cur3[0], t, cur3[1], cur3[2]);
    if (shot === 'wide') { const o = orbit([MV.wide.a[0] + scrollT * 0.3, MV.wide.a[1] - scrollT * 0.1, wide ? MV.wide.a[2] : 9.9, MV.wide.a[3]], false); P = o; }
    const blend = from ? sine((t - switchT) / 4.2) : 1;
    if (from && blend < 1) {
      // travel on an arc between the two moves instead of a straight line
      const dist = from.p.distanceTo(P.p);
      const p = from.p.clone().lerp(P.p, blend); p.y += Math.sin(blend * Math.PI) * Math.min(6, dist * 0.18);
      P = { p, l: from.l.clone().lerp(P.l, blend), r: lerp(from.r, P.r, blend), f: lerp(from.f, P.f, blend) };
    }
    lastP = P;
    mx += (tx - mx) * 0.02; my += (ty - my) * 0.02;
    _f.copy(P.l).sub(P.p).normalize(); _rt.crossVectors(_f, _up).normalize();
    camera.position.copy(P.p).addScaledVector(_rt, mx * 0.35).addScaledVector(_up, -my * 0.2);
    camera.up.set(0, 1, 0).applyAxisAngle(_f, P.r);
    camera.lookAt(P.l);
    if (Math.abs(camera.fov - P.f) > 0.01) { camera.fov = P.f; camera.updateProjectionMatrix(); }
    rim.intensity = 40 + energy * 160;
    fill.intensity = 12 + energy * 50;
    renderer.render(scene, camera);
    raf = visible ? requestAnimationFrame(frame) : 0;
  }
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  }).observe(canvas);
  raf = requestAnimationFrame(frame);

  return {
    setAccent(hex) {
      accentCol.set(hex);
      rim.color.set(hex); fill.color.set(hex); cart.material.color.set(hex); strip.material.color.set(hex); under.color.set(hex); neonGlow.color.set(hex); accentBits.forEach((m) => m.material.color.set(hex));
    },
    setEnergy(v) { energy = v; }
  };
}
