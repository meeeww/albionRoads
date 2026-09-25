const robot = require('robotjs');

console.time('screen.capture');
const img = robot.screen.capture(0, 0, 100, 1);
const hex1 = img.colorAt(0, 0);
console.timeEnd('screen.capture');

console.time('getPixelColor');
for (let i = 0; i < 100; i++) {
    robot.getPixelColor(i, 0);
}
console.timeEnd('getPixelColor');

console.log('Hex from capture:', hex1);
