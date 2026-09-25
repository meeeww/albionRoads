const { once } = require('events')
const { RoadTracker, exitsOf, nameOf } = require('../src/roads')
const { planStep, markWallAhead } = require('../src/road-paths')
const { sleep } = require('../src/utils')

const EXPLORE = process.argv.includes('--explore')
// Clicks stay this many pixels from the character so they land on the ground, not the UI.
const STEP_PX = 220
const PORTAL_TIMEOUT_MS = 4 * 60 * 1000
const CALIBRATION_PX = [[180, 0], [0, 180], [-180, -180]]

// Solves d = A * s + b from three (screen offset -> world offset) samples.
const solveAffine = (samples) => {
    const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    const rows = samples.map(({ s }) => [s[0], s[1], 1])
    const det = det3(rows)
    if (Math.abs(det) < 1e-9) throw new Error('Calibration clicks were collinear')
    const solveFor = (axis) => [0, 1, 2].map((col) => det3(rows.map((row, i) => {
        const copy = [...row]
        copy[col] = samples[i].d[axis]
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

    let expectedMouse = null
    const click = ([sx, sy]) => {
        const now = robot.getMousePos()
        if (expectedMouse && Math.hypot(now.x - expectedMouse[0], now.y - expectedMouse[1]) > 30) {
            throw new Error('Mouse moved by hand, stopping.')
        }
        expectedMouse = [Math.round(cx + sx), Math.round(cy + sy)]
        robot.moveMouse(...expectedMouse)
        robot.mouseClick('left')
    }

    win.setForeground()
    await sleep(500)

    console.log('Calibrating: the character will take three short steps.')
    const samples = []
    for (const s of CALIBRATION_PX) {
        const waiting = withTimeout(tracker, 'move', 3000)
        click(s)
        const move = await waiting
        if (!move?.target) throw new Error('No move packet after a calibration click. Is the game focused?')
        samples.push({ s, d: [move.target[0] - move.pos[0], move.target[1] - move.pos[1]] })
        await sleep(800)
    }
    const view = solveAffine(samples)

    const usePortal = async (exit) => {
        const target = [exit.x, exit.y]
        const started = Date.now()
        let last = tracker.pos
        let stuck = 0
        while (Date.now() - started < PORTAL_TIMEOUT_MS) {
            const step = planStep(tracker.trails, tracker.zone, tracker.pos, target, view.toScreen, STEP_PX)
            if (!step) return 'unreachable'
            if (step.final) {
                const zone = withTimeout(tracker, 'zone', 20000)
                click(step.screen)
                return await zone ? 'arrived' : 'closed'
            }
            click(step.screen)
            await sleep(700)
            const pos = tracker.pos
            if (Math.hypot(pos[0] - last[0], pos[1] - last[1]) < 0.8) {
                if (++stuck >= 2) {
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

    const home = tracker.zone
    const closed = new Set()
    for (;;) {
        if (tracker.zone !== home) throw new Error(`Ended up in ${nameOf(tracker.zone)} instead of ${nameOf(home)}.`)
        const next = exitsOf(home)
            .filter((exit) => exit.kind === 'tunnelexit' && !closed.has(exit.slot) && !tracker.linkOf(home, exit.slot))
            .sort((a, b) => Math.hypot(a.x - tracker.pos[0], a.y - tracker.pos[1]) - Math.hypot(b.x - tracker.pos[0], b.y - tracker.pos[1]))[0]
        if (!next) break

        console.log(`\nWalking to exit (${next.x}, ${next.y})`)
        const result = await usePortal(next)
        if (result !== 'arrived') {
            console.log(result === 'closed'
                ? 'Clicked the portal but the zone did not change, treating that exit as closed.'
                : 'Could not find a way to that exit, skipping it.')
            closed.add(next.slot)
            continue
        }

        await sleep(3000)
        const back = exitsOf(tracker.zone).find((exit) => exit.slot === tracker.linkOf(home, next.slot)?.slot)
        if (!back) throw new Error(`Arrived in ${nameOf(tracker.zone)} but not next to a known exit, stopping.`)
        console.log(`Going back to ${nameOf(home)}`)
        if (await usePortal(back) !== 'arrived') throw new Error('Could not go back through the portal.')
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
