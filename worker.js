self.onmessage = function(e) {
    const { width, height, yOffset } = e.data;
    const imageData = new ImageData(width, height);

    for(let y = 0; y < height; y++) {
        for(let x = 0; x < width; x++) {
            let dx = (x - width / 2) / 25000 - 0.233;
            let dy = (y + yOffset - height / 2) / 25000 - 0.655;
            let a = dx;
            let b = dy;

            for(var t = 0; t < 500000; t++) {
                let d = (a * a) - (b * b) + dx;
                b = 2 * (a * b) + dy;
                a = d;

                if(d > 2000) {
                    const pixelIndex = (y * width + x) * 4;
                    imageData.data[pixelIndex] = Math.sin(t) * 128 + 128;
                    imageData.data[pixelIndex + 1] = Math.sin(t * 0.6) * 128 + 128;
                    imageData.data[pixelIndex + 2] = Math.sin(t * 0.3) * 128 + 128;
                    imageData.data[pixelIndex + 3] = 255;
                    break;
                }
            }
        }
    }

    postMessage({ imageData, yOffset });
};
