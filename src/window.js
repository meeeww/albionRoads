const koffi = require('koffi')

const user32 = koffi.load('user32.dll')

const RECT = koffi.struct('RECT', {
    left: 'int32_t',
    top: 'int32_t',
    right: 'int32_t',
    bottom: 'int32_t',
})

const FindWindowW = user32.func(
    'void * __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
)
const GetWindowRect = user32.func(
    'bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)'
)
const SetForegroundWindow = user32.func(
    'bool __stdcall SetForegroundWindow(void *hWnd)'
)
const GetKeyboardState = user32.func(
    'bool __stdcall GetKeyboardState(uint8_t *lpKeyState)'
)
const keybd_event = user32.func(
    'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
)

const VK_MENU = 0x12
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002

function altIsDown(keyState) {
    return Boolean(keyState && (keyState[VK_MENU] & 0x80))
}

function readKeyState() {
    const keyState = Buffer.alloc(256)
    if (!GetKeyboardState(keyState)) return null
    return keyState
}

class Window {
    constructor(hwnd) {
        this.hwnd = hwnd
    }

    static getByTitle(title) {
        if (typeof title !== 'string') {
            throw new Error('Title must be specified.')
        }

        const hwnd = FindWindowW(null, title)
        if (!hwnd) return undefined
        return new Window(hwnd)
    }

    getDimensions() {
        const rect = {}
        if (!GetWindowRect(this.hwnd, rect)) {
            throw new Error('GetWindowRect failed')
        }
        return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    setForeground() {
        if (SetForegroundWindow(this.hwnd)) return true

        // Windows blocks SetForegroundWindow unless this process looks like it
        // just received input. A brief Alt tap is the same unlock win-control used.
        if (!altIsDown(readKeyState())) {
            keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, 0)
        }

        SetForegroundWindow(this.hwnd)

        if (!altIsDown(readKeyState())) {
            keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)
        }

        return true
    }
}

module.exports = { Window }
