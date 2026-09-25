const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { RoadTracker, nearestExit } = require('../src/roads')
const { Trails, planStep, markWallAhead, findPath } = require('../src/road-paths')
const { solveAffine } = require('./roads')

// Positions from a real hop: Sebos-Ugersum portal (-75, 565) to Coros-Alieam portal (245, 305).
assert.strictEqual(nearestExit('TNL-109', [-70.2, 564.0]).slot, 'instanceslot_03')
assert.strictEqual(nearestExit('TNL-125', [239.47, 305]).slot, 'instanceslot_02')
assert.strictEqual(nearestExit('TNL-125', [0, 0]), null)

const truth = (s) => [0.05 * s[0] + 0.04 * s[1] + 0.3, -0.05 * s[0] + 0.04 * s[1] - 0.2]
const view = solveAffine([[180, 0], [0, 180], [-180, -180]].map((s) => ({ s, d: truth(s) })))
for (const s of [[100, -40], [-220, 15]]) {
    const back = view.toScreen(truth(s))
    assert.ok(Math.hypot(back[0] - s[0], back[1] - s[1]) < 1e-6, `round trip ${s}`)
}

const linksPath = path.join(__dirname, '..', 'roads.jsonl')
const saved = fs.existsSync(linksPath) ? fs.readFileSync(linksPath) : null
try {
    const listener = new EventEmitter()
    const tracker = new RoadTracker(listener, new Trails(null))
    tracker.printZone = () => {}
    listener.emit('response', { parameters: { 253: 2, 8: 'TNL-109', 9: [5, 780] } })
    listener.emit('request', { parameters: { 253: 22, 1: [-70.2, 564.0], 3: [-75, 565] } })
    listener.emit('response', { parameters: { 253: 2, 8: 'TNL-125', 66: 'TNL-109', 9: [239.47, 305] } })
    assert.strictEqual(tracker.linkOf('TNL-109', 'instanceslot_03').zone, 'TNL-125')
    assert.strictEqual(tracker.linkOf('TNL-125', 'instanceslot_02').slot, 'instanceslot_03')
} finally {
    if (saved) fs.writeFileSync(linksPath, saved)
    else fs.rmSync(linksPath, { force: true })
}

// A hidden wall at x=100 between y=200 and y=400. The walker starts in front of it and must
// learn it by bumping into it, then route around to the portal on the other side.
const hitsWall = (a, b) => {
    for (let i = 0; i <= 100; i++) {
        const x = a[0] + (b[0] - a[0]) * i / 100
        const y = a[1] + (b[1] - a[1]) * i / 100
        if (x > 98 && x < 102 && y > 200 && y < 400) return true
    }
    return false
}
const trails = new Trails(null)
const zone = 'TNL-125'
const toScreen = ([dx, dy]) => [dx * 10, -dy * 10]
const target = [140, 300]
let pos = [60, 300]
let last = pos
let stuck = 0
let reached = false
for (let i = 0; i < 600 && !reached; i++) {
    const step = planStep(trails, zone, pos, target, toScreen, 220)
    assert.ok(step, 'a route exists')
    if (step.final && !hitsWall(pos, target)) {
        reached = true
        break
    }
    const goal = step.world
    const length = Math.hypot(goal[0] - pos[0], goal[1] - pos[1])
    for (let walked = 0; walked < length; walked += 0.5) {
        const next = [pos[0] + (goal[0] - pos[0]) * 0.5 / length, pos[1] + (goal[1] - pos[1]) * 0.5 / length]
        if (hitsWall(pos, next)) break
        pos = next
        trails.markWalked(zone, pos)
    }
    if (Math.hypot(pos[0] - last[0], pos[1] - last[1]) < 0.8) {
        if (++stuck >= 2) {
            markWallAhead(trails, zone, pos, goal)
            stuck = 0
        }
    } else {
        stuck = 0
    }
    last = pos
}
assert.ok(reached, `walker got around the wall (stopped at ${pos.map(Math.round)})`)
assert.ok(trails.of(zone).blocked.size > 0, 'the wall was learned')
assert.ok(findPath(trails, zone, [60, 300], target).every(([x, y]) => !(x > 98 && x < 102 && y > 200 && y < 400)))

console.log('roads check ok')
