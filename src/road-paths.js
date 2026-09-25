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
// Side paths are narrow and cluttered: taken only when the main road is a long way round.
const OFFROAD_COST = 8
const OFF_GROUND_COST = 12
// Railings, columns and rocks line the road edges: straight lines must stay this many cells clear
// of an edge, and routes pay CENTER_COST / (cells from the edge), so they run down the middle.
const EDGE_CELLS = 2
const CENTER_COST = 3
// Portal pieces have no road piece under them, so a line may leave the road this close to an
// end that is itself off the road.
const OFF_GROUND_FREE = 40
// Portals stand about 40 units past the road's end with no road piece in between; this wide a
// corridor from the road to each portal is walkable road.
const APPROACH_HALF_WIDTH = 12
// A portal's collider stops the character like a wall; bumps this close to a portal learn nothing.
const NO_WALLS_NEAR_EXIT = 40
const nearExit = (zoneId, pos) => (zones[zoneId]?.exits || []).some((e) => Math.hypot(e.x - pos[0], e.y - pos[1]) < NO_WALLS_NEAR_EXIT)

const NEIGHBORS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
const cellOf = (pos) => [Math.floor(pos[0] / CELL), Math.floor(pos[1] / CELL)]
const keyOf = (cx, cy) => `${cx},${cy}`
const centerOf = (cx, cy) => [(cx + 0.5) * CELL, (cy + 0.5) * CELL]

// { cost: cell key -> cost under every road piece, core: cells at least EDGE_CELLS inside the road },
// or null when the zone has no road pieces.
const groundCache = new Map()
const groundOf = (zoneId) => {
    if (!groundCache.has(zoneId)) {
        const rects = ground[zones[zoneId]?.layout]
        let out = null
        if (rects?.length) {
            const cost = new Map()
            for (const [x, y, w, d, offroad] of rects) {
                for (let cx = Math.floor((x - w / 2) / CELL); cx < Math.ceil((x + w / 2) / CELL); cx++) {
                    for (let cy = Math.floor((y - d / 2) / CELL); cy < Math.ceil((y + d / 2) / CELL); cy++) {
                        const key = keyOf(cx, cy)
                        if (!offroad || !cost.has(key)) cost.set(key, offroad ? OFFROAD_COST : ROAD_COST)
                    }
                }
            }
            // ponytail: a straight corridor to the nearest road cell; a portal set at an angle to its road would need its piece's rotation.
            const roadCells = [...cost.keys()].map((key) => centerOf(...key.split(',').map(Number)))
            // Per exit slot, the unit direction from the portal out along its corridor.
            const approach = {}
            for (const exit of zones[zoneId].exits || []) {
                let near = null
                for (const cell of roadCells) {
                    if (!near || Math.hypot(cell[0] - exit.x, cell[1] - exit.y) < Math.hypot(near[0] - exit.x, near[1] - exit.y)) near = cell
                }
                const length = Math.hypot(near[0] - exit.x, near[1] - exit.y) || 1
                const [ux, uy] = [(near[0] - exit.x) / length, (near[1] - exit.y) / length]
                approach[exit.slot] = [ux, uy]
                for (let along = -APPROACH_HALF_WIDTH; along <= length + CELL * EDGE_CELLS; along += CELL / 2) {
                    for (let across = -APPROACH_HALF_WIDTH; across <= APPROACH_HALF_WIDTH; across += CELL / 2) {
                        const key = keyOf(...cellOf([exit.x + ux * along - uy * across, exit.y + uy * along + ux * across]))
                        if (!cost.has(key)) cost.set(key, ROAD_COST)
                    }
                }
            }
            const core = new Set()
            for (const key of cost.keys()) {
                const [cx, cy] = key.split(',').map(Number)
                let inside = true
                for (let dx = -EDGE_CELLS; dx <= EDGE_CELLS && inside; dx++) {
                    for (let dy = -EDGE_CELLS; dy <= EDGE_CELLS && inside; dy++) inside = cost.has(keyOf(cx + dx, cy + dy))
                }
                if (inside) core.add(key)
            }
            const main = new Set([...core].filter((key) => cost.get(key) === ROAD_COST))
            // Cells from the nearest edge, by a breadth-first walk in from the cells that touch one.
            const depth = new Map()
            const queue = []
            for (const key of cost.keys()) {
                const [cx, cy] = key.split(',').map(Number)
                if (NEIGHBORS.some(([dx, dy]) => !cost.has(keyOf(cx + dx, cy + dy)))) {
                    depth.set(key, 1)
                    queue.push([cx, cy])
                }
            }
            for (let i = 0; i < queue.length; i++) {
                const [cx, cy] = queue[i]
                for (const [dx, dy] of NEIGHBORS) {
                    const key = keyOf(cx + dx, cy + dy)
                    if (!cost.has(key) || depth.has(key)) continue
                    depth.set(key, depth.get(keyOf(cx, cy)) + 1)
                    queue.push([cx + dx, cy + dy])
                }
            }
            for (const [key, d] of depth) cost.set(key, cost.get(key) + CENTER_COST / d)
            out = { cost, core, main, depth, approach }
        }
        groundCache.set(zoneId, out)
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
                // Walls saved at portals by older versions were the portal's own collider.
                const kept = blocked.filter((key) => !nearExit(id, centerOf(...key.split(',').map(Number))))
                if (kept.length < blocked.length) this.dirty = true
                this.zones[id] = { walked: new Set(walked), blocked: new Set(kept) }
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
        if (zone.walked.has(key) || zone.blocked.has(key) || nearExit(zoneId, pos)) return
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

// Line of sight over the grid: true when no blocked cell sits between a and b, and the line keeps
// clear of the road edges, except near an end that is itself off the road (a portal). The last
// cell and a half before b is skipped: a portal's own collider gets marked blocked.
const clearLine = (trails, zoneId, a, b) => {
    const ground = groundOf(zoneId)
    // Between two points on the main road, a straight line must not cut across a side path.
    const onMain = (p) => ground.main.has(keyOf(...cellOf(p)))
    const core = ground && (onMain(a) && onMain(b) ? ground.main : ground.core)
    const freeA = core && !core.has(keyOf(...cellOf(a))) ? OFF_GROUND_FREE : 0
    const freeB = core && !core.has(keyOf(...cellOf(b))) ? OFF_GROUND_FREE : 0
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.ceil(length / (CELL / 2))
    for (let i = 1; i <= steps; i++) {
        const t = i / steps
        if (length * (1 - t) < CELL * 1.5) break
        const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        if (trails.isBlocked(zoneId, point)) return false
        const nearFreeEnd = length * t < freeA || length * (1 - t) < freeB
        if (core && !nearFreeEnd && !core.has(keyOf(...cellOf(point)))) return false
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
    // Where the road pieces are known they beat the walked trail, which also records every wall scrape.
    const groundCost = groundOf(zoneId)?.cost
    const costOf = (key) => groundCost ? groundCost.get(key) ?? OFF_GROUND_COST : walked.has(key) ? WALKED_COST : UNKNOWN_COST
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
