/* stillr — 画面操作・タイムライン・サウンド・書き出し */
(function () {
  'use strict';

  const MAX_ITEMS = 5;
  const FPS = 30;
  const BITRATE = 12000000;
  const AUDIO_FADE_IN = 0.5;
  const AUDIO_FADE_OUT = 1.5;

  // 雰囲気ごとの色調と、塵の色
  const MOODS = {
    print: {
      label: '銀塩プリント',
      sat: 0.82, contrast: 0.84,
      tint: [1.0, 0.995, 0.97], lift: [0.06, 0.07, 0.065], haze: [0.96, 0.95, 0.92, 0.06],
      pal: [[0.62, 0.70, 0.78], [1.0, 0.86, 0.62], [0.95, 0.55, 0.50]],
      dust: [1.0, 0.98, 0.95]
    },
    silence: {
      label: '静寂',
      sat: 0.0, contrast: 0.88,
      tint: [1.0, 1.0, 1.0], lift: [0.05, 0.05, 0.055], haze: [0.82, 0.82, 0.82, 0.10],
      pal: [[0.25, 0.25, 0.27], [0.75, 0.75, 0.75], [0.95, 0.94, 0.92]],
      dust: [0.9, 0.9, 0.9]
    },
    komorebi: {
      label: '木漏れ日',
      sat: 0.45, contrast: 0.85,
      tint: [1.04, 0.99, 0.90], lift: [0.06, 0.05, 0.035], haze: [0.98, 0.92, 0.82, 0.12],
      pal: [[0.55, 0.50, 0.45], [0.98, 0.88, 0.70], [0.90, 0.70, 0.55]],
      dust: [1.0, 0.95, 0.85]
    },
    dusk: {
      label: '薄明',
      sat: 0.75, contrast: 0.9,
      tint: [1.05, 0.96, 0.92], lift: [0.05, 0.035, 0.05], haze: [0.95, 0.75, 0.70, 0.08],
      pal: [[0.95, 0.55, 0.60], [0.98, 0.80, 0.45], [0.45, 0.40, 0.60]],
      dust: [1.0, 0.9, 0.85]
    },
    fog: {
      label: '霧',
      sat: 0.35, contrast: 0.8,
      tint: [0.95, 0.99, 1.04], lift: [0.08, 0.09, 0.10], haze: [0.82, 0.86, 0.90, 0.22],
      pal: [[0.60, 0.68, 0.75], [0.88, 0.90, 0.92], [0.50, 0.55, 0.62]],
      dust: [0.9, 0.95, 1.0]
    }
  };

  const state = {
    items: [],
    duration: 20,
    mood: 'print',
    abstract: 0.45,
    motion: 0.5,
    scratch: 0.3,
    dust: 0.35,
    speed: 0.5,
    seed: 1,
    time: 0,
    playing: false,
    exporting: false
  };

  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#stage');
  const statusEl = $('#status');
  let renderer;
  let nextId = 1;

  try {
    renderer = new window.StillrRenderer(canvas);
  } catch (e) {
    statusEl.textContent = e.message;
    return;
  }

  function notice(msg) {
    statusEl.textContent = msg;
  }

  // ---------- 素材 ----------

  const readyItems = () => state.items.filter((it) => it.ready);

  function addFiles(files) {
    for (const file of files) {
      if (isAudioFile(file)) {
        loadAudio(file);
        continue;
      }
      const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
      const isImage = file.type.startsWith('image/');
      if (!isVideo && !isImage) continue;
      if (state.items.length >= MAX_ITEMS) {
        notice('素材は5つまでです。');
        continue;
      }
      const item = { id: nextId++, name: file.name, kind: isVideo ? 'video' : 'image', ready: false };
      state.items.push(item);
      if (isVideo) loadVideo(file, item);
      else loadImage(file, item);
    }
    renderList();
  }

  function fail(item, msg) {
    removeItem(item);
    notice(msg);
  }

  function makeThumb(source, w, h) {
    const c = document.createElement('canvas');
    const s = 160 / Math.max(w, h);
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  function loadImage(file, item) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const scale = Math.min(1, 2048 / Math.min(nw, nh), renderer.maxTextureSize / Math.max(nw, nh));
      const c = document.createElement('canvas');
      c.width = Math.round(nw * scale);
      c.height = Math.round(nh * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      if (!state.items.includes(item)) return;
      item.w = c.width;
      item.h = c.height;
      item.tex = renderer.createTexture(c);
      item.thumb = makeThumb(c, c.width, c.height);
      item.ready = true;
      renderList();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      fail(item, `「${item.name}」を読み込めませんでした（HEIC は Safari でのみ読み込めます）。`);
    };
    img.src = url;
  }

  function loadVideo(file, item) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', () => {
      if (!state.items.includes(item)) return;
      item.el = v;
      item.url = url;
      item.w = v.videoWidth;
      item.h = v.videoHeight;
      item.tex = renderer.createTexture(v);
      item.thumb = makeThumb(v, v.videoWidth, v.videoHeight);
      item.ready = true;
      renderList();
    }, { once: true });
    v.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      v.remove();
      fail(item, `「${item.name}」を再生できませんでした。このブラウザが対応していない形式の可能性があります。`);
    }, { once: true });
    v.src = url;
    $('#videos').appendChild(v);
  }

  function removeItem(item) {
    const i = state.items.indexOf(item);
    if (i < 0) return;
    state.items.splice(i, 1);
    if (item.tex) renderer.deleteTexture(item.tex);
    if (item.el) {
      item.el.pause();
      item.el.remove();
    }
    if (item.url) URL.revokeObjectURL(item.url);
    renderList();
  }

  function moveItem(item, dir) {
    const i = state.items.indexOf(item);
    const j = i + dir;
    if (j < 0 || j >= state.items.length) return;
    state.items.splice(i, 1);
    state.items.splice(j, 0, item);
    renderList();
  }

  function renderList() {
    const list = $('#list');
    list.innerHTML = '';
    state.items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'media-item';
      li.innerHTML = `
        <div class="media-thumb">${item.thumb ? `<img src="${item.thumb}" alt="">` : ''}</div>
        <div class="media-info">
          <span class="media-name"></span>
          <span class="media-kind">${item.kind === 'video' ? '動画' : '写真'}${item.ready ? '' : '・読み込み中'}</span>
        </div>
        <div class="media-actions">
          <button type="button" data-act="up" aria-label="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" aria-label="下へ" ${i === state.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="remove" aria-label="削除">×</button>
        </div>`;
      li.querySelector('.media-name').textContent = item.name;
      li.querySelector('[data-act="up"]').onclick = () => moveItem(item, -1);
      li.querySelector('[data-act="down"]').onclick = () => moveItem(item, 1);
      li.querySelector('[data-act="remove"]').onclick = () => removeItem(item);
      list.appendChild(li);
    });
    $('#count').textContent = `${state.items.length} / ${MAX_ITEMS}`;
    $('#drop').classList.toggle('full', state.items.length >= MAX_ITEMS);
    $('#empty').hidden = readyItems().length > 0;
    $('#export').disabled = state.exporting || readyItems().length === 0;
  }

  // ---------- サウンドトラック ----------

  const audio = { ctx: null, gain: null, dest: null, buffer: null, name: '', source: null };

  function isAudioFile(file) {
    return file.type.startsWith('audio/') || /\.(wav|aif|aiff|mp3|m4a|aac)$/i.test(file.name);
  }

  function ensureAudioContext() {
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.gain = audio.ctx.createGain();
    audio.gain.connect(audio.ctx.destination);
    audio.dest = audio.ctx.createMediaStreamDestination();
    audio.gain.connect(audio.dest);
  }

  async function loadAudio(file) {
    ensureAudioContext();
    notice(`「${file.name}」を読み込み中…`);
    try {
      const data = await file.arrayBuffer();
      audio.buffer = await audio.ctx.decodeAudioData(data);
      audio.name = file.name;
      notice('');
      if (state.playing) startAudio(state.time);
    } catch (e) {
      notice(/\.aiff?$/i.test(file.name)
        ? `「${file.name}」を読み込めませんでした。AIFF は Safari でのみ読み込めます。Chrome では WAV か MP3 をお使いください。`
        : `「${file.name}」を読み込めませんでした。`);
    }
    renderAudio();
  }

  function removeAudio() {
    stopAudio();
    audio.buffer = null;
    audio.name = '';
    renderAudio();
  }

  // タイムラインの at 秒の位置から鳴らす。最後はフェードアウトする
  function startAudio(at) {
    stopAudio();
    if (!audio.buffer) return;
    const ctx = audio.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = audio.buffer;
    src.loop = true;
    src.connect(audio.gain);

    const now = ctx.currentTime;
    const remain = Math.max(0, state.duration - at);
    const g = audio.gain.gain;
    g.cancelScheduledValues(now);
    if (at < AUDIO_FADE_IN) {
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(1, now + AUDIO_FADE_IN - at);
    } else {
      g.setValueAtTime(1, now);
    }
    if (remain > AUDIO_FADE_OUT) g.setValueAtTime(1, now + remain - AUDIO_FADE_OUT);
    g.linearRampToValueAtTime(0, now + remain);

    src.start(now, at % audio.buffer.duration);
    src.stop(now + remain + 0.05);
    audio.source = src;
  }

  function stopAudio() {
    if (!audio.source) return;
    try {
      audio.source.stop();
    } catch (e) {
      // すでに停止済み
    }
    audio.source.disconnect();
    audio.source = null;
  }

  function renderAudio() {
    const box = $('#audio');
    box.hidden = !audio.buffer;
    if (!audio.buffer) return;
    $('#audio-name').textContent = audio.name;
    $('#audio-length').textContent = fmt(audio.buffer.duration);
  }

  // ---------- タイムライン ----------

  const smooth = (x) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  };

  // 時刻 t に映る素材（重なりの間は2つ）と、その重なり具合
  function timeline(t) {
    const list = readyItems();
    const n = list.length;
    if (!n) return { shots: [], mix: 0 };
    const D = state.duration;
    const seg = D / n;
    const fade = n > 1 ? Math.min(1.6, seg * 0.35) : 0;
    const shot = (k) => {
      const start = k * seg - (k > 0 ? fade / 2 : 0);
      const end = (k + 1) * seg + (k < n - 1 ? fade / 2 : 0);
      return { item: list[k], index: k, local: t - start, length: end - start };
    };
    const i = Math.min(n - 1, Math.max(0, Math.floor(t / seg)));
    const b = (i + 1) * seg;
    if (i < n - 1 && t > b - fade / 2) {
      return { shots: [shot(i), shot(i + 1)], mix: smooth((t - (b - fade / 2)) / fade) };
    }
    const a = i * seg;
    if (i > 0 && t < a + fade / 2) {
      return { shots: [shot(i - 1), shot(i)], mix: smooth((t - (a - fade / 2)) / fade) };
    }
    return { shots: [shot(i)], mix: 0 };
  }

  function rand(k, j) {
    const x = Math.sin(state.seed * 127.1 + k * 311.7 + j * 74.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // 9:16 の切り出し範囲。ゆっくり横に流れ、わずかに寄る（または引く）
  function framing(shot) {
    const { item, index, local, length } = shot;
    const oa = 9 / 16;
    const sa = item.w / item.h;
    const p = Math.min(1, Math.max(0, local / length));
    const zoomIn = rand(index, 1) > 0.5;
    const z = 1.03 + 0.04 * state.motion * (zoomIn ? p : 1 - p);
    const sx = Math.min(1, oa / sa) / z;
    const sy = Math.min(1, sa / oa) / z;
    const freeX = 1 - sx, freeY = 1 - sy;
    const dirX = rand(index, 2) > 0.5 ? 1 : -1;
    const dirY = rand(index, 3) > 0.5 ? 1 : -1;
    const spanX = Math.min(freeX * 0.9, 0.0055 * length * state.motion);
    const spanY = Math.min(freeY * 0.9, 0.003 * length * state.motion);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const cx = clamp(0.5 + (rand(index, 4) - 0.5) * freeX * 0.6 + dirX * spanX * (p - 0.5), sx / 2, 1 - sx / 2);
    const cy = clamp(0.5 + dirY * spanY * (p - 0.5), sy / 2, 1 - sy / 2);
    return [cx, cy, sx, sy];
  }

  // 映っている動画だけを再生し、タイムラインの位置に合わせる
  function syncVideos(shots) {
    const running = state.playing || state.exporting;
    for (const item of readyItems()) {
      if (item.kind !== 'video') continue;
      const v = item.el;
      const shot = shots.find((s) => s.item === item);
      v.playbackRate = state.speed;
      if (!shot) {
        if (!v.paused) v.pause();
        continue;
      }
      const target = (Math.max(0, shot.local) * state.speed) % (v.duration || 1);
      if (Math.abs(v.currentTime - target) > 0.5) v.currentTime = target;
      if (running && v.paused) v.play().catch(() => {});
      if (!running && !v.paused) v.pause();
    }
  }

  // ---------- 描画ループ ----------

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  let last = performance.now();
  let exportStart = 0;

  function draw() {
    const { shots, mix } = timeline(state.time);
    syncVideos(shots);
    for (const s of shots) {
      if (s.item.kind === 'video' && s.item.el.readyState >= 2) {
        renderer.updateTexture(s.item.tex, s.item.el);
      }
    }
    renderer.render({
      layers: shots.map((s) => ({ tex: s.item.tex, xf: framing(s) })),
      mix,
      abstract: state.abstract,
      time: state.time,
      seed: state.seed * 1.37,
      scratch: state.scratch,
      dust: state.dust,
      grain: 0.035,
      vignette: 0.22,
      look: MOODS[state.mood]
    });
  }

  function frame() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const D = state.duration;

    try {
      if (state.exporting) {
        state.time = Math.min(D, Math.max(0, (now - exportStart) / 1000));
      } else if (state.playing) {
        state.time += dt;
        if (state.time >= D) {
          state.time = 0;
          startAudio(0);
        }
      }
      state.time = Math.min(Math.max(0, state.time), D);

      draw();

      $('#time').textContent = `${fmt(state.time)} / ${fmt(D)}`;
      if (document.activeElement !== $('#scrub')) {
        $('#scrub').value = Math.round((state.time / D) * 1000);
      }
      if (state.exporting) {
        updateProgress(state.time / D);
        if (state.time >= D) finishExport();
      }
    } catch (e) {
      console.error(e);
      if (state.exporting) abortExport('書き出し中にエラーが起きました：' + e.message);
    } finally {
      requestAnimationFrame(frame);
    }
  }

  // ---------- 書き出し ----------

  let recorder = null;
  let chunks = [];
  let lastDownloadUrl = null;
  let stopTimer = 0;

  function pickMime(withAudio) {
    const types = withAudio
      ? [
        'video/mp4;codecs=avc1.640028,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm'
      ]
      : [
        'video/mp4;codecs=avc1.640028',
        'video/mp4;codecs=avc1',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm'
      ];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  }

  function updateProgress(ratio, label) {
    const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    $('#progress-bar').style.width = pct + '%';
    $('#progress-label').textContent = label || `書き出し中… ${pct}%`;
  }

  function startExport() {
    const withAudio = !!audio.buffer;
    const mime = pickMime(withAudio);
    if (!mime) {
      notice('このブラウザは動画の書き出しに対応していません。Chrome か Safari をお使いください。');
      return;
    }

    try {
      const stream = canvas.captureStream(FPS);
      if (withAudio) {
        ensureAudioContext();
        audio.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
    } catch (e) {
      notice('書き出しを開始できませんでした：' + e.message);
      return;
    }

    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => saveRecording(mime);
    recorder.onerror = (e) => {
      abortExport('書き出し中にエラーが起きました：' + (e.error ? e.error.message : '不明なエラー'));
    };

    state.playing = false;
    stopAudio();
    $('#download').hidden = true;
    notice(`このタブを表示したままお待ちください（約${state.duration}秒）。`);
    setExporting(true);
    updateProgress(0);

    state.time = 0;
    recorder.start(250);
    exportStart = performance.now();
    if (withAudio) startAudio(0);
  }

  function finishExport() {
    state.exporting = false;
    updateProgress(1, '仕上げ中…');
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      // stop イベントが来ない場合に備えて、集まったデータで保存する
      stopTimer = setTimeout(() => saveRecording(recorder.mimeType), 5000);
    } else {
      saveRecording(recorder ? recorder.mimeType : '');
    }
  }

  function abortExport(msg) {
    clearTimeout(stopTimer);
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorder = null;
    }
    stopAudio();
    state.time = 0;
    setExporting(false);
    notice(msg);
  }

  function saveRecording(mime) {
    clearTimeout(stopTimer);
    if (!recorder) return;
    recorder = null;
    stopAudio();
    state.time = 0;

    if (!chunks.length) {
      setExporting(false);
      notice('動画のデータを受け取れませんでした。もう一度お試しください。');
      return;
    }
    const type = (mime || 'video/mp4').split(';')[0];
    const ext = type === 'video/mp4' ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
    lastDownloadUrl = URL.createObjectURL(blob);

    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
    const a = $('#download');
    a.href = lastDownloadUrl;
    a.download = `stillr_${stamp}.${ext}`;
    a.hidden = false;

    setExporting(false);
    notice(ext === 'mp4'
      ? `書き出しが完了しました（${(blob.size / 1048576).toFixed(1)}MB）。`
      : '書き出しが完了しました（WebM 形式）。Instagram に投稿するには Chrome か Safari で MP4 を書き出してください。');
  }

  function setExporting(on) {
    state.exporting = on;
    document.body.classList.toggle('is-exporting', on);
    $('#progress').hidden = !on;
    document.querySelectorAll('.panel input, .panel button, #play, #scrub').forEach((el) => {
      el.disabled = on;
    });
    updatePlayButton();
    renderList();
  }

  // ---------- 操作 ----------

  function updatePlayButton() {
    $('#play').textContent = state.playing ? '停止' : '再生';
  }

  function setPlaying(on) {
    state.playing = on;
    if (on) {
      if (state.time >= state.duration) state.time = 0;
      startAudio(state.time);
    } else {
      stopAudio();
    }
    updatePlayButton();
  }

  function buildMoods() {
    const wrap = $('#mood');
    for (const [key, m] of Object.entries(MOODS)) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="mood" value="${key}"><span>${m.label}</span>`;
      const input = label.querySelector('input');
      input.checked = key === state.mood;
      input.onchange = () => {
        state.mood = key;
      };
      wrap.appendChild(label);
    }
  }

  function bindSliders() {
    document.querySelectorAll('.slider input').forEach((input) => {
      const key = input.dataset.key;
      const out = input.parentElement.querySelector('output');
      const apply = () => {
        const v = Number(input.value) / 100;
        if (key === 'speed') {
          state.speed = 0.25 + v * 0.75;
          out.textContent = `${state.speed.toFixed(2)}×`;
        } else {
          state[key] = v;
          out.textContent = input.value;
        }
      };
      input.oninput = apply;
      apply();
    });
  }

  function bind() {
    const drop = $('#drop');
    $('#file').onchange = (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    };
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!state.exporting) addFiles(e.dataTransfer.files);
    });
    // ドロップ先を外したときにブラウザがファイルを開かないようにする
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    $('#audio-file').onchange = (e) => {
      if (e.target.files[0]) loadAudio(e.target.files[0]);
      e.target.value = '';
    };
    $('#audio-remove').onclick = removeAudio;

    document.querySelectorAll('input[name="duration"]').forEach((input) => {
      input.checked = Number(input.value) === state.duration;
      input.onchange = () => {
        state.duration = Number(input.value);
        state.time = Math.min(state.time, state.duration);
        if (state.playing) startAudio(state.time);
      };
    });

    $('#shuffle').onclick = () => {
      state.seed = Math.floor(Math.random() * 1000) + 1;
    };

    $('#play').onclick = () => setPlaying(!state.playing);

    $('#scrub').oninput = (e) => {
      state.time = (Number(e.target.value) / 1000) * state.duration;
      if (state.playing) startAudio(state.time);
    };

    $('#export').onclick = startExport;
  }

  buildMoods();
  bindSliders();
  bind();
  renderList();
  renderAudio();
  requestAnimationFrame(frame);
})();
