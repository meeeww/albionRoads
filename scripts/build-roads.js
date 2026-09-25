// Regenerates data/zones.json from the public ao-bin-dumps game data.
// Run again after a game patch that changes the Roads layout.
const fs = require('fs')
const path = require('path')

const BASE = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/cluster/'

const get = async (file) => {
    const res = await fetch(BASE + file)
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    return res.text()
}

const main = async () => {
    const world = await get('world.xml')

    const zones = {}
    for (const [, id, file, name] of world.matchAll(/<cluster id="([^"]+)" file="([^"]+)" displayname="([^"]*)"/g)) {
        zones[id] = { name, file }
    }

    const exitSlots = {}
    for (const [, id, body] of world.matchAll(/<cluster id="([^"]+)">([\s\S]*?)<\/cluster>/g)) {
        const slots = [...body.matchAll(/<(tunnelexit|mistscityentrance) path="([^"/]+)\//g)]
            .map(([, kind, slot]) => ({ kind, slot }))
        if (slots.length && zones[id] && id.startsWith('TNL-')) exitSlots[id] = slots
    }

    const ids = Object.keys(exitSlots)
    console.log(`${Object.keys(zones).length} zones, ${ids.length} with road exits`)

    for (let i = 0; i < ids.length; i += 16) {
        await Promise.all(ids.slice(i, i + 16).map(async (id) => {
            const layout = await get(zones[id].file)
            const positions = {}
            for (const [, slot, x, y] of layout.matchAll(/<templateinstance id="([^"]+)"[^>]*? pos="(-?[\d.]+) -?[\d.]+ (-?[\d.]+)"/g)) {
                positions[slot] = [Number(x), Number(y)]
            }
            zones[id].exits = exitSlots[id]
                .filter(({ slot }) => positions[slot])
                .map(({ kind, slot }) => ({ slot, kind, x: positions[slot][0], y: positions[slot][1] }))
        }))
    }

    const out = {}
    for (const [id, { name, exits }] of Object.entries(zones)) out[id] = exits ? { name, exits } : { name }
    const outPath = path.join(__dirname, '..', 'data', 'zones.json')
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(out))
    console.log(`\nWrote ${outPath}`)
}

main().catch((error) => {
    console.error(error.message)
    process.exit(1)
})
