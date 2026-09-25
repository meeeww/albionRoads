const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { RoadTracker, nearestExit } = require('../src/roads')
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
    const tracker = new RoadTracker(listener)
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

console.log('roads check ok')
