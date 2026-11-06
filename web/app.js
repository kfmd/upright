'use strict';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULTS = { sens: 0.5, delay: 20, repeat: 120, notify: true, sound: true, preview: true };
const MSGS = ['Time to sit up tall.', 'Shoulders back, head up.', 'Posture check: you’re slouching.', 'Straighten up. Your spine will thank you.'];
const COLORS = { good: '#16a37f', slouch: '#e5484d', away: '#94a3b8' };

let profile = null, stream = null, landmarker = null, ticker = null, audio = null;
let mode = 'idle';                      // idle | cal (calibrating) | mon (monitoring)
let cap = null, calStep = 0, calData = {}, tracker = null, lastLm = null, lastRun = 0, lastTs = 0;

/* ---------------- 1. THE POSTURE MATH ----------------
   From the pose landmarks we compute 5 numbers (all relative to your shoulder width, so they
   don't depend on how big you look). Calibration records them for "good" and "slouched". */
function features(lm, w, h) {
  if (!lm) return null;
  const vis = p => p.visibility ?? 1;
  const [nose, eL, eR, sL, sR] = [0, 2, 5, 11, 12].map(i => lm[i]);
  if (Math.min(vis(nose), vis(sL), vis(sR)) < 0.5) return null;     // can't see face/shoulders
  const P = p => [p.x * w, p.y * h];
  const sw = Math.hypot(P(sL)[0] - P(sR)[0], P(sL)[1] - P(sR)[1]);  // shoulder width in pixels
  if (sw < w * 0.1) return null;
  const sy = (P(sL)[1] + P(sR)[1]) / 2, ey = (P(eL)[1] + P(eR)[1]) / 2;
  const eyes = Math.hypot(P(eL)[0] - P(eR)[0], P(eL)[1] - P(eR)[1]);
  return [(sy - ey) / sw,        // eyes above shoulders (drops when you slouch)
          (sy - P(nose)[1]) / sw, // nose above shoulders
          eyes / sw,              // head size vs shoulders (head juts forward)
          sw / w,                 // how close you are to the camera
          ey / h];                // how high your head sits in the picture
}
const mean = (a, i) => a.reduce((s, x) => s + x[i], 0) / a.length;
const sd = (a, i) => { const m = mean(a, i); return Math.sqrt(a.reduce((s, x) => s + (x[i] - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const sdv = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

// For each number: where is "good", how far is "slouched", and how much to trust it
// (trusted more when the two postures differ clearly compared with the jitter).
function buildModel(good, slouch) {
  const m = [0, 1, 2, 3, 4].map(i => {
    const g = mean(good, i), diff = mean(slouch, i) - g;
    const sep = Math.abs(diff) / (sd(good, i) + sd(slouch, i) + 0.02);
    return { g, diff, w: Math.abs(diff) < 0.01 ? 0 : Math.min(sep, 4) ** 2 };
  });
  if (m.every(k => !k.w)) throw new Error('identical');
  return m;
}
// 0 = exactly your good posture, 1 = exactly your slouched posture
function score(m, f) {
  let n = 0, d = 0;
  m.forEach((k, i) => { if (k.w) { n += k.w * Math.max(-1, Math.min(2, (f[i] - k.g) / k.diff)); d += k.w; } });
  return n / d;
}

/* ---------------- 2. SLOUCH TRACKER (decides when to remind) ---------------- */
const newTracker = () => ({ state: 'good', smooth: null, t: 0, since: 0, alertAt: 0, missing: 0, mon: 0, goodT: 0, alerts: 0 });
function advance(tr, now, s, cfg) {          // returns true when a reminder should fire
  const dt = tr.t ? Math.min((now - tr.t) / 1000, 5) : 0; tr.t = now;
  if (s === null) {                           // can't see you
    tr.missing += dt;
    if (tr.missing > 5) { tr.state = 'away'; tr.smooth = null; }
    return false;
  }
  tr.missing = 0;
  if (tr.state === 'away') tr.state = 'good';
  tr.smooth = tr.smooth === null ? s : tr.smooth + (s - tr.smooth) * (1 - Math.exp(-dt / 2));  // smooth out jitter
  tr.mon += dt; if (tr.state === 'good') tr.goodT += dt;
  if (tr.state === 'good' && tr.smooth >= cfg.sens) { tr.state = 'slouch'; tr.since = now; }
  else if (tr.state === 'slouch' && tr.smooth <= cfg.sens - 0.15) { tr.state = 'good'; tr.alertAt = 0; }
  if (tr.state === 'slouch' && now - tr.since >= cfg.delay * 1000 && (!tr.alertAt || now - tr.alertAt >= cfg.repeat * 1000)) {
    tr.alertAt = now; tr.alerts++; return true;
  }
  return false;
}

/* ---------------- 3. CAMERA + MODEL ---------------- */
async function startEngine() {
  if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('The camera needs a secure address: use http://localhost:8000 on the host Mac, or the https:// link on other devices.');
  if (!stream) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    for (const id of ['engine', 'v1', 'v2']) { $(id).srcObject = stream; $(id).play().catch(() => {}); }
    $('engine').onloadedmetadata = () => document.querySelectorAll('.stage').forEach(s => s.style.aspectRatio = $('engine').videoWidth + '/' + $('engine').videoHeight);
  }
  if (!landmarker) {
    let lib;
    try { lib = await import('/vendor/vision_bundle.mjs'); }
    catch (e) { throw new Error('Pose model files are missing. Stop the server and run  python3 server.py  once while online.'); }
    const files = await lib.FilesetResolver.forVisionTasks('/vendor/wasm');
    landmarker = await lib.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/vendor/pose.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 });
  }
  if (!ticker) {   // a Worker timer keeps ticking when this tab is in the background
    ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),200)'], { type: 'text/javascript' })));
    ticker.onmessage = tick;
  }
}
function stopCamera() {
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  for (const id of ['engine', 'v1', 'v2']) $(id).srcObject = null;
}

function tick() {
  if (mode === 'idle') return;
  const now = performance.now(), v = $('engine');
  if (now - lastRun < (mode === 'cal' ? 190 : 990)) return;        // calibrate ~5x/sec, monitor 1x/sec
  if (!landmarker || v.readyState < 2 || !v.videoWidth) { if (stream && v.paused) v.play().catch(() => {}); return; }
  lastRun = now;
  try { lastTs = Math.max(now, lastTs + 1); lastLm = landmarker.detectForVideo(v, lastTs).landmarks[0] || null; }
  catch (e) { console.warn(e); lastLm = null; }
  const f = features(lastLm, v.videoWidth, v.videoHeight);
  mode === 'cal' ? calFrame(f) : monFrame(f, now);
}

function draw(c, color) {
  const v = $('engine');
  if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
  const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
  if (!lastLm) return;
  const p = i => [lastLm[i].x * c.width, lastLm[i].y * c.height];
  g.strokeStyle = g.fillStyle = color; g.lineWidth = 4; g.lineCap = 'round';
  g.beginPath(); g.moveTo(...p(11)); g.lineTo(...p(12)); g.stroke();
  [0, 2, 5, 11, 12].forEach(i => { g.beginPath(); g.arc(...p(i), 7, 0, 7); g.fill(); });
}

/* ---------------- 4. CALIBRATION ---------------- */
const STEPS = [
  { key: 'good', title: 'Show me your best posture', btn: 'Capture good posture',
    text: 'Sit the way you want to sit all day: back straight, shoulders relaxed, head over your shoulders. Keep your face and both shoulders in view.' },
  { key: 'slouch', title: 'Now slouch the way you usually do', btn: 'Capture slouched posture',
    text: 'Let yourself sag: head forward, shoulders rounded. The clearer the difference, the better the detection.' }];

function show(id) { ['s-profile', 's-cal', 's-mon'].forEach(x => $(x).classList.toggle('hidden', x !== id)); }
function startCal() {
  mode = stream && landmarker ? 'cal' : 'idle'; calStep = 0; calData = {}; cap = null; show('s-cal'); showStep();
}
function showStep() {
  const s = STEPS[calStep];
  $('step').textContent = `Step ${calStep + 1} of 2`; $('calTitle').textContent = s.title; $('calText').textContent = s.text;
  $('calBtn').textContent = stream && landmarker ? s.btn : 'Turn on camera'; $('calBtn').disabled = false; $('calBar').style.width = '0';
}
function calFrame(f) {
  draw($('c1'), f ? COLORS.good : '#f59e0b');
  if (!cap) { $('calMsg').textContent = f ? '✓ I can see your head and shoulders.' : 'I can’t see you clearly. Keep your face and both shoulders in view.'; return; }
  if (f) cap.samples.push(f);
  const p = Math.min(1, (performance.now() - cap.start) / 5000);
  $('calBar').style.width = p * 100 + '%';
  if (p >= 1) finishCapture();
}
async function capture() {
  $('calBtn').disabled = true; $('calErr').textContent = '';
  for (let n = 3; n > 0; n--) { $('count').textContent = n; await sleep(1000); }
  $('count').textContent = '';
  cap = { samples: [], start: performance.now() };
}
function finishCapture() {
  const s = cap.samples; cap = null; $('calBar').style.width = '0';
  if (s.length < 12) { $('calErr').textContent = 'I only saw you in a few frames. Check the lighting, keep your head and shoulders in view, and try again.'; $('calBtn').disabled = false; return; }
  calData[STEPS[calStep].key] = s;
  if (++calStep < STEPS.length) return showStep();
  let model;
  try { model = buildModel(calData.good, calData.slouch); }
  catch (e) { calStep = 1; showStep(); $('calErr').textContent = 'Both postures looked identical to me. Slouch more clearly and try again.'; return; }
  const q = 1 / (sdv(calData.good.map(f => score(model, f))) + sdv(calData.slouch.map(f => score(model, f))) + 1e-6);
  profile.calib = { model, quality: q };
  persist(); showMon();
  if (q < 2.5) flash('The two postures were hard to tell apart. Try Recalibrate with a bigger slouch.');
}

/* ---------------- 5. MONITORING + REMINDERS ---------------- */
function showMon() { mode = 'idle'; show('s-mon'); applySettings(); render(); }
function monFrame(f, now) {
  const fire = advance(tracker, now, f ? score(profile.calib.model, f) : null, profile.settings);
  if (fire) alertUser();
  render();
  if (profile.settings.preview) draw($('c2'), COLORS[tracker.state]);
}
function render() {
  const t = tracker || newTracker(), s = profile.settings, on = mode === 'mon';
  const st = !on ? 'idle' : t.state === 'slouch' ? 'bad' : t.state === 'good' ? 'good' : 'away';
  document.body.dataset.state = st;
  $('status').textContent = !on ? 'Paused' : { good: 'Sitting tall', slouch: 'Slouching', away: 'Can’t see you' }[t.state];
  const secs = Math.round((performance.now() - t.since) / 1000);
  $('sub').textContent = !on ? 'Press start. You can then switch to other apps; it keeps watching.'
    : t.state === 'slouch' ? `Slouching for ${secs}s` + (secs < s.delay ? `, reminder in ${s.delay - secs}s` : '')
    : t.state === 'away' ? 'Step back into view to resume.' : 'Nice posture.';
  $('gFill').style.width = on && t.smooth !== null ? Math.max(0, Math.min(1, 1 - t.smooth)) * 100 + '%' : '0';
  $('gTick').style.left = (1 - s.sens) * 100 + '%';
  $('stGood').textContent = t.mon > 0 ? Math.round(100 * t.goodT / t.mon) + '%' : '–';
  $('stTime').textContent = Math.floor(t.mon / 60) + 'm'; $('stAlerts').textContent = t.alerts;
  $('toggle').textContent = on ? 'Pause monitoring' : 'Start monitoring';
  document.title = st === 'bad' ? '🔴 Sit up! · Upright' : st === 'good' ? '🟢 Upright' : 'Upright';
  $('icon').href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='5' fill='${{ bad: COLORS.slouch, good: COLORS.good }[st] || COLORS.away}'/></svg>`);
}
function flash(msg) { $('banner').textContent = msg; $('banner').classList.remove('hidden'); setTimeout(() => $('banner').classList.add('hidden'), 8000); }
function alertUser() {
  const msg = MSGS[Math.random() * MSGS.length | 0], s = profile.settings;
  flash(msg);
  if (s.notify && window.Notification && Notification.permission === 'granted') {
    try { const n = new Notification('Upright', { body: msg, tag: 'upright', silent: true }); n.onclick = () => { window.focus(); n.close(); }; setTimeout(() => n.close(), 8000); } catch (e) {}
  }
  if (s.sound && audio) chime();
}
function unlockAudio() { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); }
function chime() {
  audio.resume();
  [660, 495].forEach((hz, i) => {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.25;
    o.frequency.value = hz; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.start(t); o.stop(t + 0.7);
  });
}

/* ---------------- 6. PROFILES + SETTINGS ---------------- */
const slug = n => n.trim().toLowerCase().replace(/\s+/g, '-');
const persist = () => fetch('/api/profiles/' + encodeURIComponent(slug(profile.name)), { method: 'PUT', body: JSON.stringify(profile) }).catch(() => {});
function applySettings() {
  const s = profile.settings;
  $('delay').value = s.delay; $('repeat').value = s.repeat;
  $('optNotify').checked = s.notify; $('optSound').checked = s.sound; $('optPreview').checked = s.preview;
  $('stage2').classList.toggle('hidden', !s.preview);
  document.querySelectorAll('#sens button').forEach(b => b.classList.toggle('on', +b.dataset.v === s.sens));
}
async function openProfile(raw) {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N}_\- ]{1,24}$/u.test(name)) return fail(new Error('Use 1–24 letters, numbers, spaces or dashes for the name.'));
  unlockAudio();
  const r = await fetch('/api/profiles/' + encodeURIComponent(slug(name)));
  profile = r.ok ? await r.json() : { name, settings: {}, calib: null };
  profile.settings = { ...DEFAULTS, ...profile.settings };
  localStorage.setItem('upright-user', name); $('who').textContent = name;
  tracker = newTracker();
  profile.calib ? showMon() : startCal();
}
async function listPeople() {
  const list = await fetch('/api/profiles').then(r => r.json()).catch(() => []);
  $('people').replaceChildren(...list.map(p => { const b = document.createElement('button'); b.textContent = p.name; b.onclick = () => guard(openProfile)(p.name); return b; }));
}
function fail(e) {
  const known = { NotAllowedError: 'Camera access is blocked. Allow the camera for this site in your browser, and in macOS System Settings > Privacy & Security > Camera.',
    NotFoundError: 'No camera was found.', NotReadableError: 'The camera is busy. Close other apps using it (Zoom, FaceTime…).' };
  $('error').textContent = known[e.name] || e.message || String(e); $('error').classList.remove('hidden');
}
const guard = fn => async (...a) => { try { $('error').classList.add('hidden'); await fn(...a); } catch (e) { console.error(e); fail(e); $('calBtn').disabled = false; } };

$('go').onclick = guard(() => openProfile($('name').value));
$('name').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
$('calBtn').onclick = guard(async () => {
  unlockAudio();
  if (!stream || !landmarker) {
    $('calBtn').disabled = true; $('calBtn').textContent = 'Starting…';
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
    try { await startEngine(); } finally { showStep(); }
    mode = 'cal'; return;
  }
  await capture();
});
$('toggle').onclick = guard(async () => {
  unlockAudio();
  if (mode === 'mon') { mode = 'idle'; stopCamera(); return render(); }
  if (profile.settings.notify && window.Notification && Notification.permission === 'default') Notification.requestPermission();
  $('toggle').disabled = true;
  try { await startEngine(); } finally { $('toggle').disabled = false; }
  tracker = newTracker(); mode = 'mon'; render();
});
$('recal').onclick = () => { mode = 'idle'; startCal(); };
$('switch').onclick = () => { mode = 'idle'; stopCamera(); $('who').textContent = ''; document.title = 'Upright'; document.body.dataset.state = 'idle'; show('s-profile'); listPeople(); };
$('test').onclick = async () => {
  unlockAudio();
  if (window.Notification && Notification.permission === 'default') await Notification.requestPermission();
  alertUser();
};
$('sens').onclick = e => { if (e.target.dataset.v) { profile.settings.sens = +e.target.dataset.v; applySettings(); persist(); } };
[['delay', 'delay'], ['repeat', 'repeat']].forEach(([id, k]) => $(id).onchange = e => { profile.settings[k] = +e.target.value; persist(); });
[['optNotify', 'notify'], ['optSound', 'sound'], ['optPreview', 'preview']].forEach(([id, k]) => $(id).onchange = e => { profile.settings[k] = e.target.checked; applySettings(); persist(); });

/* ---------------- start ---------------- */
$('name').value = localStorage.getItem('upright-user') || '';
listPeople();
if (!window.isSecureContext || !navigator.mediaDevices) fail(new Error('The camera needs a secure address: use http://localhost:8000 on the host Mac, or the https:// link on other devices.'));
