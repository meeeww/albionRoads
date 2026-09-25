const robot = require('robotjs');
const { sleep } = require('./utils');

// Long enough for the bobber to leave the rod. A tap (50ms) never reaches the water.
const CAST_HOLD_MS = 800
let isPulling = false

class FishingActions {
    static release() {
        if (!isPulling) return
        robot.mouseToggle("up", "left")
        isPulling = false
    }

    static clickAt(x, y) {
        this.release()
        robot.moveMouse(Math.round(x), Math.round(y))
        robot.mouseClick("left")
    }

    static async throwBait(x, y) {
        console.log('action: throwBait')
        this.release()
        robot.moveMouse(Math.round(x), Math.round(y));
        robot.mouseToggle("down", "left");
        await sleep(CAST_HOLD_MS)
        robot.mouseToggle("up", "left")
    }

    static hook(x, y) {
        console.log('action: hook')
        this.clickAt(x, y)
    }

    static retrieve(x, y) {
        console.log('action: retrieve')
        this.clickAt(x, y)
    }

    static pull(x, y) {
        if (!isPulling) {
            console.log('action: pull')
            robot.moveMouse(Math.round(x), Math.round(y));
            robot.mouseToggle("down", "left");
            isPulling = true;
        }
    }

    static rest(x, y) {
        if (isPulling) {
            console.log('action: rest')
            robot.moveMouse(Math.round(x), Math.round(y));
            robot.mouseToggle("up", "left");
            isPulling = false;
        }
    }

    static cancel() {
        console.log('action: cancel');
        robot.keyTap('escape');
    }

    static async equipBait(baitCoor) {
        console.log('action: equip bait');
        robot.keyTap('escape');
        robot.keyTap('i');
        await sleep(500)
        robot.moveMouse(baitCoor[0], baitCoor[1]);
        robot.mouseClick('right');
        await sleep(100)
        robot.keyTap('escape')
    }

    static consumeBait() {
        console.log('action: consume bait');
        robot.keyTap('1');
    }
}

module.exports = {
    FishingActions
}