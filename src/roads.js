const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const zones = require('../data/zones.json')

const LINKS_PATH = path.join(__dirname, '..', 'roads.jsonl')
const JOIN = 2
const MOVE = 22
// Spawn and departure points sit a few units from the portal's layout position.
const EXIT_RADIUS = 30
// ponytail: fixed guess at how long a Roads portal stays open; the game has per-portal timers we don't read yet.
const STALE_MS = 3 * 60 * 60 * 1000

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

const readLinks = () => {
    const links = new Map()
    if (!fs.existsSync(LINKS_PATH)) return links
    for (const line of fs.readFileSync(LINKS_PATH, 'utf8').split('\n')) {
        if (line.trim()) addLink(links, JSON.parse(line))
    }
    return links
}

const addLink = (links, hop) => {
    if (hop.fromSlot) links.set(`${hop.from}|${hop.fromSlot}`, { zone: hop.to, slot: hop.toSlot, t: hop.t })
    if (hop.toSlot) links.set(`${hop.to}|${hop.toSlot}`, { zone: hop.from, slot: hop.fromSlot, t: hop.t })
}

const pair = (value) => Array.isArray(value) && value.length === 2 ? [Number(value[0]), Number(value[1])] : null

const age = (t) => {
    const minutes = Math.round((Date.now() - t) / 60000)
    return minutes < 60 ? `${minutes}m ago` : `${(minutes / 60).toFixed(1)}h ago`
}

class RoadTracker extends EventEmitter {
    constructor(listener) {
        super()
        this.zone = null
        this.pos = null
        this.links = readLinks()

        listener.on('request', ({ parameters }) => {
            if (parameters?.[253] !== MOVE) return
            const pos = pair(parameters[1])
            if (!pos) return
            this.pos = pos
            this.emit('move', { pos, target: pair(parameters[3]) })
        })

        listener.on('response', ({ parameters }) => {
            if (parameters?.[253] !== JOIN || !parameters[8]) return
            const from = parameters[66] || this.zone
            const to = parameters[8]
            const fromExit = nearestExit(from, this.pos)
            this.zone = to
            this.pos = pair(parameters[9])
            const toExit = nearestExit(to, this.pos)

            if (from && from !== to) {
                const hop = { t: Date.now(), from, fromSlot: fromExit?.slot, to, toSlot: toExit?.slot }
                fs.appendFileSync(LINKS_PATH, JSON.stringify(hop) + '\n')
                addLink(this.links, hop)
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

    printZone() {
        const exits = exitsOf(this.zone)
        if (!exits.length) {
            console.log(`${nameOf(this.zone)} (${this.zone}) is not a road.`)
            return
        }
        console.log(`${nameOf(this.zone)} (${this.zone}), ${exits.length} exits:`)
        exits.forEach((exit, index) => {
            const link = this.linkOf(this.zone, exit.slot)
            const where = exit.kind === 'mistscityentrance' ? 'mists city entrance'
                : link ? `${nameOf(link.zone)} (${age(link.t)})` : 'unknown'
            console.log(`  ${index + 1}. (${exit.x}, ${exit.y}) -> ${where}`)
        })
    }
}

module.exports = { RoadTracker, nearestExit, exitsOf, nameOf }
