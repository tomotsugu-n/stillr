/* stillr — 画面操作・タイムライン・サウンド・書き出し */
(function () {
  'use strict';

  const MAX_ITEMS = 10;
  const FPS = 30;
  const BITRATE = 12000000;
  const AUDIO_FADE = 1.5;

  // 雰囲気ごとの色調と、塵の色
  const MOODS = {
    print: {
      label: 'Silver Print',
      sat: 0.82, contrast: 0.84,
      tint: [1.0, 0.995, 0.97], lift: [0.06, 0.07, 0.065], haze: [0.96, 0.95, 0.92, 0.06],
      pal: [[0.62, 0.70, 0.78], [1.0, 0.86, 0.62], [0.95, 0.55, 0.50]],
      dust: [1.0, 0.98, 0.95]
    },
    silence: {
      label: 'Silence',
      sat: 0.0, contrast: 0.88,
      tint: [1.0, 1.0, 1.0], lift: [0.05, 0.05, 0.055], haze: [0.82, 0.82, 0.82, 0.10],
      pal: [[0.25, 0.25, 0.27], [0.75, 0.75, 0.75], [0.95, 0.94, 0.92]],
      dust: [0.9, 0.9, 0.9]
    },
    komorebi: {
      label: 'Dappled Light',
      sat: 0.45, contrast: 0.85,
      tint: [1.04, 0.99, 0.90], lift: [0.06, 0.05, 0.035], haze: [0.98, 0.92, 0.82, 0.12],
      pal: [[0.55, 0.50, 0.45], [0.98, 0.88, 0.70], [0.90, 0.70, 0.55]],
      dust: [1.0, 0.95, 0.85]
    },
    dusk: {
      label: 'Twilight',
      sat: 0.75, contrast: 0.9,
      tint: [1.05, 0.96, 0.92], lift: [0.05, 0.035, 0.05], haze: [0.95, 0.75, 0.70, 0.08],
      pal: [[0.95, 0.55, 0.60], [0.98, 0.80, 0.45], [0.45, 0.40, 0.60]],
      dust: [1.0, 0.9, 0.85]
    },
    fog: {
      label: 'Fog',
      sat: 0.35, contrast: 0.8,
      tint: [0.95, 0.99, 1.04], lift: [0.08, 0.09, 0.10], haze: [0.82, 0.86, 0.90, 0.22],
      pal: [[0.60, 0.68, 0.75], [0.88, 0.90, 0.92], [0.50, 0.55, 0.62]],
      dust: [0.9, 0.95, 1.0]
    }
  };

  const state = {
    items: [],
    duration: 30,
    mood: 'komorebi',
    abstract: 0.15,
    motion: 0.5,
    scratch: 0.6,
    dust: 0.35,
    speed: 0.5,
    fadeIn: false,
    master: 'off',   // 簡易マスタリング：'off' / '-6' / '-12'（ピークをこの dBFS にそろえる）
    fadeOut: true,
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
        notice(`You can add up to ${MAX_ITEMS} media files.`);
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
      item.src = c;
      item.thumb = makeThumb(c, c.width, c.height);
      item.ready = true;
      renderList();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      fail(item, `Couldn't load "${item.name}". (HEIC images load in Safari only.)`);
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
      fail(item, `Couldn't play "${item.name}". This browser may not support the format.`);
    }, { once: true });
    v.src = url;
    $('#videos').appendChild(v);
  }

  function removeItem(item) {
    const i = state.items.indexOf(item);
    if (i < 0) return;
    if (framer.item === item) closeFramer();
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
      li.classList.toggle('is-framing', framer.item === item);
      li.innerHTML = `
        <div class="media-thumb">${item.thumb ? `<img src="${item.thumb}" alt="">` : ''}</div>
        <div class="media-info">
          <span class="media-name"></span>
          <span class="media-kind">${item.kind === 'video' ? 'Video' : 'Photo'}${item.ready ? '' : ' · Loading'}${item.frame ? ' · Framed' : ''}</span>
        </div>
        <div class="media-actions">
          ${canFrame(item) ? `<button type="button" data-act="frame" aria-label="Set framing" title="Set framing" aria-pressed="${framer.item === item}">⇔</button>` : ''}
          <button type="button" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" aria-label="Move down" ${i === state.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="remove" aria-label="Remove">×</button>
        </div>`;
      li.querySelector('.media-name').textContent = item.name;
      li.querySelector('[data-act="up"]').onclick = () => moveItem(item, -1);
      li.querySelector('[data-act="down"]').onclick = () => moveItem(item, 1);
      li.querySelector('[data-act="remove"]').onclick = () => removeItem(item);
      const frameBtn = li.querySelector('[data-act="frame"]');
      if (frameBtn) frameBtn.onclick = () => (framer.item === item ? closeFramer() : openFramer(item));
      list.appendChild(li);
    });
    updateCount();
    $('#drop').classList.toggle('full', state.items.length >= MAX_ITEMS);
    $('#empty').hidden = readyItems().length > 0;
    document.querySelector('.stage').classList.toggle('is-empty', readyItems().length === 0);
    $('#export').disabled = state.exporting || readyItems().length === 0;
  }

  function updateCount() {
    $('#count').textContent = `${state.items.length} / ${MAX_ITEMS}${audio.buffer ? ' + soundtrack' : ''}`;
  }

  // ---------- サウンドトラック ----------

  // offset: 曲のどこから使うか（秒）。peaks: 波形表示用の振幅
  const audio = { ctx: null, gain: null, dest: null, buffer: null, name: '', source: null, offset: 0, peaks: null };

  function isAudioFile(file) {
    return file.type.startsWith('audio/') || /\.(wav|aif|aiff|mp3|m4a|aac)$/i.test(file.name);
  }

  function ensureAudioContext() {
    if (audio.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx();
    audio.gain = audio.ctx.createGain();
    audio.gain.connect(audio.ctx.destination);
    // 音量をそろえる段（フェード用の gain の手前）
    audio.master = audio.ctx.createGain();
    audio.master.connect(audio.gain);
    audio.dest = audio.ctx.createMediaStreamDestination();
    audio.gain.connect(audio.dest);
  }

  // AIFF / AIFF-C（非圧縮）を自前で読み込む。Chrome などブラウザが AIFF を読めない場合に使う
  function decodeAiff(data) {
    const view = new DataView(data);
    const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    if (data.byteLength < 12 || tag(0) !== 'FORM' || !/^AIF[FC]$/.test(tag(8))) return null;

    let channels = 0, frames = 0, bits = 0, rate = 0, codec = 'NONE', soundOffset = -1;
    let o = 12;
    while (o + 8 <= data.byteLength) {
      const id = tag(o);
      const size = view.getUint32(o + 4);
      const body = o + 8;
      if (id === 'COMM') {
        channels = view.getInt16(body);
        frames = view.getUint32(body + 2);
        bits = view.getInt16(body + 6);
        // 80ビット拡張精度の浮動小数点数
        const exp = view.getUint16(body + 8) & 0x7fff;
        const mant = view.getUint32(body + 10) * 2 ** 32 + view.getUint32(body + 14);
        rate = mant * 2 ** (exp - 16383 - 63);
        if (size >= 22) codec = tag(body + 18);
      } else if (id === 'SSND') {
        soundOffset = body + 8 + view.getUint32(body);
      }
      o = body + size + (size % 2);
    }
    if (!channels || !frames || !rate || soundOffset < 0) return null;

    const read = {
      NONE: [Math.ceil(bits / 8), (p, n) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + view.getUint8(p + i);
        const max = 2 ** (n * 8);
        return (v >= max / 2 ? v - max : v) / (max / 2);
      }],
      sowt: [Math.ceil(bits / 8), (p, n) => {
        let v = 0;
        for (let i = n - 1; i >= 0; i--) v = v * 256 + view.getUint8(p + i);
        const max = 2 ** (n * 8);
        return (v >= max / 2 ? v - max : v) / (max / 2);
      }],
      fl32: [4, (p) => view.getFloat32(p)],
      FL32: [4, (p) => view.getFloat32(p)],
      fl64: [8, (p) => view.getFloat64(p)],
      FL64: [8, (p) => view.getFloat64(p)]
    }[codec];
    if (!read) return null;

    const [bytes, sample] = read;
    const avail = Math.floor((data.byteLength - soundOffset) / (bytes * channels));
    const length = Math.min(frames, avail);
    const buffer = audio.ctx.createBuffer(channels, length, rate);
    for (let ch = 0; ch < channels; ch++) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        out[i] = sample(soundOffset + (i * channels + ch) * bytes, bytes);
      }
    }
    return buffer;
  }

  async function decodeAudioFile(data) {
    const aiff = decodeAiff(data);
    if (aiff) return aiff;
    return audio.ctx.decodeAudioData(data);
  }

  async function loadAudio(file) {
    ensureAudioContext();
    const replacing = !!audio.buffer;
    notice(`Loading "${file.name}"…`);
    try {
      const data = await file.arrayBuffer();
      audio.buffer = await decodeAudioFile(data);
      audio.name = file.name;
      audio.offset = 0;
      audio.peaks = computePeaks(audio.buffer, 300);
      audio.peak = peakOf(audio.buffer);
      applyMaster();
      notice(replacing ? `Replaced the soundtrack with "${file.name}".` : '');
      if (state.playing) startAudio(state.time);
    } catch (e) {
      notice(`Couldn't load "${file.name}". Try a WAV, MP3 or uncompressed AIFF file.`);
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
    src.connect(audio.master);

    const now = ctx.currentTime;
    const remain = Math.max(0, state.duration - at);
    const g = audio.gain.gain;
    g.cancelScheduledValues(now);
    if (state.fadeIn && at < AUDIO_FADE) {
      g.setValueAtTime(at / AUDIO_FADE, now);
      g.linearRampToValueAtTime(1, now + AUDIO_FADE - at);
    } else {
      g.setValueAtTime(1, now);
    }
    if (state.fadeOut) {
      if (remain > AUDIO_FADE) g.setValueAtTime(1, now + remain - AUDIO_FADE);
      g.linearRampToValueAtTime(0, now + remain);
    }

    src.start(now, (audio.offset + at) % audio.buffer.duration);
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
    const has = !!audio.buffer;
    $('#audio').hidden = !has;
    $('#fades').hidden = !has;
    $('#wave').hidden = !has;
    $('#master').hidden = !has;
    $('#wave-range').hidden = !has;
    $('#audio-empty').hidden = has;
    updateCount();
    if (!has) return;
    $('#audio-name').textContent = audio.name;
    $('#audio-length').textContent = fmt(audio.buffer.duration);
    drawWave();
    layoutWave();
  }

  // ---------- サウンドトラックの使う範囲 ----------

  function peakOf(buffer) {
    let max = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > max) max = v;
      }
    }
    return max;
  }

  // 簡易マスタリング：曲全体のピークが指定の dBFS になるよう音量を上げ下げする
  function applyMaster() {
    if (!audio.master) return;
    const target = Number(state.master);
    audio.master.gain.value = state.master === 'off' || !audio.peak
      ? 1
      : Math.pow(10, target / 20) / audio.peak;
  }

  function computePeaks(buffer, bins) {
    const peaks = new Float32Array(bins);
    const step = buffer.length / bins;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let b = 0; b < bins; b++) {
        const from = Math.floor(b * step), to = Math.floor((b + 1) * step);
        let max = peaks[b];
        // 長い曲でも重くならないよう間引いて調べる
        for (let i = from; i < to; i += 16) {
          const v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        peaks[b] = max;
      }
    }
    return peaks;
  }

  // 使える最大の開始位置。曲がリールより短ければ 0（繰り返して使う）
  const maxOffset = () => (audio.buffer ? Math.max(0, audio.buffer.duration - state.duration) : 0);

  function drawWave() {
    const c = $('#wave-canvas');
    if (!audio.peaks || !c.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    const g = c.getContext('2d');
    const peaks = audio.peaks;
    const top = Math.max(...peaks) || 1;
    const bw = c.width / peaks.length;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = getComputedStyle(c).color;
    peaks.forEach((v, i) => {
      const h = Math.max(dpr, (v / top) * c.height * 0.9);
      g.fillRect(i * bw, (c.height - h) / 2, Math.max(dpr, bw - dpr), h);
    });
  }

  function layoutWave() {
    if (!audio.buffer) return;
    audio.offset = Math.min(audio.offset, maxOffset());
    const total = audio.buffer.duration;
    const win = $('#wave-win');
    win.style.left = `${(audio.offset / total) * 100}%`;
    win.style.width = `${Math.min(1, state.duration / total) * 100}%`;
    const end = Math.min(total, audio.offset + state.duration);
    $('#wave-range').textContent = total > state.duration
      ? `Uses ${fmt(audio.offset)} – ${fmt(end)}`
      : `Loops from the start (the track is shorter than the reel)`;
  }

  // 再生位置を波形の上に示す
  function updateWaveHead() {
    const head = $('#wave-head');
    if (!audio.buffer) return;
    const on = state.playing || state.exporting;
    head.hidden = !on;
    if (on) head.style.left = `${(((audio.offset + state.time) % audio.buffer.duration) / audio.buffer.duration) * 100}%`;
  }

  function bindMaster() {
    document.querySelectorAll('input[name="master"]').forEach((input) => {
      input.checked = input.value === state.master;
      input.onchange = () => {
        state.master = input.value;
        applyMaster();
      };
    });
  }

  // プレビューを頭から描き直す。素材の映像を読み直し、動画の位置も合わせ直す
  function refreshPreview() {
    if (state.exporting) return;
    closeFramer();
    setPlaying(false);
    state.time = 0;
    for (const item of readyItems()) {
      if (item.kind === 'video') {
        item.el.pause();
        item.el.currentTime = 0;
        item.el.addEventListener('seeked', () => renderer.updateTexture(item.tex, item.el), { once: true });
      } else if (item.src) {
        renderer.updateTexture(item.tex, item.src);
      }
    }
    renderList();
  }

  function bindWave() {
    const wave = $('#wave');
    wave.addEventListener('pointerdown', (e) => {
      if (!audio.buffer || state.exporting) return;
      e.preventDefault();
      wave.setPointerCapture(e.pointerId);
      const rect = wave.getBoundingClientRect();
      const total = audio.buffer.duration;
      const toSec = (x) => ((x - rect.left) / rect.width) * total;
      // 枠の外を押したら、そこを中心に枠を移す
      const winRect = $('#wave-win').getBoundingClientRect();
      if (e.clientX < winRect.left || e.clientX > winRect.right) {
        audio.offset = Math.min(maxOffset(), Math.max(0, toSec(e.clientX) - state.duration / 2));
        layoutWave();
      }
      const from = audio.offset;
      const x0 = e.clientX;
      wave.classList.add('dragging');
      const move = (ev) => {
        audio.offset = Math.min(maxOffset(), Math.max(0, from + ((ev.clientX - x0) / rect.width) * total));
        layoutWave();
      };
      const up = () => {
        wave.classList.remove('dragging');
        wave.removeEventListener('pointermove', move);
        wave.removeEventListener('pointerup', up);
        wave.removeEventListener('pointercancel', up);
        if (state.playing) startAudio(state.time);
      };
      wave.addEventListener('pointermove', move);
      wave.addEventListener('pointerup', up);
      wave.addEventListener('pointercancel', up);
    });
  }

  // ---------- タイムライン ----------

  const smooth = (x) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  };

  // 時刻 t に映る素材（重なりの間は2つ）と、その重なり具合
  // k 番目の素材が映る区間（重なりを含む）
  function shotSpan(k, n) {
    const seg = state.duration / n;
    const fade = n > 1 ? Math.min(1.6, seg * 0.35) : 0;
    const start = k * seg - (k > 0 ? fade / 2 : 0);
    const end = (k + 1) * seg + (k < n - 1 ? fade / 2 : 0);
    return { start, length: end - start };
  }

  function timeline(t) {
    const list = readyItems();
    const n = list.length;
    if (!n) return { shots: [], mix: 0 };
    const D = state.duration;
    const seg = D / n;
    const fade = n > 1 ? Math.min(1.6, seg * 0.35) : 0;
    const shot = (k) => {
      const { start, length } = shotSpan(k, n);
      return { item: list[k], index: k, local: t - start, length };
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

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // 構図を指定するときの上限
  const MAX_PAN_SPEED = 0.06;  // 始点→終点の移動：1秒あたり、枠の幅の何倍まで動かせるか
  const MAX_ZOOM = 2;          // 枠をどこまで縮められるか（2 = 幅・高さとも半分まで）

  // 構図を指定していないときの寄り（始点 → 終点）。ゆっくり引いていく
  const AUTO_ZOOM_START = 1.05;
  const AUTO_ZOOM_END = 1.0;

  // 9:16 の切り出し範囲。ゆっくり横に流れ、わずかに寄る（または引く）
  // 構図が指定されていれば、それに従う（写真は始点→終点へ移動・拡大縮小、動画は固定）
  function framing(shot, auto) {
    const { item, index, local, length } = shot;
    const p = Math.min(1, Math.max(0, local / length));
    if (!auto && item.frame) return customFraming(item, length, p);
    const oa = 9 / 16;
    const sa = item.w / item.h;
    const z = AUTO_ZOOM_START + (AUTO_ZOOM_END - AUTO_ZOOM_START) * p;
    const sx = Math.min(1, oa / sa) / z;
    const sy = Math.min(1, sa / oa) / z;
    const freeX = 1 - sx, freeY = 1 - sy;
    const dirX = rand(index, 2) > 0.5 ? 1 : -1;
    const dirY = rand(index, 3) > 0.5 ? 1 : -1;
    const spanX = Math.min(freeX * 0.9, 0.0055 * length * state.motion);
    const spanY = Math.min(freeY * 0.9, 0.003 * length * state.motion);
    const cx = clamp(0.5 + (rand(index, 4) - 0.5) * freeX * 0.6 + dirX * spanX * (p - 0.5), sx / 2, 1 - sx / 2);
    const cy = clamp(0.5 + dirY * spanY * (p - 0.5), sy / 2, 1 - sy / 2);
    return [cx, cy, sx, sy];
  }

  // ---------- 構図の指定（横長の素材） ----------
  // item.frame = { start: { x, y, z }, end: { x, y, z } }
  //   x, y: 枠の中心（素材に対する割合）、z: 寄り（1 = 素材の高さいっぱい）

  const framer = { item: null };

  // 動画は縦長でも寄り（切り出す大きさ）を選べる。写真は横長のときだけ
  const canFrame = (item) => item.ready && (item.kind === 'video' || item.w / item.h > 9 / 16 + 0.01);

  // 寄り 1 のときの枠の大きさ（素材に対する割合）
  function baseSize(item) {
    const oa = 9 / 16, sa = item.w / item.h;
    return [Math.min(1, oa / sa), Math.min(1, sa / oa)];
  }

  // 枠が素材からはみ出さないように中心を収める
  function fit(item, k) {
    const [bw, bh] = baseSize(item);
    const z = clamp(k.z, 1, MAX_ZOOM);
    const w = bw / z, h = bh / z;
    return { x: clamp(k.x, w / 2, 1 - w / 2), y: clamp(k.y, h / 2, 1 - h / 2), z };
  }

  // 始点と終点の距離の上限（素材の幅に対する割合）
  function maxPan(item, length) {
    return baseSize(item)[0] * MAX_PAN_SPEED * length;
  }

  // to を from から上限の距離までに収める
  function limitTo(item, from, to, length) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const d = Math.hypot(dx, dy * item.h / item.w);
    const max = maxPan(item, length);
    if (d <= max) return to;
    const r = max / d;
    return { ...to, x: from.x + dx * r, y: from.y + dy * r };
  }

  function customFraming(item, length, p) {
    const [bw, bh] = baseSize(item);
    const a = fit(item, item.frame.start);
    const b = item.kind === 'video' ? a : fit(item, limitTo(item, a, item.frame.end, length));
    const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * p);
    const sx = bw / z, sy = bh / z;
    const cx = clamp(a.x + (b.x - a.x) * p, sx / 2, 1 - sx / 2);
    const cy = clamp(a.y + (b.y - a.y) * p, sy / 2, 1 - sy / 2);
    // テクスチャは上下が反転している（下が 0）ので、画面の上下（上が 0）から変換する
    return [cx, 1 - cy, sx, sy];
  }

  function shotOf(item) {
    const list = readyItems();
    const index = list.indexOf(item);
    return { item, index, ...shotSpan(index, list.length) };
  }

  // 表示・編集用の始点と終点。指定がなければ自動の構図から作る
  function currentFrame(item) {
    const s = shotOf(item);
    if (item.frame) {
      const a = fit(item, item.frame.start);
      const b = item.kind === 'video' ? a : fit(item, limitTo(item, a, item.frame.end, s.length));
      return { start: a, end: b };
    }
    const bw = baseSize(item)[0];
    const at = (local) => {
      const [x, y, sx] = framing({ ...s, local }, true);
      return { x, y: 1 - y, z: bw / sx };
    };
    if (item.kind === 'video') {
      const k = at(s.length / 2);
      return { start: k, end: k };
    }
    return { start: at(0), end: at(s.length) };
  }

  function paintFramer() {
    const item = framer.item;
    if (!item) return;
    const src = item.kind === 'video' ? item.el : item.src;
    if (item.kind === 'video' && item.el.readyState < 2) return;
    const c = $('#framer-canvas');
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  }

  // 素材の全体が、下の案内とボタンを残してプレビュー欄に収まる大きさにする
  function sizeFramer() {
    const item = framer.item;
    if (!item) return;
    const box = $('#framer').getBoundingClientRect();
    const controls = $('#framer-hint').offsetHeight + $('.framer-actions').offsetHeight + 28 + 24;
    const width = Math.min(box.width, Math.max(0, box.height - controls) * item.w / item.h);
    $('#framer-view').style.width = `${width}px`;
  }

  function layoutFramer() {
    const item = framer.item;
    if (!item) return;
    const f = currentFrame(item);
    const [bw, bh] = baseSize(item);
    const pct = (v) => `${(v * 100).toFixed(3)}%`;
    document.querySelectorAll('.framer-win').forEach((el) => {
      const k = f[el.dataset.key];
      const w = bw / k.z, h = bh / k.z;
      el.style.left = pct(k.x - w / 2);
      el.style.top = pct(k.y - h / 2);
      el.style.width = pct(w);
      el.style.height = pct(h);
      el.querySelector('.framer-zoom').textContent = k.z > 1.005 ? ` ${k.z.toFixed(2)}×` : '';
    });
    // 始点の中心から終点の中心への矢印
    const path = $('#framer-path');
    const rect = $('#framer-view').getBoundingClientRect();
    const x0 = f.start.x * rect.width, y0 = f.start.y * rect.height;
    const dx = (f.end.x - f.start.x) * rect.width, dy = (f.end.y - f.start.y) * rect.height;
    const len = Math.hypot(dx, dy);
    path.hidden = item.kind === 'video' || len < 4;
    path.style.left = `${x0}px`;
    path.style.top = `${y0}px`;
    path.style.width = `${len}px`;
    path.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  }

  function openFramer(item) {
    if (state.exporting || !canFrame(item)) return;
    setPlaying(false);
    framer.item = item;
    const isVideo = item.kind === 'video';
    const c = $('#framer-canvas');
    const scale = Math.min(1, 1080 / item.w);
    c.width = Math.round(item.w * scale);
    c.height = Math.round(item.h * scale);
    $('.framer-win.start .framer-label').textContent = isVideo ? 'Frame' : 'Start';
    $('.framer-win.end').hidden = isVideo;
    $('#framer-hint').textContent = isVideo
      ? 'Drag the frame to set the crop. Drag its corner to zoom in.'
      : 'Drag Start and End to set the pan. Shift-drag to move both. Drag a corner to zoom in.';
    // 背後のプレビューもこの素材の場面に合わせておく
    const s = shotOf(item);
    state.time = Math.min(state.duration, Math.max(0, s.start + s.length / 2));
    $('#framer').hidden = false;
    sizeFramer();
    $('#framer-reset').disabled = !item.frame;
    paintFramer();
    layoutFramer();
    renderList();
  }

  function closeFramer() {
    if (!framer.item) return;
    framer.item = null;
    $('#framer').hidden = true;
    renderList();
  }

  // 片方の枠を変えたあとの構図。写真は、動かしていない側から上限の距離までに収める
  function setFrameKey(item, key, k) {
    const f = currentFrame(item);
    const s = shotOf(item);
    k = fit(item, k);
    if (item.kind === 'video') {
      item.frame = { start: k, end: k };
      return;
    }
    const other = key === 'start' ? f.end : f.start;
    f[key] = fit(item, limitTo(item, other, k, s.length));
    item.frame = { start: f.start, end: f.end };
  }

  function moveBoth(item, f, dx, dy) {
    const [bw, bh] = baseSize(item);
    let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity;
    for (const k of [f.start, f.end]) {
      const w = bw / k.z, h = bh / k.z;
      loX = Math.max(loX, w / 2 - k.x);
      hiX = Math.min(hiX, 1 - w / 2 - k.x);
      loY = Math.max(loY, h / 2 - k.y);
      hiY = Math.min(hiY, 1 - h / 2 - k.y);
    }
    dx = clamp(dx, loX, hiX);
    dy = clamp(dy, loY, hiY);
    const shift = (k) => ({ ...k, x: k.x + dx, y: k.y + dy });
    item.frame = { start: shift(f.start), end: shift(f.end) };
  }

  function bindFramer() {
    const view = $('#framer-view');
    document.querySelectorAll('.framer-win').forEach((el) => {
      el.addEventListener('pointerdown', (e) => {
        const item = framer.item;
        if (!item) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        const key = el.dataset.key;
        const resizing = e.target.classList.contains('framer-handle');
        const both = e.shiftKey && !resizing && item.kind !== 'video';
        const start = currentFrame(item);
        const from = start[key];
        const x0 = e.clientX, y0 = e.clientY;
        if (both) document.querySelectorAll('.framer-win').forEach((w) => w.classList.add('dragging'));
        const move = (ev) => {
          const rect = view.getBoundingClientRect();
          if (both) {
            // Shift：始点と終点を同じだけ動かす。どちらもはみ出さない範囲に収める
            moveBoth(item, start, (ev.clientX - x0) / rect.width, (ev.clientY - y0) / rect.height);
          } else if (resizing) {
            // 中心はそのままで、ポインタの位置まで枠を広げ縮めする
            const [bw, bh] = baseSize(item);
            const px = (ev.clientX - rect.left) / rect.width;
            const py = (ev.clientY - rect.top) / rect.height;
            const w = Math.max(2 * Math.abs(px - from.x), 2 * Math.abs(py - from.y) * bw / bh);
            setFrameKey(item, key, { ...from, z: bw / Math.max(w, 1e-3) });
          } else {
            setFrameKey(item, key, {
              ...from,
              x: from.x + (ev.clientX - x0) / rect.width,
              y: from.y + (ev.clientY - y0) / rect.height
            });
          }
          layoutFramer();
          $('#framer-reset').disabled = false;
        };
        const up = () => {
          document.querySelectorAll('.framer-win').forEach((w) => w.classList.remove('dragging'));
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          renderList();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    });
    $('#framer-reset').onclick = () => {
      if (!framer.item) return;
      framer.item.frame = null;
      $('#framer-reset').disabled = true;
      layoutFramer();
      renderList();
    };
    $('#framer-done').onclick = closeFramer;
    window.addEventListener('resize', () => {
      sizeFramer();
      layoutFramer();
    });
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
      if (framer.item && framer.item.kind === 'video') paintFramer();

      updateWaveHead();
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
      if (state.exporting) abortExport('Export failed: ' + e.message);
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
    $('#progress-label').textContent = label || `Exporting… ${pct}%`;
  }

  function startExport() {
    const withAudio = !!audio.buffer;
    const mime = pickMime(withAudio);
    if (!mime) {
      notice('This browser can\'t export video. Please use Chrome or Safari.');
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
      notice('Couldn\'t start the export: ' + e.message);
      return;
    }

    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => saveRecording(mime);
    recorder.onerror = (e) => {
      abortExport('Export failed: ' + (e.error ? e.error.message : 'unknown error'));
    };

    state.playing = false;
    stopAudio();
    closeFramer();
    $('#download').hidden = true;
    notice(`Keep this tab visible while exporting (about ${state.duration}s).`);
    setExporting(true);
    updateProgress(0);

    state.time = 0;
    recorder.start(250);
    exportStart = performance.now();
    if (withAudio) startAudio(0);
  }

  function finishExport() {
    state.exporting = false;
    updateProgress(1, 'Finishing…');
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
      notice('No video data was recorded. Please try again.');
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
      ? `Export complete (${(blob.size / 1048576).toFixed(1)} MB).`
      : 'Export complete (WebM). To post on Instagram, export MP4 from Chrome or Safari.');
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
    $('#play').textContent = state.playing ? 'Stop' : 'Play';
  }

  function setPlaying(on) {
    state.playing = on;
    if (on) {
      closeFramer();
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
        input.style.setProperty('--fill', `${input.value}%`);
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

    $('#audio-remove').onclick = removeAudio;
    $('#audio-file').onchange = (e) => {
      if (e.target.files[0]) loadAudio(e.target.files[0]);
      e.target.value = '';
    };
    [['#fade-in', 'fadeIn'], ['#fade-out', 'fadeOut']].forEach(([sel, key]) => {
      const input = $(sel);
      input.checked = state[key];
      input.onchange = () => {
        state[key] = input.checked;
        if (state.playing) startAudio(state.time);
      };
    });

    document.querySelectorAll('input[name="duration"]').forEach((input) => {
      input.checked = Number(input.value) === state.duration;
      input.onchange = () => {
        state.duration = Number(input.value);
        state.time = Math.min(state.time, state.duration);
        layoutWave();
        if (state.playing) startAudio(state.time);
      };
    });

    $('#shuffle').onclick = () => {
      state.seed = Math.floor(Math.random() * 1000) + 1;
    };

    $('#play').onclick = () => setPlaying(!state.playing);
    $('#refresh').onclick = refreshPreview;

    $('#scrub').oninput = (e) => {
      state.time = (Number(e.target.value) / 1000) * state.duration;
      if (state.playing) startAudio(state.time);
    };

    $('#export').onclick = startExport;
  }

  buildMoods();
  bindSliders();
  bind();
  bindFramer();
  bindWave();
  bindMaster();
  renderList();
  renderAudio();
  requestAnimationFrame(frame);
})();
