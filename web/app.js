'use strict';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULTS = { sens: 0.5, delay: 20, repeat: 120, notify: true, sound: true, preview: true };
const COLORS = { good: '#16a37f', slouch: '#e5484d', away: '#94a3b8' };

let profile = null, stream = null, landmarker = null, ticker = null, audio = null;
let mode = 'idle';                      // idle | cal (calibrating) | mon (monitoring)
let cap = null, calStep = 0, calData = {}, tracker = null, lastLm = null, lastRun = 0, lastTs = 0;


/* ---------------- LANGUAGES + REMINDER MESSAGES ---------------- */
const I18N = {
  en: {
    whoTitle: 'Who’s sitting?', whoSub: 'Everyone gets their own profile and calibration.', namePh: 'Your name', go: 'Continue',
    stepN: 'Step {n} of 2', camOn: 'Turn on camera', starting: 'Starting…',
    s1t: 'Show me your best posture', s1b: 'Capture good posture',
    s1x: 'Sit the way you want to sit all day: back straight, shoulders relaxed, head over your shoulders. Keep your face and both shoulders in view.',
    s2t: 'Now slouch the way you usually do', s2b: 'Capture slouched posture',
    s2x: 'Let yourself sag: head forward, shoulders rounded. The clearer the difference, the better the detection.',
    seen: '✓ I can see your head and shoulders.', unseen: 'I can’t see you clearly. Keep your face and both shoulders in view.',
    fewFrames: 'I only saw you in a few frames. Check the lighting, keep your head and shoulders in view, and try again.',
    identical: 'Both postures looked identical to me. Slouch more clearly and try again.',
    weak: 'The two postures were hard to tell apart. Try Recalibrate with a bigger slouch.',
    paused: 'Paused', good: 'Sitting tall', slouch: 'Slouching', away: 'Can’t see you',
    subPaused: 'Press start. You can then switch to other apps; it keeps watching.',
    subSlouch: 'Slouching for {s}s', subRemind: ', reminder in {r}s', subAway: 'Step back into view to resume.', subGood: 'Nice posture.',
    gLo: 'Slouched', gHi: 'Upright', stGood: 'upright', stTime: 'monitored', stAlerts: 'reminders',
    start: 'Start monitoring', pause: 'Pause monitoring', sens: 'Sensitivity', sRel: 'Relaxed', sBal: 'Balanced', sStr: 'Strict',
    delayL: 'Remind me after slouching for', repeatL: 'Repeat reminder every',
    t10: '10 seconds', t20: '20 seconds', t30: '30 seconds', t60: '1 minute', t120: '2 minutes', t300: '5 minutes', t600: '10 minutes',
    optNotify: 'Desktop notifications', optSound: 'Chime', optPreview: 'Show camera preview',
    test: 'Test reminder', recal: 'Recalibrate', switch: 'Switch user', titleBad: '🔴 Sit up!',
    errSecure: 'The camera needs a secure address: use http://localhost:8000 on the host Mac, or the https:// link on other devices.',
    errModel: 'Pose model files are missing. Stop the server and run  python3 server.py  once while online.',
    errName: 'Use 1–24 letters, numbers, spaces or dashes for the name.',
    errBlocked: 'Camera access is blocked. Allow the camera for this site in your browser, and in macOS System Settings > Privacy & Security > Camera.',
    errNoCam: 'No camera was found.', errBusy: 'The camera is busy. Close other apps using it (Zoom, FaceTime…).' },
  id: {
    whoTitle: 'Siapa yang sedang duduk?', whoSub: 'Setiap orang memiliki profil dan kalibrasi masing-masing.', namePh: 'Nama Anda', go: 'Lanjutkan',
    stepN: 'Langkah {n} dari 2', camOn: 'Nyalakan kamera', starting: 'Memulai…',
    s1t: 'Tunjukkan postur terbaik Anda', s1b: 'Ambil postur tegak',
    s1x: 'Duduklah seperti yang Anda inginkan sepanjang hari: punggung tegak, bahu rileks, kepala di atas bahu. Pastikan wajah dan kedua bahu terlihat.',
    s2t: 'Sekarang membungkuklah seperti biasanya', s2b: 'Ambil postur membungkuk',
    s2x: 'Biarkan tubuh Anda melorot: kepala maju, bahu membulat. Semakin jelas perbedaannya, semakin baik deteksinya.',
    seen: '✓ Kepala dan bahu Anda terlihat.', unseen: 'Anda tidak terlihat dengan jelas. Pastikan wajah dan kedua bahu berada di dalam bingkai.',
    fewFrames: 'Anda hanya terlihat pada beberapa bingkai. Periksa pencahayaan, pastikan kepala dan bahu terlihat, lalu coba lagi.',
    identical: 'Kedua postur tampak identik. Membungkuklah lebih jelas, lalu coba lagi.',
    weak: 'Kedua postur sulit dibedakan. Coba kalibrasi ulang dengan membungkuk lebih jelas.',
    paused: 'Dijeda', good: 'Duduk tegak', slouch: 'Membungkuk', away: 'Tidak terlihat',
    subPaused: 'Tekan mulai. Setelah itu Anda dapat beralih ke aplikasi lain; pemantauan tetap berjalan.',
    subSlouch: 'Membungkuk selama {s} detik', subRemind: ', pengingat dalam {r} detik', subAway: 'Kembali ke depan kamera untuk melanjutkan.', subGood: 'Postur yang baik.',
    gLo: 'Membungkuk', gHi: 'Tegak', stGood: 'tegak', stTime: 'dipantau', stAlerts: 'pengingat',
    start: 'Mulai pemantauan', pause: 'Jeda pemantauan', sens: 'Sensitivitas', sRel: 'Santai', sBal: 'Seimbang', sStr: 'Ketat',
    delayL: 'Ingatkan setelah membungkuk selama', repeatL: 'Ulangi pengingat setiap',
    t10: '10 detik', t20: '20 detik', t30: '30 detik', t60: '1 menit', t120: '2 menit', t300: '5 menit', t600: '10 menit',
    optNotify: 'Notifikasi desktop', optSound: 'Bunyi lonceng', optPreview: 'Tampilkan pratinjau kamera',
    test: 'Uji pengingat', recal: 'Kalibrasi ulang', switch: 'Ganti pengguna', titleBad: '🔴 Duduk tegak!',
    errSecure: 'Kamera memerlukan alamat yang aman: gunakan http://localhost:8000 di Mac host, atau tautan https:// di perangkat lain.',
    errModel: 'File model pose tidak ditemukan. Hentikan server dan jalankan  python3 server.py  sekali saat terhubung ke internet.',
    errName: 'Gunakan 1–24 huruf, angka, spasi, atau tanda hubung untuk nama.',
    errBlocked: 'Akses kamera diblokir. Izinkan kamera untuk situs ini di browser, dan di Pengaturan Sistem macOS > Privasi & Keamanan > Kamera.',
    errNoCam: 'Kamera tidak ditemukan.', errBusy: 'Kamera sedang digunakan. Tutup aplikasi lain yang memakainya (Zoom, FaceTime…).' } };

// {name} becomes the profile name. "egg" messages pop up randomly (easter eggs); "late" after 11pm; five/ten at reminder #5 and #10.
const MSGS = {
  en: {
    normal: ['{name}, time to sit up tall.', 'Shoulders back, {name}. Head up.', 'Posture check, {name}: you’re slouching.',
             'Straighten up, {name}. Your spine will thank you.', 'Hey {name}, your back called. It wants a word.'],
    egg: ['{name}, you’re folding like a lawn chair.', 'Plot twist, {name}: you are not a shrimp. Be a giraffe.',
          'Beep boop. Spine drifting off course, {name}. Recalculating…', 'Fun fact, {name}: your future self is begging you to sit up.',
          '{name}, the chair is not a hammock.', 'Slouch detected. Dramatic sigh. Sit up, {name}.',
          'Your posture called, {name}. It said “help”.'],
    late: ['It’s late, {name}. Sit up straight, then go to bed.'],
    five: 'Reminder #5 already, {name}. Impressive commitment to slouching. Now sit up.',
    ten: '10 reminders, {name}! We need to talk about your chair.' },
  id: {
    normal: ['{name}, tegakkan badan dong, jangan loyo kayak cucian basah.', 'Woy {name}, punggungmu minta diperhatiin nih. Duduk yang bener ya!',
             '{name}, ini postur apa udang rebus? Yuk tegak lagi.', 'Cek postur: kamu lagi bungkuk, {name}. Sat set tegakkan!',
             'Bestie {name}, jangan mager ya. Tegak dikit dong.'],
    egg: ['{name}, kamu lagi jadi udang goreng nih. Balik jadi jerapah ya!', 'Tulang belakangmu lagi healing, tapi bukan gini caranya, {name}.',
          'Waduh {name}, bungkuknya udah level dewa. Tegak lagi gih.', 'Kursi itu bukan kasur, {name}. Duduk yang tegak, jangan rebahan.',
          'Spill: kamu di masa depan mohon-mohon biar kamu duduk tegak, {name}.',
          '{name}, jangan kayak sinyal di pelosok: makin lama makin turun. Naikin lagi!', 'Gaskeun tegak, {name}! Pinggangmu belum mau pensiun dini.'],
    late: ['Udah malem nih, {name}. Tegak dulu, abis itu tidur ya, jangan begadang.'],
    five: 'Udah 5 kali diingetin nih, {name}. Capek kan aku? Yuk tegak beneran.',
    ten: '10 kali, {name}! Kita perlu ngobrol soal kursi kamu.' } };

let lang = localStorage.getItem('upright-lang') || ((navigator.language || '').startsWith('id') ? 'id' : 'en'), lastMsg = '';
const t = (k, v = {}) => (I18N[lang][k] ?? I18N.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(e => e.textContent = t(e.dataset.i18n));
  $('name').placeholder = t('namePh');
  document.querySelectorAll('.lang button').forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  if (!$('s-cal').classList.contains('hidden') && !cap && !$('calBtn').disabled) showStep();
  if (profile && !$('s-mon').classList.contains('hidden')) render();
}
function setLang(l) {
  lang = l; localStorage.setItem('upright-lang', l);
  if (profile) { profile.settings.lang = l; persist(); }
  applyLang();
}
function pickMsg() {
  const M = MSGS[lang], n = tracker.alerts, h = new Date().getHours();
  let pool = M.normal;
  if (n === 5) pool = [M.five]; else if (n === 10) pool = [M.ten];
  else if ((h >= 23 || h < 4) && Math.random() < 0.4) pool = M.late;
  else if (Math.random() < 0.25) pool = M.egg;
  let msg, tries = 0;
  do { msg = pool[Math.random() * pool.length | 0]; } while (msg === lastMsg && pool.length > 1 && ++tries < 5);
  return (lastMsg = msg).replace(/\{name\}/g, profile.name);
}

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
  if (!window.isSecureContext || !navigator.mediaDevices) throw new Error(t('errSecure'));
  if (!stream) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    for (const id of ['engine', 'v1', 'v2']) { $(id).srcObject = stream; $(id).play().catch(() => {}); }
    $('engine').onloadedmetadata = () => document.querySelectorAll('.stage').forEach(s => s.style.aspectRatio = $('engine').videoWidth + '/' + $('engine').videoHeight);
  }
  if (!landmarker) {
    let lib;
    try { lib = await import('/vendor/vision_bundle.mjs'); }
    catch (e) { throw new Error(t('errModel')); }
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
const STEPS = [{ key: 'good', k: 's1' }, { key: 'slouch', k: 's2' }];

function show(id) { ['s-profile', 's-cal', 's-mon'].forEach(x => $(x).classList.toggle('hidden', x !== id)); }
function startCal() {
  mode = stream && landmarker ? 'cal' : 'idle'; calStep = 0; calData = {}; cap = null; show('s-cal'); showStep();
}
function showStep() {
  const s = STEPS[calStep];
  $('step').textContent = t('stepN', { n: calStep + 1 }); $('calTitle').textContent = t(s.k + 't'); $('calText').textContent = t(s.k + 'x');
  $('calBtn').textContent = stream && landmarker ? t(s.k + 'b') : t('camOn'); $('calBtn').disabled = false; $('calBar').style.width = '0';
}
function calFrame(f) {
  draw($('c1'), f ? COLORS.good : '#f59e0b');
  if (!cap) { $('calMsg').textContent = t(f ? 'seen' : 'unseen'); return; }
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
  if (s.length < 12) { $('calErr').textContent = t('fewFrames'); $('calBtn').disabled = false; return; }
  calData[STEPS[calStep].key] = s;
  if (++calStep < STEPS.length) return showStep();
  let model;
  try { model = buildModel(calData.good, calData.slouch); }
  catch (e) { calStep = 1; showStep(); $('calErr').textContent = t('identical'); return; }
  const q = 1 / (sdv(calData.good.map(f => score(model, f))) + sdv(calData.slouch.map(f => score(model, f))) + 1e-6);
  profile.calib = { model, quality: q };
  persist(); showMon();
  if (q < 2.5) flash(t('weak'));
}

/* ---------------- 5. MONITORING + REMINDERS ---------------- */
function showMon() { mode = 'idle'; show('s-mon'); applySettings(); render(); }
function monFrame(f, now) {
  if (!profile?.calib) return;
  const fire = advance(tracker, now, f ? score(profile.calib.model, f) : null, profile.settings);
  if (fire) alertUser();
  render();
  if (profile.settings.preview) draw($('c2'), COLORS[tracker.state]);
}
function render() {
  const tr = tracker || newTracker(), s = profile.settings, on = mode === 'mon';
  const st = !on ? 'idle' : tr.state === 'slouch' ? 'bad' : tr.state === 'good' ? 'good' : 'away';
  document.body.dataset.state = st;
  $('status').textContent = t(!on ? 'paused' : tr.state);
  const secs = Math.round((performance.now() - tr.since) / 1000);
  $('sub').textContent = !on ? t('subPaused')
    : tr.state === 'slouch' ? t('subSlouch', { s: secs }) + (secs < s.delay ? t('subRemind', { r: s.delay - secs }) : '')
    : tr.state === 'away' ? t('subAway') : t('subGood');
  $('gFill').style.width = on && tr.smooth !== null ? Math.max(0, Math.min(1, 1 - tr.smooth)) * 100 + '%' : '0';
  $('gTick').style.left = (1 - s.sens) * 100 + '%';
  $('stGood').textContent = tr.mon > 0 ? Math.round(100 * tr.goodT / tr.mon) + '%' : '–';
  $('stTime').textContent = Math.floor(tr.mon / 60) + 'm'; $('stAlerts').textContent = tr.alerts;
  $('toggle').textContent = t(on ? 'pause' : 'start');
  document.title = st === 'bad' ? t('titleBad') + ' · Upright' : st === 'good' ? '🟢 Upright' : 'Upright';
  $('icon').href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='5' fill='${{ bad: COLORS.slouch, good: COLORS.good }[st] || COLORS.away}'/></svg>`);
}
function flash(msg) { $('banner').textContent = msg; $('banner').classList.remove('hidden'); setTimeout(() => $('banner').classList.add('hidden'), 8000); }
function alertUser() {
  const msg = pickMsg(), s = profile.settings;
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
  if (!/^[\p{L}\p{N}_\- ]{1,24}$/u.test(name)) return fail(new Error(t('errName')));
  unlockAudio();
  const r = await fetch('/api/profiles/' + encodeURIComponent(slug(name)));
  profile = r.ok ? await r.json() : { name, settings: {}, calib: null };
  profile.settings = { ...DEFAULTS, lang, ...profile.settings };
  if (I18N[profile.settings.lang]) { lang = profile.settings.lang; localStorage.setItem('upright-lang', lang); } applyLang();
  localStorage.setItem('upright-user', name); $('who').textContent = name;
  tracker = newTracker();
  profile.calib ? showMon() : startCal();
}
async function listPeople() {
  const list = await fetch('/api/profiles').then(r => r.json()).catch(() => []);
  $('people').replaceChildren(...list.map(p => { const b = document.createElement('button'); b.textContent = p.name; b.onclick = () => guard(openProfile)(p.name); return b; }));
}
function fail(e) {
  const known = { NotAllowedError: t('errBlocked'), NotFoundError: t('errNoCam'), NotReadableError: t('errBusy') };
  $('error').textContent = known[e.name] || e.message || String(e); $('error').classList.remove('hidden');
}
const guard = fn => async (...a) => { try { $('error').classList.add('hidden'); await fn(...a); } catch (e) { console.error(e); fail(e); $('calBtn').disabled = false; } };

$('go').onclick = guard(() => openProfile($('name').value));
$('name').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
$('calBtn').onclick = guard(async () => {
  unlockAudio();
  if (!stream || !landmarker) {
    $('calBtn').disabled = true; $('calBtn').textContent = t('starting');
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
document.querySelectorAll('.lang button').forEach(b => b.onclick = () => setLang(b.dataset.lang));
applyLang();
listPeople();
if (!window.isSecureContext || !navigator.mediaDevices) fail(new Error(t('errSecure')));
