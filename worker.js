'use strict';
// Computes one row (or one block-row in a coarse pass) of the Mandelbrot set.
// Returns a smooth escape value per sample, or -1 for points inside the set.

const BAILOUT = 65536; // a large escape radius gives smoother colour bands

function escapeValue(cr, ci, maxIter) {
    // Points inside the main cardioid or the period-2 bulb never escape;
    // skipping them avoids running the full iteration count.
    const xq = cr - 0.25;
    const q = xq * xq + ci * ci;
    if (q * (q + xq) <= 0.25 * ci * ci) return -1;
    if ((cr + 1) * (cr + 1) + ci * ci <= 0.0625) return -1;

    let zr = 0, zi = 0, zr2 = 0, zi2 = 0;
    // Periodicity check: if z returns to a saved value it is in a cycle
    // and will never escape. Saves most of the work inside the set.
    let savedR = 0, savedI = 0, sinceSave = 0, saveEvery = 8;

    for (let n = 0; n < maxIter; n++) {
        zi = 2 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        zr2 = zr * zr;
        zi2 = zi * zi;

        const r2 = zr2 + zi2;
        if (r2 > BAILOUT) {
            // Normalised iteration count: removes the hard bands between counts
            const log2Abs = 0.5 * Math.log2(r2);
            return n + 1 - Math.log2(log2Abs);
        }

        if (Math.abs(zr - savedR) < 1e-15 && Math.abs(zi - savedI) < 1e-15) return -1;
        if (++sinceSave === saveEvery) {
            sinceSave = 0;
            saveEvery *= 2;
            savedR = zr;
            savedI = zi;
        }
    }
    return -1;
}

self.onmessage = (e) => {
    const { job, y, step, width, height, scale, cx, cy, maxIter } = e.data;
    const cols = Math.ceil(width / step);
    const out = new Float32Array(cols);
    const ci = (y + step / 2 - height / 2) / scale + cy;
    for (let i = 0; i < cols; i++) {
        const cr = (i * step + step / 2 - width / 2) / scale + cx;
        out[i] = escapeValue(cr, ci, maxIter);
    }
    self.postMessage({ job, y, step, mu: out }, [out.buffer]);
};
