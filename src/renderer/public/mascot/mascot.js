/**
 * mascot.js — Robot 3D de Q montado en #mascot-canvas.
 * Three.js debe cargarse antes que este archivo.
 * Expone window.Mascot.setState(state) para que app.js lo controle.
 */
window.Mascot = (() => {
  const canvas = document.getElementById("mascot-canvas");

  // ── Scene ────────────────────────────────────────────────
  const scene = new THREE.Scene();
  // transparent so CSS background shows through
  scene.fog = new THREE.FogExp2(0x0d0d0f, 0.008);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(3.8, 1.6, 9.0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);   // fully transparent background
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  // ── Resize to panel canvas ───────────────────────────────
  function resize() {
    const w = canvas.offsetWidth || 236;
    const h = canvas.offsetHeight || 306;
    canvas.width = w;
    canvas.height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  requestAnimationFrame(resize);

  // ── Procedural bump texture ──────────────────────────────
  function makeBump() {
    const c = document.createElement("canvas"); c.width = 512; c.height = 512;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#888"; ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 30000; i++) {
      ctx.fillStyle = Math.random() > .5 ? "#fff" : "#000";
      ctx.globalAlpha = Math.random() * .08;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  const bumpTex = makeBump();

  // ── Lights ───────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x0a1018, 2.0));

  const keyLight = new THREE.DirectionalLight(0xfff2d8, 3.0);
  keyLight.position.set(5, 9, 5); keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = keyLight.shadow.mapSize.height = 2048;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x4a72c4, 1.4);
  fillLight.position.set(-6, 2, 3); scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 4.0);
  rimLight.position.set(-2, 5, -7); scene.add(rimLight);

  const floorLight = new THREE.PointLight(0x00ffcc, 2.5, 8);
  floorLight.position.set(0, -1.8, 0); scene.add(floorLight);

  // ── Materials ────────────────────────────────────────────
  const matBlack = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.72, metalness: 0.45, bumpMap: bumpTex, bumpScale: 0.012 });
  const matBronze = new THREE.MeshStandardMaterial({ color: 0x8a6a40, roughness: 0.42, metalness: 0.78, bumpMap: bumpTex, bumpScale: 0.01 });
  const matGold = new THREE.MeshStandardMaterial({ color: 0xc6a052, roughness: 0.28, metalness: 0.92, bumpMap: bumpTex, bumpScale: 0.007 });
  const matDarkGold = new THREE.MeshStandardMaterial({ color: 0x7a5c20, roughness: 0.6, metalness: 0.7 });
  const matLens = new THREE.MeshStandardMaterial({ color: 0x0044bb, emissive: new THREE.Color(0x0088ff), emissiveIntensity: 2.2, roughness: 0.05, metalness: 0.95 });
  const matLensFrame = new THREE.MeshStandardMaterial({ color: 0xb89040, roughness: 0.3, metalness: 0.9 });
  const matCableOuter = new THREE.MeshStandardMaterial({ color: 0x2a2820, roughness: 0.8, metalness: 0.3 });
  const matCableRing = new THREE.MeshStandardMaterial({ color: 0x5a4820, roughness: 0.4, metalness: 0.8 });

  // ── Helpers ──────────────────────────────────────────────
  function roundedBox(w, h, d, r = 0.1) {
    const s = new THREE.Shape();
    s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2);
    s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); s.lineTo(w / 2, h / 2 - r);
    s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r);
    s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const geo = new THREE.ExtrudeGeometry(s, { depth: d - r * 2, bevelEnabled: true, bevelSegments: 6, steps: 1, bevelSize: r, bevelThickness: r, curveSegments: 14 });
    geo.center(); return geo;
  }

  // ── Robot assembly ───────────────────────────────────────
  const robotGroup = new THREE.Group();
  scene.add(robotGroup);

  // Body
  const bodyGeo = roundedBox(1.25, 1.55, 1.25, 0.14);
  const bodyMesh = new THREE.Mesh(bodyGeo, matBlack);
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;
  robotGroup.add(bodyMesh);

  [0.38, -0.42, 0.0].forEach(y => {
    const s = new THREE.Mesh(roundedBox(1.27, 0.045, 1.27, 0.02), matGold);
    s.position.y = y; bodyMesh.add(s);
  });

  const grillPlate = new THREE.Mesh(roundedBox(0.65, 0.36, 0.04, 0.02), matDarkGold);
  grillPlate.position.set(0, 0.1, 0.63); bodyMesh.add(grillPlate);
  for (let i = 0; i < 4; i++) {
    const sl = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.022, 0.06), matGold);
    sl.position.set(0, 0.1 + (i - 1.5) * 0.08, 0.63); bodyMesh.add(sl);
  }
  const qPlate = new THREE.Mesh(roundedBox(0.18, 0.26, 0.04, 0.02), matGold);
  qPlate.position.set(0.38, -0.12, 0.64); bodyMesh.add(qPlate);

  // Neck cable
  const neckPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.28, -0.28),
    new THREE.Vector3(0, 0.18, -0.58),
    new THREE.Vector3(0, 0.65, -0.32),
  ]);
  const tubeMesh = new THREE.Mesh(new THREE.TubeGeometry(neckPath, 40, 0.062, 10, false), matCableOuter);
  tubeMesh.castShadow = true;
  robotGroup.add(tubeMesh);
  neckPath.getPoints(18).forEach((pt, i, pts) => {
    if (i === 0 || i % 2 !== 1) return;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.018, 8, 16), matCableRing);
    ring.position.copy(pt);
    ring.lookAt(pts[Math.min(i + 1, pts.length - 1)]);
    ring.rotateX(Math.PI / 2);
    robotGroup.add(ring);
  });

  // Head
  const headGroup = new THREE.Group();
  headGroup.position.y = 1.55;
  robotGroup.add(headGroup);

  const headMesh = new THREE.Mesh(roundedBox(1.55, 0.85, 1.05, 0.16), matBronze);
  headMesh.castShadow = true; headMesh.position.y = 0.08;
  headGroup.add(headMesh);

  const headTopEdge = new THREE.Mesh(roundedBox(1.56, 0.05, 1.06, 0.02), matGold);
  headTopEdge.position.y = 0.44; headGroup.add(headTopEdge);

  // Gear emblem
  const gearOuter = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 8, 16), matGold);
  gearOuter.rotation.x = Math.PI / 2; gearOuter.position.set(0, 0.5, 0.1);
  headGroup.add(gearOuter);
  const gearInner = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 6), matBronze);
  gearInner.position.set(0, 0.52, 0.1); headGroup.add(gearInner);
  for (let i = 0; i < 8; i++) {
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.06), matGold);
    const a = i / 8 * Math.PI * 2;
    tooth.position.set(Math.cos(a) * 0.24, 0.52, 0.1 + Math.sin(a) * 0.24);
    headGroup.add(tooth);
  }

  // Eyes
  const eyeGroupL = new THREE.Group(); eyeGroupL.position.set(-0.35, 0.12, 0.535);
  const eyeGroupR = new THREE.Group(); eyeGroupR.position.set(0.35, 0.12, 0.535);
  headGroup.add(eyeGroupL, eyeGroupR);

  function buildEye(group) {
    group.add(new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.032, 14, 32), matLensFrame));
    group.add(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 8, 24), matGold));
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.175, 0.07, 32),
      new THREE.MeshStandardMaterial({ color: 0x080a0c, roughness: .9, metalness: .2 }));
    housing.rotation.x = Math.PI / 2; housing.position.z = -0.02; group.add(housing);
    const lensGeo = new THREE.SphereGeometry(0.16, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
    lensGeo.rotateX(Math.PI / 2);
    const lens = new THREE.Mesh(lensGeo, matLens);
    lens.position.z = 0.04; group.add(lens);
    const glare = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.5, roughness: 0, metalness: 0 }));
    glare.position.set(-0.06, 0.06, 0.14); group.add(glare);
  }
  buildEye(eyeGroupL); buildEye(eyeGroupR);

  // Eyebrows
  const browGeo = roundedBox(0.34, 0.065, 0.065, 0.02);
  const browPivotL = new THREE.Group(); browPivotL.position.set(-0.35, 0.4, 0.54);
  const browPivotR = new THREE.Group(); browPivotR.position.set(0.35, 0.4, 0.54);
  browPivotL.add(new THREE.Mesh(browGeo, matBlack));
  browPivotR.add(new THREE.Mesh(browGeo, matBlack));
  headGroup.add(browPivotL, browPivotR);

  // Base platform
  // ── Base ring — green with Q texture ────────────────────
  const GREEN = 0x22c55e;
  const glowRingMat = new THREE.MeshStandardMaterial({
    color: GREEN, emissive: new THREE.Color(GREEN),
    emissiveIntensity: 2.2, roughness: 0, metalness: 1,
    transparent: true, opacity: 0.85,
  });
  const glowRing = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.03, 10, 64), glowRingMat);
  glowRing.position.y = -1.3; glowRing.rotation.x = Math.PI / 2;
  robotGroup.add(glowRing);

  // Q label on the ring — canvas texture on a flat disk
  const qCanvas = document.createElement("canvas");
  qCanvas.width = qCanvas.height = 256;
  const qCtx = qCanvas.getContext("2d");
  // radial glow
  const grad = qCtx.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, "rgba(34,197,94,0.18)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  qCtx.fillStyle = grad; qCtx.fillRect(0, 0, 256, 256);
  // Q letter
  qCtx.font = "bold 120px 'Segoe UI', Arial, sans-serif";
  qCtx.fillStyle = "#4ade80";
  qCtx.globalAlpha = 1.0;
  qCtx.shadowColor = "#22c55e";
  qCtx.shadowBlur = 18;
  qCtx.textAlign = "center";
  qCtx.textBaseline = "middle";
  qCtx.fillText("Q", 128, 134);
  const qTex = new THREE.CanvasTexture(qCanvas);
  const qDisk = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 64),
    new THREE.MeshBasicMaterial({ map: qTex, transparent: true, opacity: 1.0, depthWrite: false }),
  );
  qDisk.position.y = -1.3; qDisk.rotation.x = -Math.PI / 2;
  robotGroup.add(qDisk);

  robotGroup.position.set(0, 0.0, 0);

  // ── Mouse tracking (relative to canvas) ─────────────────
  let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
  canvas.addEventListener("mousemove", e => {
    const r = canvas.getBoundingClientRect();
    mouseX = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouseY = -((e.clientY - r.top) / r.height) * 2 + 1;
  });
  // Al salir de la ventana, volver al centro suavemente
  document.addEventListener("mouseleave", () => { mouseX = 0; mouseY = 0; });

  // ── State machine ────────────────────────────────────────
  const LED = {
    loading:   { lens: 0x886600, emissive: 0xffcc00, intensity: 1.8, floor: 0xffcc00 },
    idle:      { lens: 0x0066ff, emissive: 0x0099ff, intensity: 2.2, floor: 0x00ffcc },
    listening: { lens: 0xcc2200, emissive: 0xff3300, intensity: 3.0, floor: 0xff4422 },
    thinking:  { lens: 0xcc7700, emissive: 0xff9900, intensity: 2.8, floor: 0x4488ff },
    speaking:  { lens: 0x005500, emissive: 0x00ff44, intensity: 2.5, floor: 0x22ff88 },
    rejected:  { lens: 0x880000, emissive: 0xff0000, intensity: 3.2, floor: 0xff0000 },
    sleeping:  { lens: 0x110033, emissive: 0x4400aa, intensity: 0.6, floor: 0x220044 },
    printing:  { lens: 0x004422, emissive: 0x00ff88, intensity: 3.5, floor: 0x00ff44 },
    working:   { lens: 0x003366, emissive: 0x0066ff, intensity: 3.8, floor: 0x0044ff },
    spinning:  { lens: 0x660066, emissive: 0xff00ff, intensity: 4.0, floor: 0xff00cc },
    happy:     { lens: 0x886600, emissive: 0xffdd00, intensity: 3.5, floor: 0xffaa00 },
    scared:    { lens: 0xaaaacc, emissive: 0xccddff, intensity: 3.0, floor: 0x88aaff },
    angry:     { lens: 0x990000, emissive: 0xff2200, intensity: 4.5, floor: 0xff0000 },
    transform: { lens: 0xffffff, emissive: 0xffffff, intensity: 4.0, floor: 0xffffff },
  };

  // Acento de marca por modelo/proveedor activo en Amatista — independiente
  // del LED emocional de arriba. Solo tiñe el estado "idle" (reposo) y el
  // aro/base; los estados con carga emocional (angry, scared, etc.) siempre
  // priorizan su propio color semántico, para no perder la señal.
  const MODEL_COLORS = {
    claude:  0xd97757,
    gpt:     0x10a37f,
    gemini:  0x4285f4,
    local:   0x22c55e,
    default: 0x00ffcc,
  };
  let modelAccent = MODEL_COLORS.default;

  let currentState = "idle";
  let currentAnim  = "idle"; // animación activa (puede diferir del estado LED)
  let stateTime = 0;
  let spinAngle  = 0;

  // setState: cambia LED + animación — para eventos reales (conexión, voz)
  function applyState(state) {
    currentState = state;
    currentAnim  = state;
    stateTime = 0;
    const c = LED[state] || LED.idle;
    // En reposo, el color refleja el modelo activo en vez del azul fijo —
    // así la mascota comunica "con qué modelo estás hablando" sin depender
    // de ningún otro indicador en la UI.
    const lensHex  = state === "idle" ? modelAccent : c.lens;
    const floorHex = state === "idle" ? modelAccent : c.floor;
    matLens.color.setHex(lensHex);
    matLens.emissive.setHex(c.emissive);
    matLens.emissiveIntensity = c.intensity;
    floorLight.color.setHex(floorHex);
  }

  // setModel: cambia el acento de marca. No dispara animación ni afecta
  // estados emocionales activos — solo aplica de inmediato al aro base
  // y queda guardado para la próxima vez que el estado vuelva a "idle".
  function applyModel(name) {
    modelAccent = MODEL_COLORS[name] || MODEL_COLORS.default;
    glowRingMat.color.setHex(modelAccent);
    glowRingMat.emissive.setHex(modelAccent);
    if (currentState === "idle") {
      matLens.color.setHex(modelAccent);
      floorLight.color.setHex(modelAccent);
    }
  }

  // setAnim: solo cambia el movimiento, preserva el color LED actual
  function applyAnim(anim) {
    currentAnim = anim;
    stateTime   = 0;
    if (anim === "spinning") spinAngle = 0;
  }

  // ── Animation loop ───────────────────────────────────────
  const clock = new THREE.Clock();
  const BASE_Y = 0.1;

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    stateTime += 0.016;

    targetX += (mouseX - targetX) * 0.07;
    targetY += (mouseY - targetY) * 0.07;

    const floatY = Math.sin(t * 1.5) * 0.07 + Math.cos(t * 0.7) * 0.025;
    robotGroup.rotation.set(0, 0, 0);
    robotGroup.position.x = 0;
    robotGroup.scale.set(1, 1, 1);
    headGroup.rotation.set(0, 0, 0);
    bodyMesh.rotation.set(0, 0, 0);
    bodyMesh.position.z = 0;

    // Blink target — por defecto ojos abiertos; estados sobreescriben
    let blinkTarget = 1;

    switch (currentAnim) {

      case "loading":
        robotGroup.position.y = BASE_Y + Math.sin(t * 0.8) * 0.03;
        matLens.emissiveIntensity = 1.0 + Math.abs(Math.sin(t * 2.5)) * 2.0;
        break;

      case "idle":
        robotGroup.position.y = BASE_Y + floatY;
        robotGroup.rotation.z = Math.sin(t * 1.2) * 0.012;
        headGroup.rotation.y = targetX * 0.55;
        headGroup.rotation.x = -targetY * 0.28;
        bodyMesh.rotation.y = targetX * 0.1;
        break;

      case "listening":
        robotGroup.position.y = BASE_Y + floatY + Math.sin(stateTime * 5) * 0.025;
        headGroup.rotation.y = targetX * 0.55 + Math.sin(stateTime * 8) * 0.04;
        headGroup.rotation.x = -targetY * 0.3;
        break;

      case "thinking":
        robotGroup.position.y = BASE_Y + floatY;
        headGroup.rotation.y = Math.sin(stateTime * 1.8) * 0.6;
        headGroup.rotation.x = Math.sin(stateTime * 2.3) * 0.15;
        bodyMesh.rotation.y = Math.sin(stateTime * 0.9) * 0.08;
        // cejas fruncidas: inclinadas hacia adentro
        browPivotL.rotation.z =  0.22;
        browPivotR.rotation.z = -0.22;
        browPivotL.position.y = browPivotR.position.y = 0.34;
        break;

      case "speaking":
        robotGroup.position.y = BASE_Y + floatY + Math.abs(Math.sin(stateTime * 12)) * 0.02;
        headGroup.rotation.y = targetX * 0.55;
        headGroup.rotation.x = -targetY * 0.28 + Math.sin(stateTime * 10) * 0.025;
        break;

      case "rejected":
        robotGroup.position.y = BASE_Y + floatY;
        headGroup.rotation.z = Math.sin(stateTime * 6) * 0.12 * Math.max(0, 1 - stateTime * 0.5);
        break;

      case "sleeping": {
        // Cabeza cae hacia adelante progresivamente, cuerpo oscila lento
        const droopTarget = 0.65;
        const droopActual = Math.min(droopTarget, stateTime * 0.2);
        robotGroup.position.y = BASE_Y + Math.sin(t * 0.4) * 0.02;
        headGroup.rotation.x  = droopActual;
        headGroup.rotation.z  = Math.sin(t * 0.3) * 0.04;
        robotGroup.rotation.z = Math.sin(t * 0.35) * 0.018;
        // ojos cerrados
        blinkTarget = 0.03;
        // brillo de lente pulsa muy despacio (respiración)
        matLens.emissiveIntensity = 0.3 + Math.abs(Math.sin(t * 0.5)) * 0.5;
        // "ronquido" cada ~4s: mini sacudida
        const snore = t % 4.0;
        if (snore > 3.7 && snore < 3.85)
          robotGroup.position.y += Math.sin((snore - 3.7) / 0.15 * Math.PI) * 0.06;
        break;
      }

      case "printing": {
        // Cuerpo vibra como impresora; cabeza baja mirando el "papel"
        const vib = Math.sin(stateTime * 60) * 0.018;
        robotGroup.position.y = BASE_Y - 0.06 + Math.sin(stateTime * 2) * 0.015;
        robotGroup.position.x = vib;
        headGroup.rotation.x  = 0.32 + Math.sin(stateTime * 8) * 0.04;
        headGroup.rotation.y  = Math.sin(stateTime * 3) * 0.08;
        bodyMesh.rotation.z   = vib * 0.6;
        // lente parpadea verde rápido
        matLens.emissiveIntensity = 2.5 + Math.abs(Math.sin(stateTime * 18)) * 1.5;
        break;
      }

      case "working": {
        // Cabeza escanea izquierda/derecha rápido, cuerpo inclina hacia tarea
        robotGroup.position.y = BASE_Y + Math.sin(t * 3) * 0.015;
        headGroup.rotation.y  = Math.sin(stateTime * 4.5) * 0.55;
        headGroup.rotation.x  = 0.18 + Math.sin(stateTime * 7) * 0.06;
        bodyMesh.rotation.y   = Math.sin(stateTime * 2.2) * 0.12;
        bodyMesh.rotation.x   = 0.08;
        // ojos corren de lado a lado (se maneja con eyeGroup abajo)
        eyeGroupL.position.x = -0.35 + Math.sin(stateTime * 4.5) * 0.09;
        eyeGroupR.position.x =  0.35 + Math.sin(stateTime * 4.5) * 0.09;
        // cejas: concentración
        browPivotL.rotation.z =  0.18;
        browPivotR.rotation.z = -0.18;
        break;
      }

      case "spinning": {
        // Giro completo continuo + rebote vertical festivo
        spinAngle += 0.07;
        robotGroup.rotation.y = spinAngle;
        robotGroup.position.y = BASE_Y + Math.abs(Math.sin(t * 4)) * 0.12;
        robotGroup.rotation.z = Math.sin(t * 3) * 0.08;
        break;
      }

      case "happy": {
        robotGroup.position.y = BASE_Y + Math.abs(Math.sin(stateTime * 5)) * 0.18;
        headGroup.rotation.x  = Math.sin(stateTime * 5) * 0.18;
        robotGroup.rotation.z = Math.sin(stateTime * 5) * 0.06;
        bodyMesh.rotation.z   = Math.sin(stateTime * 5) * 0.04;
        browPivotL.position.y = browPivotR.position.y = 0.48;
        break;
      }

      case "scared": {
        // Recoil brusco hacia atrás/arriba con overshoot, luego tiembla en el sitio
        const recoil = Math.min(1, stateTime * 6) * Math.exp(-stateTime * 2.5);
        robotGroup.position.y = BASE_Y + floatY + recoil * 0.22;
        robotGroup.position.x = Math.sin(stateTime * 40) * 0.02 * (1 - Math.min(1, stateTime * 2));
        headGroup.rotation.x  = -recoil * 0.35;
        robotGroup.rotation.z = Math.sin(stateTime * 30) * 0.03;
        // ojos muy abiertos
        blinkTarget = 1.5;
        // cejas disparadas hacia arriba
        browPivotL.rotation.z = 0.05; browPivotR.rotation.z = -0.05;
        browPivotL.position.y = browPivotR.position.y = 0.58;
        break;
      }

      case "angry": {
        // Vibración densa y rápida, cuerpo agachado hacia adelante, cejas caídas duro
        const shake = Math.sin(stateTime * 45) * 0.028;
        robotGroup.position.y = BASE_Y + Math.sin(t * 6) * 0.01;
        robotGroup.position.x = shake;
        headGroup.rotation.x  = 0.14 + Math.sin(stateTime * 20) * 0.02;
        headGroup.rotation.z  = shake * 0.8;
        bodyMesh.rotation.z   = shake * 0.5;
        // leve "inflado" — pecho al frente
        bodyMesh.position.z   = Math.min(0.05, stateTime * 0.08);
        browPivotL.rotation.z =  0.34; browPivotR.rotation.z = -0.34;
        browPivotL.position.y = browPivotR.position.y = 0.3;
        // lente pulsa rojo intenso
        matLens.emissiveIntensity = 3.5 + Math.abs(Math.sin(stateTime * 14)) * 2.5;
        break;
      }

      case "transform": {
        // Giro rápido + pulso de escala + barrido de color arcoíris — lectura
        // visual de "transformándose", sin geometría nueva
        spinAngle += 0.16;
        robotGroup.rotation.y = spinAngle;
        const pulse = 1 + Math.sin(stateTime * 10) * 0.16;
        robotGroup.scale.set(pulse, pulse, pulse);
        robotGroup.position.y = BASE_Y + Math.sin(t * 8) * 0.05;
        const hue = (stateTime * 0.4) % 1;
        matLens.color.setHSL(hue, 1, 0.5);
        matLens.emissive.setHSL(hue, 1, 0.55);
        matLens.emissiveIntensity = 3.0 + Math.abs(Math.sin(stateTime * 12)) * 2.0;
        floorLight.color.setHSL((hue + 0.5) % 1, 1, 0.5);
        break;
      }
    }

    // Eyebrows — solo si no fue sobreescrito por estado
    if (currentAnim !== "thinking" && currentAnim !== "working" && currentAnim !== "happy") {
      browPivotL.rotation.z = targetY < 0 ? targetY * 0.28 : targetY * 0.1;
      browPivotR.rotation.z = -(targetY < 0 ? targetY * 0.28 : targetY * 0.1);
      browPivotL.position.y = browPivotR.position.y = 0.4 + targetY * (targetY < 0 ? 0.05 : 0.08);
    }

    // Eye tracking — solo si working no lo sobreescribió
    if (currentAnim !== "working") {
      eyeGroupL.position.x = -0.35 + targetX * 0.06;
      eyeGroupL.position.y =  0.12 + targetY * 0.06;
      eyeGroupR.position.x =  0.35 + targetX * 0.06;
      eyeGroupR.position.y =  0.12 + targetY * 0.06;
    }

    // Blink — forzado por estado (sleeping=cerrado, otros=auto)
    const bp = t % 5.5;
    const autoBlink = (bp > 5.2 && bp < 5.4) ? 0.05 : 1;
    const bs = (currentAnim === "sleeping") ? blinkTarget : autoBlink;
    eyeGroupL.scale.y += (bs - eyeGroupL.scale.y) * (currentAnim === "sleeping" ? 0.04 : 0.18);
    eyeGroupR.scale.y += (bs - eyeGroupR.scale.y) * (currentAnim === "sleeping" ? 0.04 : 0.18);

    floorLight.intensity += (2.5 - floorLight.intensity) * 0.08;
    glowRing.rotation.z += currentAnim === "spinning" ? 0.04 : 0.003;

    camera.lookAt(0, 0.4, 0);
    renderer.render(scene, camera);
  }
  animate();

  // ── Public API ───────────────────────────────────────────
  return {
    setState(state) { applyState(state); },
    setAnim(anim)   { applyAnim(anim);   },
    setModel(name)  { applyModel(name);  },
  };
})();
