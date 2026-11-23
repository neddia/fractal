'use strict';
// Mandelbrot explorer: CPU (Web Workers, 64-bit, deep zoom) and GPU (WebGL, fast,
// limited by 32-bit floats). Both use the same view, palettes and smooth colouring.

const cpuCanvas = document.getElementById('cpu');
const ctx = cpuCanvas.getContext('2d', { alpha: false });
const glCanvas = document.getElementById('gl');
const statsEl = document.getElementById('stats');
const hudEl = document.getElementById('hud');
const progressEl = document.getElementById('progress');

// ───────────────────────── view ─────────────────────────
// scale = canvas pixels per unit of the complex plane; (x, y) = centre point.
// "zoom" shown to the user is scale relative to the whole-set view.

const PLACES = [
    { name: 'Whole set',       x: -0.6,                y: 0,                 zoom: 1 },
    { name: 'Spiral arms',     x: -0.233,              y: -0.655,            zoom: 300 },
    { name: 'Seahorse valley', x: -0.7436438870371587, y: -0.1318259042053,  zoom: 25000 },
    { name: 'Elephant valley', x: 0.2861,              y: -0.0115,           zoom: 180 },
];

let W = 0, H = 0;
const view = { x: PLACES[0].x, y: PLACES[0].y, scale: 1 };
let detailBoost = 1;      // [ and ] double or halve the iteration budget
let paletteIndex = 1;
let cycling = false;
let phase = 0;
let gpuWanted = false;
const GPU_MAX_ZOOM = 1e4; // past this, 32-bit floats on the GPU go blocky

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const baseScale = () => Math.min(W, H) / 3;
const zoomOf = (s = view.scale) => s / baseScale();

function maxIterations() {
    const z = Math.max(zoomOf(), 1);
    const auto = 200 + 300 * Math.pow(Math.log10(z), 1.5);
    return Math.min(Math.round(auto * detailBoost), 200000);
}

function toFractal(px, py) {
    return { x: (px - W / 2) / view.scale + view.x, y: (py - H / 2) / view.scale + view.y };
}

function setPlace(p) {
    view.x = p.x;
    view.y = p.y;
    view.scale = baseScale() * p.zoom;
    detailBoost = 1;
    requestRender();
}

// ───────────────────────── palettes ─────────────────────────
// Cosine palettes: colour(t) = a + b·cos(2π(c·t + d)). Integer c keeps them
// periodic in t, so the CPU can use a lookup table and match the GPU exactly.

const PALETTES = [
    { name: 'Mono',   a: [0.5, 0.5, 0.5],   b: [0.5, 0.5, 0.5],   c: [1, 1, 1], d: [0.5, 0.5, 0.5] },
    { name: 'Ember',  a: [0.55, 0.3, 0.15], b: [0.45, 0.3, 0.15], c: [1, 1, 1], d: [0.0, 0.05, 0.1] },
    { name: 'Ocean',  a: [0.25, 0.4, 0.55], b: [0.25, 0.35, 0.45], c: [1, 1, 1], d: [0.35, 0.25, 0.15] },
    { name: 'Neon',   a: [0.5, 0.5, 0.5],   b: [0.5, 0.5, 0.5],   c: [1, 1, 1], d: [0.0, 0.33, 0.67] },
    { name: 'Sunset', a: [0.5, 0.5, 0.5],   b: [0.5, 0.5, 0.5],   c: [2, 1, 0], d: [0.5, 0.2, 0.25] },
];
const DENSITY = 0.22;   // colour bands per sqrt(iteration)
const LUT_SIZE = 2048;
const lut = new Uint32Array(LUT_SIZE);
const INSIDE = 0xff000000; // opaque black (ABGR in little-endian memory)

function buildLut() {
    const p = PALETTES[paletteIndex];
    for (let i = 0; i < LUT_SIZE; i++) {
        const t = i / LUT_SIZE;
        const ch = k => Math.max(0, Math.min(255, Math.round(255 * (p.a[k] + p.b[k] * Math.cos(2 * Math.PI * (p.c[k] * t + p.d[k]))))));
        lut[i] = (255 << 24) | (ch(2) << 16) | (ch(1) << 8) | ch(0);
    }
}

function colorOf(mu) {
    if (mu < 0) return INSIDE;
    let t = Math.sqrt(mu) * DENSITY + phase;
    t -= Math.floor(t);
    return lut[(t * LUT_SIZE) | 0];
}

// ───────────────────────── CPU renderer ─────────────────────────

const workerCount = Math.max(2, navigator.hardwareConcurrency || 4);
const workers = [];
let image = null, pixels = null, muBuf = null;
let job = 0, queue = [], levels = [], level = 0, rowsDone = 0, rowsTotal = 0;
let renderStart = 0, lastRenderMs = 0, renderDone = true;
const snap = document.createElement('canvas');
const snapCtx = snap.getContext('2d');
let shown = null; // the view the CPU canvas currently depicts (for instant previews)

for (let i = 0; i < workerCount; i++) {
    const w = new Worker('worker.js');
    w.busy = false;
    w.onmessage = (e) => onRow(w, e.data);
    workers.push(w);
}

function allocBuffers() {
    image = new ImageData(W, H);
    pixels = new Uint32Array(image.data.buffer);
    muBuf = new Float32Array(W * H).fill(-1);
    shown = null;
}

function startCpuRender() {
    job++;
    // Instant preview: stretch/shift the last image to the new view while the
    // real one renders, so zooming and panning feel immediate.
    if (shown) {
        snap.width = W; snap.height = H;
        snapCtx.drawImage(cpuCanvas, 0, 0);
        const k = view.scale / shown.scale;
        const ox = W / 2 - (W / 2) * k + (shown.x - view.x) * view.scale;
        const oy = H / 2 - (H / 2) * k + (shown.y - view.y) * view.scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = k < 1;
        ctx.drawImage(snap, ox, oy, W * k, H * k);
    }
    shown = { ...view };
    // A coarse pass first (1 sample per 8×8 block), then full resolution
    levels = [8, 1];
    level = 0;
    renderStart = performance.now();
    renderDone = false;
    startLevel();
}

function startLevel() {
    const step = levels[level];
    queue = [];
    for (let y = 0; y < H; y += step) queue.push(y);
    // Centre rows first: the interesting part appears soonest
    queue.sort((a, b) => Math.abs(a - H / 2) - Math.abs(b - H / 2));
    rowsTotal = queue.length;
    rowsDone = 0;
    for (const w of workers) if (!w.busy) dispatch(w);
}

function dispatch(w) {
    if (!queue.length) { w.busy = false; return; }
    w.busy = true;
    w.postMessage({
        job, y: queue.shift(), step: levels[level], width: W, height: H,
        scale: view.scale, cx: view.x, cy: view.y, maxIter: maxIterations(),
    });
}

// Workers take one row at a time, so a new view only waits for rows already in
// flight; anything queued for the old view is simply dropped.
function onRow(w, d) {
    w.busy = false;
    if (d.job !== job) { dispatch(w); return; }
    paintRow(d);
    rowsDone++;
    progressEl.style.width = (100 * (level + rowsDone / rowsTotal) / levels.length) + '%';
    if (rowsDone === rowsTotal) {
        level++;
        if (level < levels.length) { startLevel(); return; }
        finishRender();
    }
    dispatch(w);
}

function paintRow({ y, step, mu }) {
    const rows = Math.min(step, H - y);
    for (let r = 0; r < rows; r++) {
        let o = (y + r) * W;
        for (let i = 0; i < mu.length; i++) {
            const m = mu[i];
            const c = colorOf(m);
            const end = Math.min(step, W - i * step);
            for (let s = 0; s < end; s++, o++) { muBuf[o] = m; pixels[o] = c; }
        }
    }
    ctx.putImageData(image, 0, 0, 0, y, W, rows);
}

function finishRender() {
    renderDone = true;
    lastRenderMs = performance.now() - renderStart;
    progressEl.style.width = '100%';
    setTimeout(() => { if (renderDone) progressEl.style.width = '0'; }, 250);
    updateHash();
    updateStats();
}

function recolorAll() {
    for (let i = 0; i < muBuf.length; i++) pixels[i] = colorOf(muBuf[i]);
    ctx.putImageData(image, 0, 0);
}

// ───────────────────────── GPU renderer (WebGL) ─────────────────────────

let gl = null, glProgram = null, glU = {};

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 u_res; uniform vec2 u_center; uniform float u_scale; uniform int u_max;
uniform vec3 u_a, u_b, u_c, u_d; uniform float u_density, u_phase;
void main() {
    vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
    vec2 c = (px - 0.5 * u_res) / u_scale + u_center;
    float xq = c.x - 0.25, q = xq * xq + c.y * c.y;
    if (q * (q + xq) <= 0.25 * c.y * c.y || (c.x + 1.0) * (c.x + 1.0) + c.y * c.y <= 0.0625) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;
    }
    vec2 z = vec2(0.0);
    float mu = -1.0;
    for (int i = 0; i < 20000; i++) {
        if (i >= u_max) break;
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        float r2 = dot(z, z);
        if (r2 > 65536.0) { mu = float(i) + 1.0 - log2(0.5 * log2(r2)); break; }
    }
    if (mu < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float t = sqrt(mu) * u_density + u_phase;
    gl_FragColor = vec4(u_a + u_b * cos(6.2831853 * (u_c * t + u_d)), 1.0);
}`;

function initGl() {
    if (gl) return true;
    gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) return false;
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    };
    glProgram = gl.createProgram();
    gl.attachShader(glProgram, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(glProgram, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(glProgram);
    gl.useProgram(glProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(glProgram, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_res', 'u_center', 'u_scale', 'u_max', 'u_a', 'u_b', 'u_c', 'u_d', 'u_density', 'u_phase']) {
        glU[n] = gl.getUniformLocation(glProgram, n);
    }
    return true;
}

function renderGpu() {
    const t0 = performance.now();
    const p = PALETTES[paletteIndex];
    gl.viewport(0, 0, W, H);
    gl.uniform2f(glU.u_res, W, H);
    gl.uniform2f(glU.u_center, view.x, view.y);
    gl.uniform1f(glU.u_scale, view.scale);
    gl.uniform1i(glU.u_max, Math.min(maxIterations(), 20000));
    gl.uniform3fv(glU.u_a, p.a); gl.uniform3fv(glU.u_b, p.b);
    gl.uniform3fv(glU.u_c, p.c); gl.uniform3fv(glU.u_d, p.d);
    gl.uniform1f(glU.u_density, DENSITY);
    gl.uniform1f(glU.u_phase, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.finish();
    lastRenderMs = performance.now() - t0;
    updateHash();
}

// ───────────────────────── render scheduling ─────────────────────────

const usingGpu = () => gpuWanted && gl && zoomOf() < GPU_MAX_ZOOM;

// Coalesce bursts of wheel/drag events into one render. This uses a timer, not
// requestAnimationFrame: browsers pause rAF for tabs they consider hidden (a
// background tab, or a window opened behind another app), which left the first
// render waiting until the page was brought to the front.
let renderQueued = false;
function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
        renderQueued = false;
        if (usingGpu()) {
            job++;            // drop any CPU rows still in flight
            queue = [];
            renderDone = true;
            shown = null;     // the CPU canvas no longer matches the view
            glCanvas.style.display = 'block';
            cpuCanvas.style.display = 'none';
            renderGpu();
        } else {
            glCanvas.style.display = 'none';
            cpuCanvas.style.display = 'block';
            startCpuRender();
        }
        updateStats();
    }, 0);
}

function resize() {
    const zoom = zoomOf();     // keep the same zoom level across a resize
    W = Math.floor(window.innerWidth * dpr());
    H = Math.floor(window.innerHeight * dpr());
    cpuCanvas.width = glCanvas.width = W;
    cpuCanvas.height = glCanvas.height = H;
    allocBuffers();
    view.scale = baseScale() * zoom;
    requestRender();
}

// ───────────────────────── HUD ─────────────────────────

function fmtZoom(z) {
    return z < 1000 ? z.toFixed(z < 10 ? 1 : 0) : z.toExponential(1).replace('e+', 'e');
}

function updateStats() {
    let mode;
    if (usingGpu()) mode = 'GPU';
    else if (gpuWanted && !gl) mode = 'CPU (WebGL unavailable)';
    else if (gpuWanted) mode = 'CPU (past GPU precision)';
    else mode = `CPU · ${workerCount} threads`;
    const time = usingGpu() || renderDone ? `${Math.round(lastRenderMs)} ms` : 'rendering…';
    statsEl.innerHTML = `<b>${fmtZoom(zoomOf())}×</b> · ${maxIterations().toLocaleString()} iterations · ` +
        `${PALETTES[paletteIndex].name} · ${mode} · ${time}`;
}

// Shareable views: the URL hash holds x, y, zoom
function updateHash() {
    const h = `#${view.x.toPrecision(17)},${view.y.toPrecision(17)},${zoomOf().toPrecision(6)}`;
    history.replaceState(null, '', h);
}

function readHash() {
    const parts = location.hash.slice(1).split(',').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite) && parts[2] > 0) {
        return { x: parts[0], y: parts[1], zoom: parts[2] };
    }
    return null;
}

// ───────────────────────── input ─────────────────────────

function canvasPoint(e) {
    return { x: e.clientX * dpr(), y: e.clientY * dpr() };
}

function zoomAt(px, py, factor) {
    const before = toFractal(px, py);
    view.scale = Math.max(view.scale * factor, baseScale() * 0.25);
    view.x = before.x - (px - W / 2) / view.scale;
    view.y = before.y - (py - H / 2) / view.scale;
    requestRender();
}

function onWheel(e) {
    e.preventDefault();
    const p = canvasPoint(e);
    // Proportional to scroll distance, so trackpads zoom smoothly
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(p.x, p.y, Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0015));
}

let drag = null;
function onPointerDown(e) {
    drag = canvasPoint(e);
    e.target.setPointerCapture(e.pointerId);
    e.target.classList.add('dragging');
}
function onPointerMove(e) {
    if (!drag) return;
    const p = canvasPoint(e);
    view.x -= (p.x - drag.x) / view.scale;
    view.y -= (p.y - drag.y) / view.scale;
    drag = p;
    requestRender();
}
function onPointerUp(e) {
    drag = null;
    e.target.classList.remove('dragging');
}
function onDoubleClick(e) {
    const p = canvasPoint(e);
    zoomAt(p.x, p.y, e.shiftKey ? 0.25 : 4);
}

for (const c of [cpuCanvas, glCanvas]) {
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerUp);
    c.addEventListener('dblclick', onDoubleClick);
}

function savePng() {
    const canvas = usingGpu() ? glCanvas : cpuCanvas;
    canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mandelbrot-${fmtZoom(zoomOf())}x.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
}

let cycleFrame = 0;
function cycleStep() {
    if (!cycling) return;
    phase = (phase + 0.004) % 1;
    if (usingGpu()) renderGpu();
    else if (renderDone) recolorAll();
    cycleFrame = requestAnimationFrame(cycleStep);
}

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= String(PLACES.length)) setPlace(PLACES[Number(k) - 1]);
    else if (k === 'r') setPlace(PLACES[0]);
    else if (k === 'p') {
        paletteIndex = (paletteIndex + 1) % PALETTES.length;
        buildLut();
        if (usingGpu()) renderGpu(); else recolorAll();
        updateStats();
    } else if (k === 'c') {
        cycling = !cycling;
        cancelAnimationFrame(cycleFrame);
        if (cycling) cycleStep();
    } else if (k === 'g') {
        gpuWanted = !gpuWanted;
        if (gpuWanted) {
            try { if (!initGl()) gl = null; } catch (err) { console.error(err); gl = null; }
        }
        requestRender();
    } else if (k === ']') { detailBoost = Math.min(detailBoost * 2, 64); requestRender(); }
    else if (k === '[') { detailBoost = Math.max(detailBoost / 2, 1 / 8); requestRender(); }
    else if (k === 's') savePng();
    else if (k === 'h') hudEl.classList.toggle('hidden');
    else return;
    e.preventDefault();
});

window.addEventListener('resize', resize);

// ───────────────────────── start ─────────────────────────

buildLut();
W = Math.floor(window.innerWidth * dpr());
H = Math.floor(window.innerHeight * dpr());
cpuCanvas.width = glCanvas.width = W;
cpuCanvas.height = glCanvas.height = H;
allocBuffers();
const start = readHash() || PLACES[1];
view.x = start.x;
view.y = start.y;
view.scale = baseScale() * start.zoom;
requestRender();
