/* stillr — WebGL2 レンダラー
 * 素材を 9:16 に切り出し、ぼかし・色調・流れ・汚しを重ねて 1080×1920 で描画する */
(function () {
  'use strict';

  const W = 1080, H = 1920;
  const MID_W = 540, MID_H = 960;   // 軽いぼかし用
  const LOW_W = 180, LOW_H = 320;   // 強いぼかし用

  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // 素材を構図（中心 xy・範囲 zw）で切り出す
  const FRAG_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec4 uXf;
void main() {
  outColor = vec4(texture(uTex, uXf.xy + (vUv - 0.5) * uXf.zw).rgb, 1.0);
}`;

  // 9タップのガウスぼかし（片方向）
  const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270;
  c += texture(uTex, vUv + uStep * 1.3846154).rgb * 0.3162162;
  c += texture(uTex, vUv - uStep * 1.3846154).rgb * 0.3162162;
  c += texture(uTex, vUv + uStep * 3.2307692).rgb * 0.0702703;
  c += texture(uTex, vUv - uStep * 3.2307692).rgb * 0.0702703;
  outColor = vec4(c, 1.0);
}`;

  const FRAG_FINAL = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex0, uTex1, uLight0, uLight1, uHeavy0, uHeavy1;
uniform vec4 uXf0, uXf1;
uniform int uCount;
uniform float uMix, uAbstract;
uniform float uTime, uSeed;
uniform float uScratch, uDust, uGrain, uVignette;
uniform float uSat, uContrast;
uniform vec3 uTint, uLift;
uniform vec4 uHaze;
uniform vec3 uPal0, uPal1, uPal2, uDustColor;
uniform vec2 uRes;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// 抽象度 0 → くっきり、0.5 → 軽いぼかし、1 → 強いぼかし
vec3 layerColor(sampler2D tex, sampler2D light, sampler2D heavy, vec4 xf) {
  vec3 sharp = texture(tex, xf.xy + (vUv - 0.5) * xf.zw).rgb;
  vec3 soft = texture(light, vUv).rgb;
  vec3 deep = texture(heavy, vUv).rgb;
  float k = uAbstract * 2.0;
  return k < 1.0 ? mix(sharp, soft, k) : mix(soft, deep, k - 1.0);
}

// 漂う塵（scale: 縦方向のセル数、speed: セル/秒、density: 出現確率）
float speck(vec2 uv, float scale, float speed, float density, float salt) {
  vec2 p = uv * vec2(scale * 0.5625, scale);
  p.y -= uTime * speed;
  p.x += sin(uTime * 0.07 + salt) * 0.6;
  vec2 cell = floor(p), f = fract(p);
  float h = hash(cell + salt);
  if (h > density) return 0.0;
  vec2 c = vec2(hash(cell + salt + 3.1), hash(cell + salt + 7.7)) * 0.7 + 0.15;
  float r = mix(0.03, 0.12, hash(cell + salt + 1.3));
  float tw = 0.55 + 0.45 * sin(uTime * (0.4 + h * 3.0) + h * 40.0);
  return smoothstep(r, r * 0.15, length(f - c)) * tw;
}

void main() {
  vec3 col;
  if (uCount == 0) {
    col = mix(uPal0, uPal1, 0.5) * 0.55;
  } else {
    col = layerColor(uTex0, uLight0, uHeavy0, uXf0);
    if (uCount > 1) col = mix(col, layerColor(uTex1, uLight1, uHeavy1, uXf1), uMix);
  }

  // 色調
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  col *= uTint;
  col = mix(col, uHaze.rgb, uHaze.a);
  col = uLift + col * (1.0 - uLift);
  col = clamp(col, 0.0, 1.0);

  // 汚し：古いフィルムの傷
  float filmFrame = floor(uTime * 12.0);   // 12コマ/秒で変化
  // 縦の傷：約2.5秒ごとに入れ替わり、わずかに揺れて明滅する
  float sc = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float life = floor(uTime * 0.4 + fi * 0.37);
    float on = step(0.45, hash(vec2(life, fi * 7.1 + 1.0)));
    float x = hash(vec2(life, fi * 3.3)) + sin(uTime * 1.3 + fi * 2.0) * 0.003
            + (hash(vec2(filmFrame, fi)) - 0.5) * 0.0015;
    float w = mix(0.0006, 0.0018, hash(vec2(life, fi + 9.0)));
    float lineV = 1.0 - smoothstep(w * 0.4, w, abs(vUv.x - x));
    float run = smoothstep(0.35, 0.6, noise(vec2(fi * 13.0 + life, vUv.y * 4.0)));
    float flick = 0.6 + 0.4 * hash(vec2(filmFrame, fi + 3.0));
    sc += lineV * run * flick * on;
  }
  col = mix(col, vec3(0.95, 0.93, 0.88), clamp(sc, 0.0, 1.0) * uScratch * 0.55);
  // 一瞬だけ映り込むゴミ
  if (hash(vec2(filmFrame, 1.7)) > 0.82) {
    vec2 c = vec2(hash(vec2(filmFrame, 2.3)), hash(vec2(filmFrame, 3.9)));
    float r = mix(0.0015, 0.005, hash(vec2(filmFrame, 5.1)));
    float blob = 1.0 - smoothstep(r * 0.5, r, length((vUv - c) * vec2(0.5625, 1.0)));
    col = mix(col, vec3(1.0), blob * uScratch);
  }
  // 染みと、明るさのちらつき
  float stain = smoothstep(0.55, 0.85, fbm(vUv * vec2(2.5, 4.4) + uSeed * 1.7 + uTime * 0.01));
  col *= 1.0 - stain * uScratch * 0.15;
  col *= 1.0 + (hash(vec2(filmFrame, 0.5)) - 0.5) * 0.05 * uScratch;

  // パーティクル：漂う塵
  float d = speck(vUv, 26.0, 0.20, 0.10, 11.0) * 0.6
          + speck(vUv, 60.0, 0.45, 0.12, 23.0)
          + speck(vUv, 12.0, 0.08, 0.08, 37.0) * 0.35;
  col = 1.0 - (1.0 - col) * (1.0 - uDustColor * clamp(d, 0.0, 1.0) * uDust);

  // 周辺減光・粒子
  float v = smoothstep(0.95, 0.25, length((vUv - 0.5) * vec2(1.0, 0.8)));
  col *= mix(1.0 - uVignette, 1.0, v);
  col += (hash(vUv * uRes + fract(uTime * 13.7) * 91.0) - 0.5) * uGrain;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  function makeProgram(gl, fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    const locs = {};
    return {
      program: p,
      loc(name) {
        if (!(name in locs)) locs[name] = gl.getUniformLocation(p, name);
        return locs[name];
      }
    };
  }

  function makeTexture(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function makeTarget(gl, w, h) {
    const tex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  class Renderer {
    constructor(canvas) {
      canvas.width = W;
      canvas.height = H;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
      if (!gl) throw new Error('This browser does not support WebGL2.');
      this.gl = gl;
      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      this.source = makeProgram(gl, FRAG_SOURCE);
      this.blur = makeProgram(gl, FRAG_BLUR);
      this.final = makeProgram(gl, FRAG_FINAL);

      this.slots = [0, 1].map(() => ({
        mid: makeTarget(gl, MID_W, MID_H),
        midTmp: makeTarget(gl, MID_W, MID_H),
        light: makeTarget(gl, MID_W, MID_H),
        low: makeTarget(gl, LOW_W, LOW_H),
        lowTmp: makeTarget(gl, LOW_W, LOW_H)
      }));
    }

    createTexture(source) {
      const tex = makeTexture(this.gl);
      this.updateTexture(tex, source);
      return tex;
    }

    updateTexture(tex, source) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    deleteTexture(tex) {
      this.gl.deleteTexture(tex);
    }

    _pass(prog, target, tex) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.w : W, target ? target.h : H);
      gl.useProgram(prog.program);
      if (tex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(prog.loc('uTex'), 0);
      }
    }

    _draw() {
      this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    }

    _blur(from, to, dx, dy, spread) {
      this._pass(this.blur, to, from.tex);
      this.gl.uniform2f(this.blur.loc('uStep'), dx * spread / from.w, dy * spread / from.h);
      this._draw();
    }

    // 1つの素材について、切り出し → 軽いぼかし → 強いぼかし を用意する
    _prepare(slot, layer) {
      const s = this.slots[slot];
      const xf = layer.xf;

      this._pass(this.source, s.mid, layer.tex);
      this.gl.uniform4f(this.source.loc('uXf'), xf[0], xf[1], xf[2], xf[3]);
      this._draw();

      this._blur(s.mid, s.midTmp, 1, 0, 2.0);
      this._blur(s.midTmp, s.light, 0, 1, 2.0);

      this._pass(this.source, s.low, s.light.tex);
      this.gl.uniform4f(this.source.loc('uXf'), 0.5, 0.5, 1, 1);
      this._draw();
      for (let i = 0; i < 3; i++) {
        this._blur(s.low, s.lowTmp, 1, 0, 2.5);
        this._blur(s.lowTmp, s.low, 0, 1, 2.5);
      }
    }

    /* p: {
     *   layers: [{ tex, xf: [cx, cy, sx, sy] }]（最大2）, mix,
     *   abstract, time, seed, scratch, dust, grain, vignette,
     *   look: { sat, contrast, tint, lift, haze, pal: [c0, c1, c2], dust }
     * } */
    render(p) {
      const gl = this.gl;
      const layers = p.layers.slice(0, 2);
      layers.forEach((layer, i) => this._prepare(i, layer));

      const f = this.final;
      this._pass(f, null, null);
      const bind = (unit, name, tex) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(f.loc(name), unit);
      };
      layers.forEach((layer, i) => {
        const s = this.slots[i];
        bind(i * 3, 'uTex' + i, layer.tex);
        bind(i * 3 + 1, 'uLight' + i, s.light.tex);
        bind(i * 3 + 2, 'uHeavy' + i, s.low.tex);
        gl.uniform4f(f.loc('uXf' + i), layer.xf[0], layer.xf[1], layer.xf[2], layer.xf[3]);
      });
      // 使わないスロットにも有効なテクスチャを割り当てておく
      for (let i = layers.length; i < 2; i++) {
        const s = this.slots[i];
        bind(i * 3, 'uTex' + i, s.mid.tex);
        bind(i * 3 + 1, 'uLight' + i, s.light.tex);
        bind(i * 3 + 2, 'uHeavy' + i, s.low.tex);
      }

      const look = p.look;
      gl.uniform1i(f.loc('uCount'), layers.length);
      gl.uniform1f(f.loc('uMix'), p.mix);
      gl.uniform1f(f.loc('uAbstract'), p.abstract);
      gl.uniform1f(f.loc('uTime'), p.time);
      gl.uniform1f(f.loc('uSeed'), p.seed);
      gl.uniform1f(f.loc('uScratch'), p.scratch);
      gl.uniform1f(f.loc('uDust'), p.dust);
      gl.uniform1f(f.loc('uGrain'), p.grain);
      gl.uniform1f(f.loc('uVignette'), p.vignette);
      gl.uniform1f(f.loc('uSat'), look.sat);
      gl.uniform1f(f.loc('uContrast'), look.contrast);
      gl.uniform3fv(f.loc('uTint'), look.tint);
      gl.uniform3fv(f.loc('uLift'), look.lift);
      gl.uniform4fv(f.loc('uHaze'), look.haze);
      gl.uniform3fv(f.loc('uPal0'), look.pal[0]);
      gl.uniform3fv(f.loc('uPal1'), look.pal[1]);
      gl.uniform3fv(f.loc('uPal2'), look.pal[2]);
      gl.uniform3fv(f.loc('uDustColor'), look.dust);
      gl.uniform2f(f.loc('uRes'), W, H);
      this._draw();
    }
  }

  Renderer.WIDTH = W;
  Renderer.HEIGHT = H;
  window.StillrRenderer = Renderer;
})();
