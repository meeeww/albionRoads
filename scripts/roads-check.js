const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { RoadTracker, nearestExit } = require('../src/roads')
const { Trails, planStep, markWallAhead, findPath, clearLine, groundOf, CELL } = require('../src/road-paths')
const { solveAffine } = require('./roads')

// Every road has exits, including roads that reuse another road's layout file.
const zones = require('../data/zones.json')
const roadsWithoutExits = Object.keys(zones).filter((id) => id.startsWith('TNL-') && !zones[id].exits?.length)
assert.deepStrictEqual(roadsWithoutExits, [], 'roads without exits')
assert.strictEqual(zones['TNL-341'].exits.length, 4)

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

// With several noisy clicks the least-squares fit still lands within a fraction of a unit.
const noisy = [[180, 0], [0, 180], [-180, -180], [-150, 120], [200, 90], [-60, -210]]
    .map((s, i) => ({ s, d: truth(s).map((v) => v + (i % 2 ? 0.2 : -0.2)) }))
const fitted = solveAffine(noisy).toWorld([120, -80])
assert.ok(Math.hypot(fitted[0] - truth([120, -80])[0], fitted[1] - truth([120, -80])[1]) < 0.5, 'noisy fit')

// An old trail that leads elsewhere must not pull the route into a long detour.
const detour = new Trails(null)
for (let y = 0; y <= 200; y += 1) detour.markWalked('NO-GROUND', [0, y])
for (let x = 0; x <= 200; x += 1) detour.markWalked('NO-GROUND', [x, 200])
const route = findPath(detour, 'NO-GROUND', [0, 0], [200, 0])
const routeLength = route.reduce((sum, p, i) => i ? sum + Math.hypot(p[0] - route[i - 1][0], p[1] - route[i - 1][1]) : 0, 0)
assert.ok(routeLength < 260, `route went straight instead of along the old trail (${Math.round(routeLength)} units)`)

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

    // An empty portal spot stays closed until someone actually goes through it.
    tracker.markClosed('TNL-125', 'instanceslot_10')
    assert.ok(tracker.closedAt('TNL-125', 'instanceslot_10'))
    assert.ok(new RoadTracker(new EventEmitter(), new Trails(null)).closedAt('TNL-125', 'instanceslot_10'), 'closed spot persists')
    listener.emit('request', { parameters: { 253: 22, 1: [45, -270], 3: [45, -275] } })
    listener.emit('response', { parameters: { 253: 2, 8: 'TNL-126', 66: 'TNL-125', 9: [95, 240] } })
    assert.strictEqual(tracker.closedAt('TNL-125', 'instanceslot_10'), null)

    // With every exit of a road settled, the bot heads for the nearest road with unknown exits,
    // passing only through roads.
    const settle = (zone) => tracker.unknownExits(zone).forEach((exit) => tracker.markClosed(zone, exit.slot))
    settle('TNL-109')
    assert.deepStrictEqual(tracker.routeToUnexplored('TNL-109').map((hop) => hop.to), ['TNL-125'])
    settle('TNL-125')
    assert.deepStrictEqual(tracker.routeToUnexplored('TNL-109').map((hop) => hop.to), ['TNL-125', 'TNL-126'])
    assert.strictEqual(tracker.routeToUnexplored('TNL-109')[1].exit.slot, 'instanceslot_10')
    listener.emit('request', { parameters: { 253: 22, 1: [45, -270], 3: [45, -275] } })
    listener.emit('response', { parameters: { 253: 2, 8: '4214', 66: 'TNL-126', 9: [0, 0] } })
    settle('TNL-126')
    assert.strictEqual(tracker.routeToUnexplored('TNL-109'), null, 'no road left with unknown exits')
} finally {
    if (saved) fs.writeFileSync(linksPath, saved)
    else fs.rmSync(linksPath, { force: true })
}

// With nothing known in the way, a far portal is aimed at in a straight line, not a 45° grid zig-zag.
{
    const aim = planStep(new Trails(null), 'NO-GROUND', [0, 0], [300, 90], ([dx, dy]) => [dx * 10, -dy * 10], 220)
    const angle = Math.atan2(-aim.screen[1], aim.screen[0]) - Math.atan2(90, 300)
    assert.ok(Math.abs(angle) < 0.01, `aimed ${(angle * 180 / Math.PI).toFixed(1)}° off the straight line`)
    assert.ok(Math.abs(Math.hypot(...aim.screen) - 220) < 1e-6, 'aim stays within the step radius')
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
const zone = 'NO-GROUND'
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

// Routes between real portals follow the road pieces instead of cutting across to the portal.
// They also keep off the road edges, where the railings and rocks stand.
for (const zoneId of ['TNL-109', 'TNL-220']) {
    const { core } = groundOf(zoneId)
    const exits = zones[zoneId].exits
    for (const [a, b] of [[exits[0], exits[exits.length - 1]], [exits[1], exits[2]]]) {
        const from = [a.x, a.y]
        const to = [b.x, b.y]
        const path = findPath(new Trails(null), zoneId, from, to)
        assert.ok(path, `route ${zoneId} ${a.slot} -> ${b.slot}`)
        const nearEdge = path.filter((p) => !core.has(p.map((v) => Math.floor(v / CELL)).join()) &&
            Math.hypot(p[0] - from[0], p[1] - from[1]) > 40 && Math.hypot(p[0] - to[0], p[1] - to[1]) > 40)
        assert.ok(nearEdge.length <= path.length * 0.05, `${nearEdge.length}/${path.length} route cells at the road edge ${zoneId} ${a.slot} -> ${b.slot}`)
        const aim = planStep(new Trails(null), zoneId, from, to, ([dx, dy]) => [dx * 10, -dy * 10], 220)
        assert.ok(clearLine(new Trails(null), zoneId, from, aim.world), 'first aim stays on the road')
    }
    // A waypoint on the road gets no free zone: a corner cut that leaves the road only near the
    // waypoint (what the old 40-unit allowance let through) must not count as a clear line.
    if (zoneId !== 'TNL-109') continue
    const onCore = (p) => core.has(p.map((v) => Math.floor(v / CELL)).join())
    const route = findPath(new Trails(null), zoneId, [exits[1].x, exits[1].y], [exits[2].x, exits[2].y]).filter(onCore)
    let cut = null
    for (let i = 0; i < route.length && !cut; i += 5) {
        for (let j = i + 10; j < route.length && !cut; j += 5) {
            const [a, b] = [route[i], route[j]]
            const length = Math.hypot(b[0] - a[0], b[1] - a[1])
            const off = []
            for (let s = 1; s < length / 2; s++) {
                const p = [a[0] + (b[0] - a[0]) * s * 2 / length, a[1] + (b[1] - a[1]) * s * 2 / length]
                if (!onCore(p)) off.push(length - s * 2)
            }
            if (off.length && off.every((d) => d < 40 && d > CELL * 2)) cut = [a, b]
        }
    }
    assert.ok(cut, `found a corner cut in ${zoneId}`)
    assert.ok(!clearLine(new Trails(null), zoneId, ...cut), `corner cut near an on-road waypoint is rejected in ${zoneId}`)
}

// A message the parser can't read is reported, and the next message in the same packet still arrives.
{
    const PhotonParser = require('../vendor/photon-packet-parser')
    const command = (payload) => {
        const body = Buffer.from([0xf3, 4, ...payload])
        const header = Buffer.alloc(12)
        header[0] = 6
        header.writeUInt32BE(12 + body.length, 4)
        return Buffer.concat([header, body])
    }
    const packetHeader = Buffer.from([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0])
    const broken = command([1, 1, 5, 1]) // parameter 5 with a type code the parser doesn't know
    const good = command([1, 1, 252, 3, 7]) // event code 7
    const parser = new PhotonParser()
    const seen = []
    parser.on('undecoded', () => seen.push('undecoded'))
    parser.on('event', (event) => seen.push(event.parameters[252]))
    parser.handle(Buffer.concat([packetHeader, broken, good]))
    assert.deepStrictEqual(seen, ['undecoded', 7])
}

console.log('roads check ok')
