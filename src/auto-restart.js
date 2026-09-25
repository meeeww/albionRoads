class AutoRestart {
    timeoutTime = 15000
    actionOnTimeout = () => { }
    id = 0

    constructor(
        actionOnTimeout,
        timeoutTime,
    ) {
        this.timeoutTime = timeoutTime
        this.actionOnTimeout = actionOnTimeout
    }

    turnOn = () => {
        this.armed = true
        clearTimeout(this.id)
        this.id = setTimeout(() => this.fire(), this.timeoutTime)
    }

    fire = () => {
        Promise.resolve(this.actionOnTimeout()).finally(() => {
            if (this.armed) this.turnOn()
        })
    }

    turnOff = () => {
        this.armed = false
        clearTimeout(this.id)
        this.id = 0
    }

    reboundTimeout = () => {
        this.turnOn()
    }

}

module.exports = {
    AutoRestart,
}