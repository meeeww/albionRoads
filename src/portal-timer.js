const fs = require('fs')
const path = require('path')

// The last capture is kept so a misread can be checked against what was on screen.
const DEBUG_PATH = path.join(__dirname, '..', 'last-tooltip.bmp')
// Area around the cursor where the portal's tooltip shows up, in screen pixels.
const REGION = { left: 300, right: 500, up: 300, down: 250 }
const SCALE = 2
const MAX_MS = 48 * 3600 * 1000

// A robotjs capture (BGRA) as a 24-bit BMP, grayscale, inverted and scaled up, so Tesseract gets
// dark text on a light background at a size it reads well.
const toBmp = ({ image, width, height, byteWidth, bytesPerPixel }) => {
    const w = width * SCALE
    const h = height * SCALE
    const rowBytes = Math.ceil(w * 3 / 4) * 4
    const bmp = Buffer.alloc(54 + rowBytes * h)
    bmp.write('BM', 0)
    bmp.writeUInt32LE(bmp.length, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(w, 18)
    bmp.writeInt32LE(h, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    bmp.writeUInt32LE(rowBytes * h, 34)
    for (let y = 0; y < h; y++) {
        // BMP rows go bottom to top.
        const out = 54 + (h - 1 - y) * rowBytes
        const src = Math.floor(y / SCALE) * byteWidth
        for (let x = 0; x < w; x++) {
            const i = src + Math.floor(x / SCALE) * bytesPerPixel
            const gray = 255 - Math.round(0.114 * image[i] + 0.587 * image[i + 1] + 0.299 * image[i + 2])
            bmp[out + x * 3] = bmp[out + x * 3 + 1] = bmp[out + x * 3 + 2] = gray
        }
    }
    return bmp
}

// "10h 05m" (or "45m 10s" near the end) to milliseconds, or null.
// ponytail: takes the longest time in the text, so the shorter "free to use for 1m" line loses; a
// tooltip with two long timers would need matching on the label's wording instead.
const parseTimer = (text) => {
    const times = [
        ...[...text.matchAll(/(\d{1,2})\s*h\s*(\d{1,2})\s*m/gi)].map((m) => (Number(m[1]) * 60 + Number(m[2])) * 60000),
        ...[...text.matchAll(/(\d{1,2})\s*m\s*(\d{1,2})\s*s/gi)].map((m) => (Number(m[1]) * 60 + Number(m[2])) * 1000),
    ].filter((ms) => ms > 0 && ms < MAX_MS)
    return times.length ? Math.max(...times) : null
}

let worker = null
// Reads the tooltip around the cursor at screen point [x, y]. Returns the OCR text and the time left.
const readTimer = async (robot, [x, y]) => {
    const screen = robot.getScreenSize()
    const left = Math.max(0, Math.round(x - REGION.left))
    const top = Math.max(0, Math.round(y - REGION.up))
    const width = Math.min(screen.width, Math.round(x + REGION.right)) - left
    const height = Math.min(screen.height, Math.round(y + REGION.down)) - top
    const image = toBmp(robot.screen.capture(left, top, width, height))
    fs.writeFileSync(DEBUG_PATH, image)
    worker ||= await require('tesseract.js').createWorker('eng')
    const { data } = await worker.recognize(image)
    return { text: data.text, left: parseTimer(data.text) }
}

module.exports = { readTimer, parseTimer, toBmp }
