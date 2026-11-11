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

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const accentCol = new THREE.Color(accent);

  // ── lights
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(-4, 9, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
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
  // floor shadow catcher
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.45 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.64; floor.receiveShadow = true;
  root.add(floor);

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
  platter.add(vinyl);
  const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 24), metal);
  spindle.position.y = 0.15;
  platter.add(spindle);

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

  // ── camera shots: [azimuth, elevation, distance, target]
  const SH = {
    wide: [-0.55, 0.62, wide ? 12.9 : 9.9, [0.5, -0.35, 0]],
    needle: [-0.15, 0.2, 3.1, [1.35, 0.1, 0.7]],
    label: [-0.6, 1.05, 4.4, [0, 0.1, 0]],
    low: [0.75, 0.07, 8.2, [0.5, 0.05, 0]],
    top: [-0.3, 1.47, 10.5, [0.4, 0, 0]],
    arm: [-1.15, 0.33, 3.6, [2.0, 0.35, -1.0]],
    sweep: [-2.2, 0.38, 7.5, [0.4, 0, 0]],
  };
  const CLOSE = [['needle', 'label'], ['low', 'arm'], ['top', 'sweep'], ['label', 'needle'], ['arm', 'low']];
  const T0 = 13.4, C = 12;
  function shotAt(t) {
    if (t < 5.4) return 'intro';
    if (t < 9.4) return 'needle';
    if (t < T0) return 'label';
    const k = Math.floor((t - T0) / C), u = t - T0 - k * C;
    if (u < 6.4) return 'wide';
    return CLOSE[k % CLOSE.length][u < 9.2 ? 0 : 1];
  }
  const lerp = (a, b, k) => a + (b - a) * k;
  function shotParams(name, t) {
    if (name === 'intro') {
      const w = SH.wide, i = easeOut(t / 4.5);
      return [w[0] + (1 - i) * 0.5, w[1] + (1 - i) * 0.25, w[2] + (1 - i) * 2.6, w[3]];
    }
    const s = SH[name];
    if (name === 'wide') s[2] = wide ? 12.9 : 9.9;
    const drift = (t % 100) * 0.012; // slow dolly inside a shot
    return [s[0] + drift * (name === 'sweep' ? 3 : 1) - 0.06, s[1], s[2] * (1 - drift * 0.15), s[3]];
  }
  let shot = 'intro', from = null, switchT = 0, lastP = null;

  // ── animation timeline (seconds)
  const T_SWING = [0.5, 3.0];   // arm swings over the record
  const T_DROP = [3.0, 4.2];    // needle lowers
  const T_SPIN = [3.4, 5.4];    // platter spins up
  const RPM = (33.333 / 60) * Math.PI * 2;
  const clock = new THREE.Clock();
  let angle = 0, energy = 0, raf = 0, visible = true, lastT = 0, cur = 0, shown = -1;
  const fixed = new URLSearchParams(location.search).get('tt');
  const start = reduced ? -10 : 0;
  if (reduced) lastT = 10;

  function frame() {
    const t = fixed !== null ? +fixed : clock.getElapsedTime() - start;
    let armY, up, spin, lift = 0, flip = 0, idx = 0;
    if (t < T0 || reduced || !tracks.length) {
      const swing = ease((t - T_SWING[0]) / (T_SWING[1] - T_SWING[0]));
      const drop = ease((t - T_DROP[0]) / (T_DROP[1] - T_DROP[0]));
      spin = easeOut((t - T_SPIN[0]) / (T_SPIN[1] - T_SPIN[0]));
      armY = REST_Y + (PLAY_Y - REST_Y) * swing + (INNER_Y - PLAY_Y) * 0.08 * Math.max(0, (t - T_DROP[1]) / 9);
      up = swing < 1 ? 0.16 * Math.sin(Math.min(1, swing * 1.4) * Math.PI * 0.5) + 0.02 : 0.18 * (1 - drop);
    } else {
      // record change every C seconds: lift arm, park it, flip in the next record, play again
      const k = Math.floor((t - T0) / C), r = t - T0 - k * C;
      idx = (k + 1) % tracks.length;
      const prev = k % tracks.length;
      const ph = (a, b) => ease((r - a) / (b - a));
      const raise = ph(0, 0.7), park = ph(0.7, 1.9), back = ph(3.6, 4.9), drop = ph(4.9, 5.7);
      armY = lerp(lerp(INNER_Y * 0.08 + PLAY_Y * 0.92, REST_Y, park), PLAY_Y, back) + (INNER_Y - PLAY_Y) * 0.08 * Math.max(0, (r - 5.7) / 6);
      up = r < 4.9 ? 0.18 * raise : 0.18 * (1 - drop);
      spin = r < 0.4 ? 1 : r < 2.2 ? 1 - ease((r - 0.4) / 1.8) : r < 5.3 ? 0 : easeOut((r - 5.3) / 1.6);
      const f = Math.min(1, Math.max(0, (r - 1.9) / 1.7));
      lift = Math.sin(f * Math.PI) * 1.1;
      flip = ease(f) * Math.PI;
      if (f < 1) idx = prev;
      if (f > 0 && f < 1) {
        vinylMat.map = texFor(prev); vinylMatB.map = texFor((k + 1) % tracks.length);
      } else {
        vinylMat.map = texFor(idx);
        flip = 0;
      }
    }
    if (idx !== cur || shown < 0) {
      cur = idx; shown = idx;
      vinylMat.map = texFor(idx); vinylMat.needsUpdate = true;
      if (tracks.length) onTrack(idx);
    }
    vinylMat.needsUpdate = vinylMatB.needsUpdate = true;
    yaw.rotation.y = armY;
    pitch.rotation.x = -up + (up < 0.01 ? Math.sin(t * 9) * 0.0012 : 0);
    vinyl.position.y = 0.08 + lift;
    vinyl.rotation.x = flip;
    const dt = Math.min(0.05, Math.max(0, t - lastT)); lastT = t;
    angle += RPM * spin * dt;
    platter.rotation.y = -angle;

    // camera
    const want = scrollT > 0.05 ? 'wide' : shotAt(t);
    if (want !== shot) { from = lastP; shot = want; switchT = t; }
    let P = shotParams(shot, t);
    const blend = from ? ease((t - switchT) / 1.7) : 1;
    if (from && blend < 1) {
      P = [lerp(from[0], P[0], blend), lerp(from[1], P[1], blend), lerp(from[2], P[2], blend), P[3].map((v, i) => lerp(from[3][i], v, blend))];
    }
    lastP = P;
    mx += (tx - mx) * 0.04; my += (ty - my) * 0.04;
    const az = P[0] + mx * 0.12 + scrollT * 0.4, el = Math.min(1.5, P[1] - my * 0.04 - scrollT * 0.12), d = P[2];
    const T = P[3];
    camera.position.set(T[0] + Math.sin(az) * Math.cos(el) * d, T[1] + Math.sin(el) * d, T[2] + Math.cos(az) * Math.cos(el) * d);
    camera.lookAt(T[0], T[1], T[2]);
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
      rim.color.set(hex); fill.color.set(hex); cart.material.color.set(hex);
    },
    setEnergy(v) { energy = v; }
  };
}
