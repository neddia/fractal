const canvas = document.getElementById('gardun');
const ctx = canvas.getContext('2d');
let scale = 100000; // Initial scale for fractal
let offsetX = -0.233; // Initial X offset for fractal
let offsetY = -0.655; // Initial Y offset for fractal
let maxIterations = 20000; // Initial max iterations for detail
const workerCount = navigator.hardwareConcurrency || 4; // Use all available cores
const workers = [];


// Example of calculating a zoom level (simplified)
const zoomLevel = Math.log(scale) / Math.log(2); // Adjust as needed

// Initialize Web Workers
for (let i = 0; i < workerCount; i++) {
    const worker = new Worker('./fractalWorker.js');
    workers.push(worker);

    worker.onmessage = function(e) {
        const { imageData, yOffset } = e.data;
        ctx.putImageData(imageData, 0, yOffset);
    };
}

function resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(ratio, ratio); // Adjust context for the new canvas size
    renderFractal(); // Re-render the fractal
}


window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Call initially to set size


// Function to adjust zoom based on mouse wheel events
function adjustZoom(event) {
    event.preventDefault();
    const zoomIntensity = 0.1;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Calculate the zoom direction and adjust the zoom factor
    const wheelDelta = event.deltaY < 0 ? 1 : -1;
    const zoomFactor = Math.exp(wheelDelta * zoomIntensity);

    // Convert mouse coordinates to fractal coordinates before zooming
    const fractalXBeforeZoom = offsetX + (mouseX / canvas.width) * (4 / scale);
    const fractalYBeforeZoom = offsetY + (mouseY / canvas.height) * (4 / scale);

    // Apply the zoom
    scale *= zoomFactor;

    // Adjust offsets to ensure the fractal point under the mouse remains the same
    offsetX = fractalXBeforeZoom - (mouseX / canvas.width) * (4 / scale);
    offsetY = fractalYBeforeZoom - (mouseY / canvas.height) * (4 / scale);

    renderFractal();
}

// Function to manage the throttling of render updates
let lastRenderTime = 0;
const renderThrottleTime = 100; // Time in milliseconds between renders

function throttleRender(timeNow) {
    if (timeNow - lastRenderTime >= renderThrottleTime) {
        renderFractal();
        lastRenderTime = timeNow;
    }
}

// Drag functionality
let isDragging = false;
let dragStartX, dragStartY;

canvas.addEventListener('mousedown', (event) => {
    isDragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
});

canvas.addEventListener('mousemove', (event) => {
    if (isDragging) {
        const dx = event.clientX - dragStartX;
        const dy = event.clientY - dragStartY;
        dragStartX = event.clientX;
        dragStartY = event.clientY;

        // Adjust offsets based on drag, scaled by the current zoom level
        offsetX -= dx / scale;
        offsetY -= dy / scale;

        // Throttle the rendering to limit performance impact
        throttleRender(Date.now());
    }
});

window.addEventListener('mouseup', () => {
    isDragging = false;
});


// Function to trigger fractal rendering, with corrected zoomLevel calculation
function renderFractal() {

    const zoomLevel = Math.log2(scale); // Correctly placed zoomLevel calculation
    const segmentHeight = Math.ceil(canvas.height / workerCount);
    let accumulatedHeight = 0;

    for (let i = 0; i < workerCount; i++) {
        let height = segmentHeight;
        if (i == workerCount - 1) {
            height = canvas.height - accumulatedHeight;
        }

        workers[i].postMessage({
            width: canvas.width,
            height: height,
            yOffset: accumulatedHeight,
            scale,
            offsetX,
            offsetY,
            maxIterations,
            zoomLevel // Now correctly included in each worker's message
        });

        accumulatedHeight += height;
    }
}


canvas.addEventListener('wheel', adjustZoom);
renderFractal(); // Initial render
