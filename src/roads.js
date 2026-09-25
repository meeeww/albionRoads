const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const zones = require('../data/zones.json')
const { Trails } = require('./road-paths')

const LINKS_PATH = path.join(__dirname, '..', 'roads.jsonl')
const JOIN = 2
const MOVE = 22
// Spawn and departure points sit a few units from the portal's layout position.
const EXIT_RADIUS = 30
// ponytail: fixed guess at how long a Roads portal stays open; the game has per-portal timers we don't read yet.
const STALE_MS = 3 * 60 * 60 * 1000
// ponytail: an empty portal spot is skipped for this long, then checked again; real spawn times are unknown.
const CLOSED_MS = 60 * 60 * 1000

const nameOf = (id) => zones[id]?.name || id
const exitsOf = (id) => zones[id]?.exits || []

const nearestExit = (zoneId, pos) => {
    if (!pos) return null
    let best = null
    let bestDistance = EXIT_RADIUS
    for (const exit of exitsOf(zoneId)) {
        const distance = Math.hypot(exit.x - pos[0], exit.y - pos[1])
        if (distance < bestDistance) {
            best = exit
            bestDistance = distance
        }
    }
    return best
}

// roads.jsonl holds hops ({from, fromSlot, to, toSlot}) and empty portal spots ({zone, slot, closed}).
const readLog = () => {
    const log = { links: new Map(), closed: new Map() }
    if (!fs.existsSync(LINKS_PATH)) return log
    for (const line of fs.readFileSync(LINKS_PATH, 'utf8').split('\n')) {
        if (line.trim()) addEntry(log, JSON.parse(line))
    }
    return log
}

const addEntry = ({ links, closed }, entry) => {
    if (entry.closed) {
        closed.set(`${entry.zone}|${entry.slot}`, entry.t)
        return
    }
    for (const [zone, slot, other, otherSlot] of [
        [entry.from, entry.fromSlot, entry.to, entry.toSlot],
        [entry.to, entry.toSlot, entry.from, entry.fromSlot],
    ]) {
        if (!slot) continue
        links.set(`${zone}|${slot}`, { zone: other, slot: otherSlot, t: entry.t })
        closed.delete(`${zone}|${slot}`)
    }
}

const pair = (value) => Array.isArray(value) && value.length === 2 ? [Number(value[0]), Number(value[1])] : null

const age = (t) => {
    const minutes = Math.round((Date.now() - t) / 60000)
    return minutes < 60 ? `${minutes}m ago` : `${(minutes / 60).toFixed(1)}h ago`
}

class RoadTracker extends EventEmitter {
    constructor(listener, trails = new Trails()) {
        super()
        this.zone = null
        this.pos = null
        const log = readLog()
        this.log = log
        this.links = log.links
        this.trails = trails
        setInterval(() => trails.save(), 15000).unref()

        listener.on('request', ({ parameters }) => {
            if (parameters?.[253] !== MOVE) return
            const pos = pair(parameters[1])
            if (!pos) return
            this.pos = pos
            if (this.zone) trails.markWalked(this.zone, pos)
            this.emit('move', { pos, target: pair(parameters[3]) })
        })

        listener.on('response', ({ parameters }) => {
            if (parameters?.[253] !== JOIN || !parameters[8]) return
            const from = parameters[66] || this.zone
            const to = parameters[8]
            const fromExit = nearestExit(from, this.pos)
            this.zone = to
            this.pos = pair(parameters[9])
            if (this.pos) this.trails.markWalked(to, this.pos)
            this.trails.save()
            const toExit = nearestExit(to, this.pos)

            if (from && from !== to) {
                const hop = { t: Date.now(), from, fromSlot: fromExit?.slot, to, toSlot: toExit?.slot }
                fs.appendFileSync(LINKS_PATH, JSON.stringify(hop) + '\n')
                addEntry(this.log, hop)
                console.log(`\n${nameOf(from)} -> ${nameOf(to)}`)
            }
            this.printZone()
            this.emit('zone', { from, to })
        })
    }

    linkOf(zoneId, slot) {
        const link = this.links.get(`${zoneId}|${slot}`)
        return link && Date.now() - link.t < STALE_MS ? link : null
    }

    closedAt(zoneId, slot) {
        const t = this.log.closed.get(`${zoneId}|${slot}`)
        return t && Date.now() - t < CLOSED_MS ? t : null
    }

    markClosed(zoneId, slot) {
        const entry = { t: Date.now(), zone: zoneId, slot, closed: true }
        fs.appendFileSync(LINKS_PATH, JSON.stringify(entry) + '\n')
        addEntry(this.log, entry)
    }

    printZone() {
        const exits = exitsOf(this.zone)
        if (!exits.length) {
            console.log(`${nameOf(this.zone)} (${this.zone}) is not a road.`)
            return
        }
        console.log(`${nameOf(this.zone)} (${this.zone}), ${exits.length} exits:`)
        exits.forEach((exit, index) => {
            const link = this.linkOf(this.zone, exit.slot)
            const closed = this.closedAt(this.zone, exit.slot)
            const where = exit.kind === 'mistscityentrance' ? 'mists city entrance'
                : link ? `${nameOf(link.zone)} (${age(link.t)})`
                : closed ? `no portal right now (checked ${age(closed)})` : 'unknown'
            console.log(`  ${index + 1}. (${exit.x}, ${exit.y}) -> ${where}`)
        })
    }
}

module.exports = { RoadTracker, nearestExit, exitsOf, nameOf, STALE_MS }
