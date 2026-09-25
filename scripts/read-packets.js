const { initListener } = require('../src/event-listener')
const { startInspector, recordMessage } = require('../src/inspector')

startInspector()
console.log('Reading packets only. The bot will not click or cast.')

const listener = initListener({
    readyMessage: 'Listening. Fish by hand; packets show up at http://127.0.0.1:4789',
})

listener.on('event', (message) => recordMessage('event', message))
listener.on('request', (message) => recordMessage('request', message))
