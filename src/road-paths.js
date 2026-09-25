const fs = require('fs')
const path = require('path')
const zones = require('../data/zones.json')
const ground = require('../data/ground.json')

const CELL = 4
const TRAILS_PATH = path.join(__dirname, '..', 'trails.json')
const WALKED_COST = 1
// Unknown ground costs a little more, so routes use known trails only when they're nearly as short.
const UNKNOWN_COST = 1.25
// With the zone's road pieces known: stay on the main road, take side paths reluctantly,
// and leave the pieces only where they have gaps (piece edges, portals).
const ROAD_COST = 1
const OFFROAD_COST = 1.5
const OFF_GROUND_COST = 6
// Portal pieces have no road piece under them, so lines may leave the road this close to either end.
const OFF_GROUND_FREE = 40

const cellOf = (pos) => [Math.floor(pos[0] / CELL), Math.floor(pos[1] / CELL)]
const keyOf = (cx, cy) => `${cx},${cy}`
const centerOf = (cx, cy) => [(cx + 0.5) * CELL, (cy + 0.5) * CELL]

// Cell key -> cost for every cell under a road piece of the zone, or null when the zone has none.
const groundCache = new Map()
const groundOf = (zoneId) => {
    if (!groundCache.has(zoneId)) {
        const rects = ground[zones[zoneId]?.layout]
        let cells = null
        if (rects?.length) {
            cells = new Map()
            for (const [x, y, w, d, offroad] of rects) {
                for (let cx = Math.floor((x - w / 2) / CELL); cx < Math.ceil((x + w / 2) / CELL); cx++) {
                    for (let cy = Math.floor((y - d / 2) / CELL); cy < Math.ceil((y + d / 2) / CELL); cy++) {
                        const key = keyOf(cx, cy)
                        if (!offroad || !cells.has(key)) cells.set(key, offroad ? OFFROAD_COST : ROAD_COST)
                    }
                }
            }
        }
        groundCache.set(zoneId, cells)
    }
    return groundCache.get(zoneId)
}

class Trails {
    constructor(file = TRAILS_PATH) {
        this.file = file
        this.zones = {}
        this.dirty = false
        if (file && fs.existsSync(file)) {
            for (const [id, { walked, blocked }] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
                this.zones[id] = { walked: new Set(walked), blocked: new Set(blocked) }
            }
        }
    }

    of(zoneId) {
        if (!this.zones[zoneId]) this.zones[zoneId] = { walked: new Set(), blocked: new Set() }
        return this.zones[zoneId]
    }

    markWalked(zoneId, pos) {
        const zone = this.of(zoneId)
        const key = keyOf(...cellOf(pos))
        if (zone.walked.has(key)) return
        zone.walked.add(key)
        zone.blocked.delete(key)
        this.dirty = true
    }

    markBlocked(zoneId, pos) {
        const zone = this.of(zoneId)
        const key = keyOf(...cellOf(pos))
        if (zone.walked.has(key) || zone.blocked.has(key)) return
        zone.blocked.add(key)
        this.dirty = true
    }

    isBlocked(zoneId, pos) {
        return this.of(zoneId).blocked.has(keyOf(...cellOf(pos)))
    }

    save() {
        if (!this.dirty || !this.file) return
        const out = {}
        for (const [id, { walked, blocked }] of Object.entries(this.zones)) out[id] = { walked: [...walked], blocked: [...blocked] }
        fs.writeFileSync(this.file, JSON.stringify(out))
        this.dirty = false
    }
}

// Line of sight over the grid: true when no blocked cell sits between a and b, and the line stays
// on road pieces or walked ground away from its ends. The last cell and a half before b is
// skipped: a portal's own collider gets marked blocked.
const clearLine = (trails, zoneId, a, b) => {
    const cells = groundOf(zoneId)
    const { walked } = trails.of(zoneId)
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.ceil(length / (CELL / 2))
    for (let i = 1; i <= steps; i++) {
        const t = i / steps
        if (length * (1 - t) < CELL * 1.5) break
        const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        if (trails.isBlocked(zoneId, point)) return false
        const key = keyOf(...cellOf(point))
        const nearEnd = length * Math.min(t, 1 - t) < OFF_GROUND_FREE
        if (cells && !nearEnd && !cells.has(key) && !walked.has(key)) return false
    }
    return true
}

// Picks where to aim next: the portal itself when it's close and nothing known is in the way,
// otherwise straight at the farthest route point with a clear line, however far. Grid routes
// zig-zag at 45°, so aiming at a nearby route point would veer off the road.
const planStep = (trails, zoneId, pos, target, toScreen, maxPx) => {
    const offset = (point) => toScreen([point[0] - pos[0], point[1] - pos[1]])
    const clampPx = (screen) => {
        const length = Math.hypot(...screen)
        return length > maxPx ? screen.map((v) => v * maxPx / length) : screen
    }
    const direct = offset(target)
    const targetInSight = clearLine(trails, zoneId, pos, target)
    if (targetInSight && Math.hypot(...direct) <= maxPx) return { final: true, screen: direct, world: target }
    if (targetInSight) return { final: false, screen: clampPx(direct), world: target }

    const route = findPath(trails, zoneId, pos, target)
    if (!route) return null
    let pick = route[Math.min(1, route.length - 1)]
    for (let i = route.length - 1; i > 0; i--) {
        if (clearLine(trails, zoneId, pos, route[i])) {
            pick = route[i]
            break
        }
    }
    return { final: false, screen: clampPx(offset(pick)), world: pick }
}

// Marks a short wall segment at the first not-yet-known cell ahead of `pos`, across the direction
// the character failed to move. Each bump always learns a new cell, so retries never loop.
const markWallAhead = (trails, zoneId, pos, toward) => {
    const length = Math.hypot(toward[0] - pos[0], toward[1] - pos[1]) || 1
    const dir = [(toward[0] - pos[0]) / length, (toward[1] - pos[1]) / length]
    const own = cellOf(pos).join()
    const zone = trails.of(zoneId)
    // First look for unknown ground; if everything ahead was walked before (hugging a wall), overrule that.
    for (const overrule of [false, true]) {
        for (let d = CELL / 4; d <= CELL * 4; d += CELL / 4) {
            const ahead = [pos[0] + dir[0] * d, pos[1] + dir[1] * d]
            const key = cellOf(ahead).join()
            if (key === own || zone.blocked.has(key) || (!overrule && zone.walked.has(key))) continue
            // ponytail: three cells per failed step, so a long wall takes several bumps to map.
            for (const side of [-1, 0, 1]) {
                const cell = [ahead[0] - dir[1] * CELL * side, ahead[1] + dir[0] * CELL * side]
                const sideKey = cellOf(cell).join()
                if (sideKey === own) continue
                if (overrule) zone.walked.delete(sideKey)
                trails.markBlocked(zoneId, cell)
            }
            return
        }
    }
}

// A* from `from` to within `reach` units of `to`. Returns world waypoints, or null when walled off.
const findPath = (trails, zoneId, from, to, reach = CELL * 2) => {
    const { walked, blocked } = trails.of(zoneId)
    const cells = groundOf(zoneId)
    const costOf = (key) => walked.has(key) ? WALKED_COST : cells ? cells.get(key) ?? OFF_GROUND_COST : UNKNOWN_COST
    const bounds = zones[zoneId]?.origin && zones[zoneId]?.size
        ? [zones[zoneId].origin, zones[zoneId].size]
        : null
    const inBounds = (cx, cy) => {
        if (!bounds) return true
        const [x, y] = centerOf(cx, cy)
        return x >= bounds[0][0] && y >= bounds[0][1] && x <= bounds[0][0] + bounds[1][0] && y <= bounds[0][1] + bounds[1][1]
    }

    const start = cellOf(from)
    const goal = to
    const h = (cx, cy) => {
        const [x, y] = centerOf(cx, cy)
        return Math.hypot(goal[0] - x, goal[1] - y) / CELL * WALKED_COST
    }

    const heap = [[h(...start), 0, start[0], start[1]]]
    const cost = new Map([[keyOf(...start), 0]])
    const parent = new Map()
    let expanded = 0

    while (heap.length) {
        const [, g, cx, cy] = pop(heap)
        const key = keyOf(cx, cy)
        if (g > cost.get(key)) continue
        const [x, y] = centerOf(cx, cy)
        if (Math.hypot(goal[0] - x, goal[1] - y) <= reach) {
            const route = []
            for (let at = key; at; at = parent.get(at)) route.push(centerOf(...at.split(',').map(Number)))
            return route.reverse()
        }
        // ponytail: hard cap keeps a fully walled-off goal from searching the whole zone forever.
        if (++expanded > 200000) return null

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue
                const nx = cx + dx
                const ny = cy + dy
                const nkey = keyOf(nx, ny)
                if (blocked.has(nkey) || !inBounds(nx, ny)) continue
                if (dx && dy && (blocked.has(keyOf(cx + dx, cy)) || blocked.has(keyOf(cx, cy + dy)))) continue
                const step = costOf(nkey) * (dx && dy ? Math.SQRT2 : 1)
                const ng = g + step
                if (ng >= (cost.get(nkey) ?? Infinity)) continue
                cost.set(nkey, ng)
                parent.set(nkey, key)
                push(heap, [ng + h(nx, ny), ng, nx, ny])
            }
        }
    }
    return null
}

const push = (heap, item) => {
    heap.push(item)
    for (let i = heap.length - 1; i > 0;) {
        const up = (i - 1) >> 1
        if (heap[up][0] <= heap[i][0]) break
        ;[heap[up], heap[i]] = [heap[i], heap[up]]
        i = up
    }
}

const pop = (heap) => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
        heap[0] = last
        for (let i = 0; ;) {
            const l = i * 2 + 1
            const r = l + 1
            let min = i
            if (l < heap.length && heap[l][0] < heap[min][0]) min = l
            if (r < heap.length && heap[r][0] < heap[min][0]) min = r
            if (min === i) break
            ;[heap[min], heap[i]] = [heap[i], heap[min]]
            i = min
        }
    }
    return top
}

module.exports = { Trails, findPath, clearLine, planStep, markWallAhead, groundOf, CELL }
