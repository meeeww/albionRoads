// Mean distance from the road edge (in cells) along routes between exits, and how centered they are.
const rp = require('./src/road-paths')
const zones = require('./data/zones.json')
const CELL = rp.CELL
for (const zoneId of ['TNL-109', 'TNL-220', 'TNL-232']) {
    const g = rp.groundOf(zoneId)
    const depth = new Map()
    const queue = []
    for (const key of g.cost.keys()) {
        const [cx, cy] = key.split(',').map(Number)
        let edge = false
        for (let dx = -1; dx <= 1 && !edge; dx++) for (let dy = -1; dy <= 1 && !edge; dy++) edge = !g.cost.has(`${cx + dx},${cy + dy}`)
        if (edge) { depth.set(key, 1); queue.push([cx, cy]) }
    }
    for (let i = 0; i < queue.length; i++) {
        const [cx, cy] = queue[i]
        const d = depth.get(`${cx},${cy}`)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const k = `${cx + dx},${cy + dy}`
            if (g.cost.has(k) && !depth.has(k)) { depth.set(k, d + 1); queue.push([cx + dx, cy + dy]) }
        }
    }
    // Centered = at the local ridge: no 8-neighbor is deeper.
    const ridge = (key) => { const [cx, cy] = key.split(',').map(Number); const d = depth.get(key); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((depth.get(`${cx + dx},${cy + dy}`) || 0) > d) return false; return true }
    const ex = zones[zoneId].exits
    let n = 0, sumD = 0, onRidge = 0
    for (let i = 0; i < ex.length; i++) for (let j = i + 1; j < ex.length; j++) {
        const r = rp.findPath(new rp.Trails(null), zoneId, [ex[i].x, ex[i].y], [ex[j].x, ex[j].y])
        for (const p of r) {
            if (Math.hypot(p[0] - ex[i].x, p[1] - ex[i].y) < 60 || Math.hypot(p[0] - ex[j].x, p[1] - ex[j].y) < 60) continue
            const key = p.map((v) => Math.floor(v / CELL)).join()
            n++; sumD += depth.get(key) || 0; if (ridge(key)) onRidge++
        }
    }
    console.log(zoneId, 'mean depth', (sumD / n).toFixed(2), 'on center line', (100 * onRidge / n).toFixed(0) + '%')
}
