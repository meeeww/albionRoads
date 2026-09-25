const robot = require('robotjs')
const ColorClassifier = require("color-classifier");

const colorClassifier = new ColorClassifier([
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
]);

const getPixelColorAt = (x, y) => {
    var hex = robot.getPixelColor(x, y);
    const classified = colorClassifier.classify("#" + hex, 'hex')
    return classified;
}

const whole = (value) => {
    const rounded = Math.round(value)
    return Number.isFinite(rounded) ? rounded : null
}

const readPixel = (img, x, y) => {
    const offset = (y * img.byteWidth) + (x * img.bytesPerPixel)
    const blue = img.image[offset]
    const green = img.image[offset + 1]
    const red = img.image[offset + 2]
    return [red, green, blue]
}

const isGreen = (red, green, blue) => green >= 80 && green >= red + 18 && green >= blue + 12 && green > red && green > blue

const isMarker = (red, green, blue) => {
    if (isGreen(red, green, blue)) return false
    return red >= 190 && green >= 170 && blue >= 130 && Math.abs(red - green) < 70
}

// Hold moves the bobber right. Release lets it drift left.
// Keep the bright marker inside the green zone on the reel bar.
const clampToDisplay = (x, y, width, height) => {
    let displays = []
    try {
        displays = robot.getDisplays() || []
    } catch {
        displays = []
    }
    if (!displays.length) {
        const screen = robot.getScreenSize()
        displays = [{ x: 0, y: 0, width: screen.width, height: screen.height }]
    }

    const centerX = x + (width / 2)
    const centerY = y + (height / 2)
    const display = displays.find((item) => (
        centerX >= item.x && centerY >= item.y
        && centerX < item.x + item.width
        && centerY < item.y + item.height
    )) || displays[0]

    const left = Math.max(x, display.x)
    const top = Math.max(y, display.y)
    const right = Math.min(x + width, display.x + display.width)
    const bottom = Math.min(y + height, display.y + display.height)
    const clampedWidth = Math.round(right - left)
    const clampedHeight = Math.round(bottom - top)
    if (clampedWidth < 8 || clampedHeight < 8) return null
    return {
        x: Math.round(left),
        y: Math.round(top),
        width: clampedWidth,
        height: clampedHeight,
    }
}

const screenBands = () => {
    let displays = []
    try {
        displays = robot.getDisplays() || []
    } catch {
        displays = []
    }
    if (!displays.length) {
        const screen = robot.getScreenSize()
        displays = [{ x: 0, y: 0, width: screen.width, height: screen.height }]
    }
    return displays.map((display) => clampToDisplay(
        display.x + (display.width * 0.12),
        display.y + (display.height * 0.28),
        display.width * 0.76,
        display.height * 0.44,
    )).filter(Boolean)
}

const isBobber = (red, green, blue) => {
    if (isGreen(red, green, blue)) return false
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    if (max >= 165 && (max - min) < 110) return true
    return red >= 150 && green >= 110 && blue < 140
}

const getReelAction = () => {
    let best = null
    let scanWidth = 0
    let scanHeight = 0
    let img = null

    for (const band of screenBands()) {
        let captured
        try {
            captured = robot.screen.capture(band.x, band.y, band.width, band.height)
        } catch {
            continue
        }
        if (!captured?.image) continue
        const width = Math.min(band.width, captured.width || band.width)
        const height = Math.min(band.height, captured.height || band.height)
        for (let row = 0; row < height; row += 3) {
            let run = 0
            let runStart = 0
            let longest = 0
            let longestStart = 0
            for (let col = 0; col < width; col += 3) {
                const [red, green, blue] = readPixel(captured, col, row)
                if (isGreen(red, green, blue)) {
                    if (run === 0) runStart = col
                    run += 3
                } else if (run > longest) {
                    longest = run
                    longestStart = runStart
                    run = 0
                } else {
                    run = 0
                }
            }
            if (run > longest) {
                longest = run
                longestStart = runStart
            }
            if (longest >= 36 && (!best || longest > best.length)) {
                best = { row, start: longestStart, length: longest }
                img = captured
                scanWidth = width
                scanHeight = height
            }
        }
    }

    if (!best || !img) return { bar: false }

    const neighbor = best.row + 3 < scanHeight ? best.row + 3 : Math.max(0, best.row - 3)
    let overlap = 0
    let run = 0
    for (let col = 0; col < scanWidth; col += 2) {
        const [red, green, blue] = readPixel(img, col, neighbor)
        const inside = col >= best.start && col <= best.start + best.length
        if (inside && isGreen(red, green, blue)) {
            if (run === 0) run = 2
            else run += 2
            if (run > overlap) overlap = run
        } else {
            run = 0
        }
    }
    if (overlap < 24) return { bar: false }

    const counts = new Array(scanWidth).fill(0)
    const top = Math.max(0, best.row - 16)
    const bottom = Math.min(scanHeight - 1, best.row + 16)
    const from = Math.max(0, best.start - 120)
    const to = Math.min(scanWidth - 1, best.start + best.length + 120)
    for (let row = top; row <= bottom; row += 2) {
        for (let col = from; col <= to; col++) {
            const [red, green, blue] = readPixel(img, col, row)
            if (isBobber(red, green, blue)) counts[col] += 1
        }
    }

    let peak = null
    let runStart = -1
    const closeRun = (runEnd) => {
        const width = runEnd - runStart
        if (width < 2 || width > 18) return
        let score = 0
        for (let col = runStart; col <= runEnd; col++) score += counts[col]
        if (score < 4) return
        if (!peak || score > peak.score) peak = { x: runStart + (width / 2), score }
    }
    for (let col = from; col <= to; col++) {
        if (counts[col] > 0) {
            if (runStart < 0) runStart = col
        } else if (runStart >= 0) {
            closeRun(col - 1)
            runStart = -1
        }
    }
    if (runStart >= 0) closeRun(to)

    const zoneCenter = best.start + (best.length / 2)
    const slack = Math.max(6, best.length * 0.12)
    if (!peak) return { bar: true, action: 'nudge' }
    if (peak.x < zoneCenter - slack) return { bar: true, action: 'pull' }
    if (peak.x > zoneCenter + slack) return { bar: true, action: 'rest' }
    return { bar: true, action: 'hold' }
}

const getActionFromCoordinates = (pullPoint, restPoint) => {
    const leftX = whole(Math.min(pullPoint[0], restPoint[0]));
    const rightX = whole(Math.max(pullPoint[0], restPoint[0]));
    const y = whole(pullPoint[1]);
    if (leftX === null || rightX === null || y === null) return;

    const width = rightX - leftX;
    if (width <= 0) return;

    // Dynamically scan the entire bar between pullPoint and restPoint natively
    const img = robot.screen.capture(leftX, y, width + 1, 1);

    let startX = -1;
    let endX = -1;

    for (let i = 0; i <= width; i++) {
        const hex = img.colorAt(i, 0);
        const classified = colorClassifier.classify("#" + hex, 'hex');
        if (classified !== '#00ff00') {
            if (startX === -1) startX = leftX + i;
            endX = leftX + i;
        } else if (startX !== -1) {
            // Bobber found and passed, stop scanning
            break;
        }
    }

    if (startX === -1) {
        // Bobber not found
        return;
    }

    // Exact location of the bobber
    const bobberX = startX + (endX - startX) / 2;

    // Calculate middle point of the bar
    const midX = leftX + width / 2;

    // Introduce a deadzone in the very center of the bar (middle 4%)
    const deadzoneRadius = width * 0.05; // 5% each side
    const deadzoneLeft = midX - deadzoneRadius;
    const deadzoneRight = midX + deadzoneRadius;

    // Actively pull or rest to keep bobber ping-ponging tightly inside center deadzone
    if (bobberX < deadzoneLeft) {
        return 'pull';
    } else if (bobberX > deadzoneRight) {
        return 'rest';
    }

    // Return undefined inside deadzone to continue previous action (ping-pong effect)
    return undefined;
}

module.exports = {
    getPixelColorAt,
    getActionFromCoordinates,
    getReelAction,
}