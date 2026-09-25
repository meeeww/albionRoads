// Lists every value in packets.jsonl that looks like a time in the future, to find which
// message carries a Roads portal's closing time. Run after a capture: npm run find-timers
const fs = require('fs')
const path = require('path')

const TICKS_AT_EPOCH = 621355968000000000n
const HOUR = 3600 * 1000

// Albion sends times as .NET ticks (100 ns since year 1), as 18-digit numbers or strings.
const asTime = (value) => {
    if (!/^63\d{16}$/.test(String(value))) return null
    return Number((BigInt(value) - TICKS_AT_EPOCH) / 10000n)
}

const found = []
const walk = (value, keyPath, message) => {
    if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${keyPath}[${i}]`, message))
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => walk(v, `${keyPath}.${k}`, message))
    const time = asTime(value)
    if (!time) return
    const ahead = time - message.t
    if (ahead > 60 * 1000 && ahead < 48 * HOUR) found.push({ message, keyPath, ahead })
}

// With the timer seen in game (npm run find-timers 10h01m), every number is also tried as that
// time in other units: time left or closing time, in seconds, ms, minutes or ticks.
const [, hours = 0, minutes = 0] = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/i.exec(process.argv[2] || '') || []
const seenLeft = (hours * 60 + +minutes) * 60000
const TOLERANCE = 3 * 60000
const ENCODINGS = [
    ['seconds left', (v, t) => v * 1000],
    ['ms left', (v, t) => v],
    ['minutes left', (v, t) => v * 60000],
    ['ticks left', (v, t) => v / 10000],
    ['unix seconds', (v, t) => v * 1000 - t],
    ['unix ms', (v, t) => v - t],
    ['.NET ticks', (v, t) => (v - Number(TICKS_AT_EPOCH)) / 10000 - t],
]
const matches = []
const tryUnits = (value, keyPath, message) => {
    if (Array.isArray(value)) return value.forEach((item, i) => tryUnits(item, `${keyPath}[${i}]`, message))
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => tryUnits(v, `${keyPath}.${k}`, message))
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0 || /\.(252|253|255)$/.test(keyPath)) return
    for (const [unit, leftOf] of ENCODINGS) {
        if (Math.abs(leftOf(number, message.t) - seenLeft) < TOLERANCE) matches.push({ message, keyPath, unit, value })
    }
}

const file = path.join(__dirname, '..', 'packets.jsonl')
const unread = { undecoded: 0, encrypted: 0 }
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.kind in unread) unread[message.kind]++
    walk(message.parameters, 'parameters', message)
    if (seenLeft) tryUnits(message.parameters, 'parameters', message)
}
console.log(`Unreadable messages: ${unread.undecoded} undecoded, ${unread.encrypted} encrypted packets.`)

if (seenLeft) {
    console.log(`Numbers that could mean ${hours}h ${minutes}m left (within 3 min):`)
    for (const { message, keyPath, unit, value } of matches) {
        const code = message.kind === 'event' ? message.parameters[252] : message.parameters[253]
        console.log(`${new Date(message.t).toLocaleTimeString()}  ${message.kind} ${code}  ${keyPath} = ${value}  as ${unit}`)
    }
    if (!matches.length) console.log('  none')
    console.log()
}

for (const { message, keyPath, ahead } of found) {
    const code = message.kind === 'event' ? message.parameters[252] : message.parameters[253]
    const h = Math.floor(ahead / HOUR)
    const m = Math.round((ahead % HOUR) / 60000)
    console.log(`${new Date(message.t).toLocaleTimeString()}  ${message.kind} ${code}  ${keyPath}  closes in ${h}h ${m}m`)
    console.log(`  ${JSON.stringify(message.parameters).slice(0, 300)}`)
}
if (!found.length) console.log('No future times found in packets.jsonl.')
