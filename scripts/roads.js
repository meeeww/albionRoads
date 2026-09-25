const { once } = require('events')
const { RoadTracker, exitsOf, nameOf } = require('../src/roads')
const { planStep, markWallAhead, CELL } = require('../src/road-paths')
const { sleep } = require('../src/utils')

const EXPLORE = process.argv.includes('--explore')
// Clicks stay this many pixels from the character so they land on the ground, not the UI.
const STEP_PX = 220
const PORTAL_TIMEOUT_MS = 4 * 60 * 1000
// How often the held cursor is re-aimed along the route.
const STEER_MS = 400
// Without a portal, trees and rocks close the road into a portal spot. Getting no closer for
// this long while this near the spot means it's closed right now.
const CLOSED_NEAR_UNITS = 120
const NO_PROGRESS_MS = 20000
const CALIBRATION_PX = [[180, 0], [0, 180], [-180, -180], [-150, 120]]
// Least-squares fit of d = A * s + b over (screen offset -> world offset) samples.
const solveAffine = (samples) => {
    const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const rhs = [[0, 0, 0], [0, 0, 0]]
    for (const { s, d } of samples) {
        const row = [s[0], s[1], 1]
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) normal[i][j] += row[i] * row[j]
            rhs[0][i] += row[i] * d[0]
            rhs[1][i] += row[i] * d[1]
        }
    }
    const det = det3(normal)
    if (Math.abs(det) < 1e-9) throw new Error('Calibration clicks were collinear')
    const solveFor = (axis) => [0, 1, 2].map((col) => det3(normal.map((row, i) => {
        const copy = [...row]
        copy[col] = rhs[axis][i]
        return copy
    })) / det)
    const [a, b, e] = solveFor(0)
    const [c, d, f] = solveFor(1)
    const inv = a * d - b * c
    if (Math.abs(inv) < 1e-9) throw new Error('Calibration is degenerate')
    return {
        toWorld: ([sx, sy]) => [a * sx + b * sy + e, c * sx + d * sy + f],
        toScreen: ([wx, wy]) => {
            const x = wx - e
            const y = wy - f
            return [(d * x - b * y) / inv, (a * y - c * x) / inv]
        },
    }
}

const withTimeout = (emitter, name, ms) => once(emitter, name, { signal: AbortSignal.timeout(ms) })
    .then(([value]) => value, () => null)

const explore = async (tracker) => {
    const robot = require('robotjs')
    const { Window } = require('../src/window')
    const { getTargetCoordinates } = require('../src/dimensions')

    const win = Window.getByTitle('Albion Online Client')
    if (!win) throw new Error('Albion Online Client window not found')
    const [cx, cy] = getTargetCoordinates(win).center

    // Bit 1 of GetAsyncKeyState means "pressed since the last call", so reading it right after each
    // of our own presses leaves it set only by the user's clicks.
    const GetAsyncKeyState = require('koffi').load('user32.dll').func('short __stdcall GetAsyncKeyState(int vKey)')
    const forgetOwnPress = () => { GetAsyncKeyState(0x01); GetAsyncKeyState(0x02) }
    let holding = false
    const aim = ([sx, sy]) => {
        const left = GetAsyncKeyState(0x01)
        // A user's click while we hold also releases the button we're holding.
        if ((left & 1) || (GetAsyncKeyState(0x02) & 1) || (holding && !(left & 0x8000))) {
            throw new Error('Mouse clicked by hand, stopping.')
        }
        robot.moveMouse(Math.round(cx + sx), Math.round(cy + sy))
    }
    const release = () => {
        if (!holding) return
        robot.mouseToggle('up', 'left')
        holding = false
        forgetOwnPress()
    }
    process.on('exit', release)
    const click = (screen) => {
        release()
        aim(screen)
        robot.mouseClick('left')
        forgetOwnPress()
    }
    // Holding the button keeps the character walking toward the cursor, so steering is just moving it.
    const hold = (screen) => {
        aim(screen)
        if (holding) return
        robot.mouseToggle('down', 'left')
        holding = true
        forgetOwnPress()
    }

    let lastTarget = null
    tracker.on('move', ({ target }) => { if (target) lastTarget = target })
    // Resolves with the first move whose target changed, so a position update still carrying the
    // previous click's target isn't mistaken for the answer to this click.
    const nextTarget = (ms) => new Promise((resolve) => {
        const previous = lastTarget
        const done = (move) => {
            clearTimeout(timer)
            tracker.off('move', onMove)
            resolve(move)
        }
        const onMove = (move) => {
            if (!move.target) return
            if (previous && Math.hypot(move.target[0] - previous[0], move.target[1] - previous[1]) < 0.3) return
            done(move)
        }
        const timer = setTimeout(() => done(null), ms)
        tracker.on('move', onMove)
    })

    win.setForeground()
    await sleep(500)
    forgetOwnPress()

    console.log('Calibrating: the character will take four short steps.')
    const firstSamples = []
    for (const s of CALIBRATION_PX) {
        const waiting = nextTarget(3000)
        click(s)
        const move = await waiting
        if (!move) throw new Error('No move packet after a calibration click. Is the game focused?')
        firstSamples.push({ s, d: [move.target[0] - move.pos[0], move.target[1] - move.pos[1]] })
        await sleep(1200)
    }
    // Only separate clicks calibrate: while the button is held, the game's move target is a point
    // just ahead of the character, not the ground under the cursor.
    const view = solveAffine(firstSamples)

    const usePortal = async (exit) => {
        try {
            return await walkThrough(exit)
        } finally {
            release()
        }
    }

    const walkThrough = async (exit) => {
        const target = [exit.x, exit.y]
        const started = Date.now()
        let last = tracker.pos
        let stuck = 0
        const distance = () => Math.hypot(target[0] - tracker.pos[0], target[1] - tracker.pos[1])
        let closest = distance()
        let closerAt = Date.now()
        while (Date.now() - started < PORTAL_TIMEOUT_MS) {
            if (distance() < closest - 3) {
                closest = distance()
                closerAt = Date.now()
            } else if (closest < CLOSED_NEAR_UNITS && Date.now() - closerAt > NO_PROGRESS_MS) {
                return 'closed'
            }
            const step = planStep(tracker.trails, tracker.zone, tracker.pos, target, view.toScreen, STEP_PX)
            if (!step) return 'unreachable'
            if (step.final) {
                const zone = withTimeout(tracker, 'zone', 20000)
                // A portal ignores clicks for several seconds after coming through it, so keep clicking.
                for (let tries = 0; tries < 10; tries++) {
                    click(view.toScreen([target[0] - tracker.pos[0], target[1] - tracker.pos[1]]))
                    if (await Promise.race([zone, sleep(2000)])) return 'arrived'
                }
                if (await zone) return 'arrived'
                // Standing at the spot with no zone change means no portal has spawned there.
                return distance() < CLOSED_NEAR_UNITS ? 'closed' : 'unreachable'
            }
            hold(step.screen)
            await sleep(STEER_MS)
            const pos = tracker.pos
            if (Math.hypot(pos[0] - last[0], pos[1] - last[1]) < 0.8) {
                stuck++
                // A held button sometimes stops moving the character; a fresh click gets it going again.
                if (stuck === 2) click(step.screen)
                if (stuck >= 4) {
                    markWallAhead(tracker.trails, tracker.zone, pos, step.world)
                    stuck = 0
                }
            } else {
                stuck = 0
            }
            last = pos
        }
        return 'unreachable'
    }

    // Outside the roads there's no layout data, but the portal stands right next to the arrival spot.
    // ponytail: clicks a ring around the arrival spot; learning the portal position from its spawn packet would be exact.
    const goBackBlind = async () => {
        const spawn = tracker.pos
        const zone = withTimeout(tracker, 'zone', 90000)
        try {
            for (let round = 0; round < 2; round++) {
                for (const radius of [6, 12]) {
                    for (let i = 0; i < 8; i++) {
                        const angle = i * Math.PI / 4
                        const spot = [spawn[0] + radius * Math.cos(angle), spawn[1] + radius * Math.sin(angle)]
                        click(view.toScreen([spot[0] - tracker.pos[0], spot[1] - tracker.pos[1]]))
                        if (await Promise.race([zone, sleep(2500)])) return true
                    }
                }
            }
            return false
        } finally {
            release()
        }
    }

    const home = tracker.zone
    const skipped = new Set()
    for (;;) {
        if (tracker.zone !== home) throw new Error(`Ended up in ${nameOf(tracker.zone)} instead of ${nameOf(home)}.`)
        const next = exitsOf(home)
            .filter((exit) => exit.kind === 'tunnelexit' && !skipped.has(exit.slot)
                && !tracker.linkOf(home, exit.slot) && !tracker.closedAt(home, exit.slot))
            .sort((a, b) => Math.hypot(a.x - tracker.pos[0], a.y - tracker.pos[1]) - Math.hypot(b.x - tracker.pos[0], b.y - tracker.pos[1]))[0]
        if (!next) break

        const number = exitsOf(home).indexOf(next) + 1
        const away = Math.hypot(next.x - tracker.pos[0], next.y - tracker.pos[1])
        console.log(`\nWalking to unknown exit ${number} (${next.x}, ${next.y}), ${Math.round(away)} units away`)
        const result = await usePortal(next)
        if (result === 'closed') {
            console.log('No portal there right now, marked as closed for the next hour.')
            tracker.markClosed(home, next.slot)
            // The walls learned there are the closed road; they're gone once a portal opens.
            const { blocked } = tracker.trails.of(home)
            for (const key of blocked) {
                const [x, y] = key.split(',').map((v) => (Number(v) + 0.5) * CELL)
                if (Math.hypot(x - next.x, y - next.y) < CLOSED_NEAR_UNITS) blocked.delete(key)
            }
            tracker.trails.dirty = true
            continue
        }
        if (result !== 'arrived') {
            console.log('Could not find a way to that exit, skipping it this run.')
            skipped.add(next.slot)
            continue
        }

        await sleep(3000)
        const back = exitsOf(tracker.zone).find((exit) => exit.slot === tracker.linkOf(home, next.slot)?.slot)
        console.log(`Going back to ${nameOf(home)}`)
        const wentBack = back ? await usePortal(back) === 'arrived' : await goBackBlind()
        if (!wentBack) throw new Error('Could not go back through the portal.')
        await sleep(3000)
    }

    console.log(`\nDone. Every open exit of ${nameOf(home)}:`)
    tracker.printZone()
}

if (require.main === module) {
    const { initListener } = require('../src/event-listener')
    const listener = initListener({
        readyMessage: EXPLORE
            ? 'Listening. Change zone once so the bot knows where you are; exploring starts right after.'
            : 'Listening. Change zone once and the current road\'s exits will print here.',
    })
    const tracker = new RoadTracker(listener)
    require('../src/road-map').startRoadMap(tracker)
    process.on('exit', () => tracker.trails.save())
    process.on('SIGINT', () => process.exit(0))

    if (EXPLORE) {
        once(tracker, 'zone').then(async () => {
            await sleep(3000)
            await explore(tracker)
        }).catch((error) => {
            console.log(error.message)
        }).finally(() => process.exit(0))
    }
}

module.exports = { solveAffine }
