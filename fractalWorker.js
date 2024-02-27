// Function to calculate Mandelbrot set membership for a given point with contrast-focused iteration
function calculateMandelbrotSetWithContrast(x, y, adjustedMaxIterations) {
    let a = x;
    let b = y;
    let iteration = 0;

    for (iteration = 1; iteration < adjustedMaxIterations; iteration++) {
        let d = a * a - b * b + x;
        b = 2 * a * b + y;
        a = d;
        if (a * a + b * b > 4) break; // Escape condition
    }

    return iteration;
}

// Dynamically adjust the maximum number of iterations based on the location
// (Function `adjustIterationsForLocation` remains the same as previously defined)

// Web worker message handler
self.onmessage = function(e) {
    const { width, height, yOffset, scale, offsetX, offsetY, maxIterations, zoomLevel } = e.data;
    const imageData = new ImageData(width, height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // Convert pixel coordinates to fractal coordinates
            const real = (x - width / 2) / scale + offsetX;
            const imaginary = (y + yOffset - height / 2) / scale + offsetY;

            // Dynamically adjust the maximum iterations based on location and zoom level
            const adjustedMaxIterations = adjustIterationsForLocation(real, imaginary, maxIterations, zoomLevel);

            // Calculate the Mandelbrot set for the given point with the dynamically adjusted iterations and contrast-focused method
            const iteration = calculateMandelbrotSetWithContrast(real, imaginary, adjustedMaxIterations);

            // Set pixel color based on iteration count, focusing on contrast
            const colorValue = iteration === adjustedMaxIterations ? 0 : iteration % 256;
            const pixelIndex = (y * width + x) * 4;
            imageData.data[pixelIndex] = colorValue; // R
            imageData.data[pixelIndex + 1] = colorValue; // G
            imageData.data[pixelIndex + 2] = colorValue; // B
            imageData.data[pixelIndex + 3] = 255; // Alpha (fully opaque)
        }
    }

    postMessage({ imageData, yOffset });
};


// Dynamically adjust the maximum number of iterations based on the location
function adjustIterationsForLocation(x, y, baseMaxIterations, zoomLevel) {
    const boundaryThreshold = 0.5; // Example threshold for determining complexity
    const zoomAdjustmentFactor = 0.2; // Adjust based on experimentation
    let adjustmentFactor = 1;

    // Simple heuristic to increase iterations near the boundary of the set
    if (Math.abs(x) + Math.abs(y) < boundaryThreshold) {
        adjustmentFactor += zoomLevel * zoomAdjustmentFactor;
    }

    // Ensure there's an upper limit to avoid excessive computations
    const adjustedMaxIterations = Math.min(baseMaxIterations * adjustmentFactor, baseMaxIterations * 2);
    return adjustedMaxIterations;
}
