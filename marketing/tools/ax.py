#!/usr/bin/env python3
"""
ax.py — drive a macOS app through the Accessibility API with nothing but
ctypes (no PyObjC). Built to talk to Meta's Muse desktop app from Claude Code,
whose helper process holds the Accessibility grant while `osascript` does not.

  python3 marketing/tools/ax.py dump   [--app Muse] [--max 400]
  python3 marketing/tools/ax.py find   --role AXTextArea [--app Muse]
  python3 marketing/tools/ax.py type   --path <idx,idx,...> --text "..." [--enter]
  python3 marketing/tools/ax.py press  --path <idx,idx,...>
  python3 marketing/tools/ax.py text   [--app Muse]        # all visible text, top to bottom

Element "paths" are child-index chains from the app's front window, as printed
by `dump`. Typing sets AXValue (fast, exact) then optionally posts a Return
key event through the HID tap so the app's own submit handler runs.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import subprocess
import sys
import time

CF = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
AX = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
CG = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

CFTypeRef = ctypes.c_void_p
kCFStringEncodingUTF8 = 0x08000100

CF.CFStringCreateWithCString.restype = CFTypeRef
CF.CFStringCreateWithCString.argtypes = [CFTypeRef, ctypes.c_char_p, ctypes.c_uint32]
CF.CFStringGetCString.restype = ctypes.c_bool
CF.CFStringGetCString.argtypes = [CFTypeRef, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
CF.CFStringGetLength.restype = ctypes.c_long
CF.CFStringGetLength.argtypes = [CFTypeRef]
CF.CFGetTypeID.restype = ctypes.c_ulong
CF.CFGetTypeID.argtypes = [CFTypeRef]
CF.CFStringGetTypeID.restype = ctypes.c_ulong
CF.CFArrayGetTypeID.restype = ctypes.c_ulong
CF.CFBooleanGetTypeID.restype = ctypes.c_ulong
CF.CFNumberGetTypeID.restype = ctypes.c_ulong
CF.CFArrayGetCount.restype = ctypes.c_long
CF.CFArrayGetCount.argtypes = [CFTypeRef]
CF.CFArrayGetValueAtIndex.restype = CFTypeRef
CF.CFArrayGetValueAtIndex.argtypes = [CFTypeRef, ctypes.c_long]
CF.CFBooleanGetValue.restype = ctypes.c_bool
CF.CFBooleanGetValue.argtypes = [CFTypeRef]
CF.CFNumberGetValue.restype = ctypes.c_bool
CF.CFNumberGetValue.argtypes = [CFTypeRef, ctypes.c_int, ctypes.c_void_p]
CF.CFRelease.argtypes = [CFTypeRef]
kCFBooleanTrue = CFTypeRef.in_dll(CF, 'kCFBooleanTrue')

AX.AXUIElementCreateApplication.restype = CFTypeRef
AX.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
AX.AXUIElementCopyAttributeValue.restype = ctypes.c_int
AX.AXUIElementCopyAttributeValue.argtypes = [CFTypeRef, CFTypeRef, ctypes.POINTER(CFTypeRef)]
AX.AXUIElementSetAttributeValue.restype = ctypes.c_int
AX.AXUIElementSetAttributeValue.argtypes = [CFTypeRef, CFTypeRef, CFTypeRef]
AX.AXUIElementPerformAction.restype = ctypes.c_int
AX.AXUIElementPerformAction.argtypes = [CFTypeRef, CFTypeRef]
AX.AXUIElementGetTypeID.restype = ctypes.c_ulong
AX.AXValueGetValue.restype = ctypes.c_bool
AX.AXValueGetValue.argtypes = [CFTypeRef, ctypes.c_int, ctypes.c_void_p]
AX.AXIsProcessTrusted.restype = ctypes.c_bool

CG.CGEventCreateKeyboardEvent.restype = CFTypeRef
CG.CGEventCreateKeyboardEvent.argtypes = [CFTypeRef, ctypes.c_uint16, ctypes.c_bool]
CG.CGEventPost.argtypes = [ctypes.c_uint32, CFTypeRef]
CG.CGEventSetFlags.argtypes = [CFTypeRef, ctypes.c_uint64]


class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]


class CGSize(ctypes.Structure):
    _fields_ = [('w', ctypes.c_double), ('h', ctypes.c_double)]


def cfstr(s: str) -> CFTypeRef:
    return CF.CFStringCreateWithCString(None, s.encode('utf-8'), kCFStringEncodingUTF8)


def pystr(ref: CFTypeRef) -> str:
    if not ref:
        return ''
    n = CF.CFStringGetLength(ref)
    buf = ctypes.create_string_buffer(n * 4 + 1)
    return buf.value.decode('utf-8', 'replace') if CF.CFStringGetCString(ref, buf, len(buf), kCFStringEncodingUTF8) else ''


def attr(el: CFTypeRef, name: str):
    out = CFTypeRef()
    err = AX.AXUIElementCopyAttributeValue(el, cfstr(name), ctypes.byref(out))
    if err != 0 or not out:
        return None
    tid = CF.CFGetTypeID(out)
    if tid == CF.CFStringGetTypeID():
        return pystr(out)
    if tid == CF.CFBooleanGetTypeID():
        return bool(CF.CFBooleanGetValue(out))
    if tid == CF.CFNumberGetTypeID():
        v = ctypes.c_double()
        CF.CFNumberGetValue(out, 13, ctypes.byref(v))  # kCFNumberDoubleType
        return v.value
    if tid == CF.CFArrayGetTypeID():
        return [CF.CFArrayGetValueAtIndex(out, i) for i in range(CF.CFArrayGetCount(out))]
    if name in ('AXPosition',):
        p = CGPoint()
        if AX.AXValueGetValue(out, 1, ctypes.byref(p)):
            return (int(p.x), int(p.y)) if abs(p.x) < 1e9 and abs(p.y) < 1e9 else None
    if name in ('AXSize',):
        s = CGSize()
        if AX.AXValueGetValue(out, 2, ctypes.byref(s)):
            return (int(s.w), int(s.h)) if abs(s.w) < 1e9 and abs(s.h) < 1e9 else None
    return out  # opaque (e.g. another AXUIElement)


def app_element(name: str) -> CFTypeRef:
    pid = subprocess.run(['pgrep', '-x', name], capture_output=True, text=True).stdout.split()
    if not pid:
        sys.exit(f'{name} is not running')
    return AX.AXUIElementCreateApplication(int(pid[0]))


def front_window(app: CFTypeRef) -> CFTypeRef:
    w = attr(app, 'AXFocusedWindow') or (attr(app, 'AXWindows') or [None])[0]
    if not w:
        sys.exit('no window')
    return w


def walk(el: CFTypeRef, path: list[int], depth: int, out: list[dict], limit: int) -> None:
    if len(out) >= limit or depth > 40:
        return
    role = attr(el, 'AXRole') or ''
    rec = {
        'path': ','.join(map(str, path)),
        'role': role,
        'sub': attr(el, 'AXSubrole') or '',
        'title': attr(el, 'AXTitle') or '',
        'desc': attr(el, 'AXDescription') or '',
        'value': attr(el, 'AXValue'),
        'pos': attr(el, 'AXPosition'),
        'size': attr(el, 'AXSize'),
        'enabled': attr(el, 'AXEnabled'),
        'focused': attr(el, 'AXFocused'),
    }
    if not isinstance(rec['value'], (str, bool, float, type(None))):
        rec['value'] = '<obj>'
    out.append(rec)
    for i, c in enumerate(attr(el, 'AXChildren') or []):
        walk(c, path + [i], depth + 1, out, limit)


def by_path(win: CFTypeRef, path: str) -> CFTypeRef:
    el = win
    for i in [int(x) for x in path.split(',') if x != '']:
        el = (attr(el, 'AXChildren') or [])[i]
    return el


def press_key(keycode: int, flags: int = 0) -> None:
    down = CG.CGEventCreateKeyboardEvent(None, keycode, True)
    up = CG.CGEventCreateKeyboardEvent(None, keycode, False)
    if flags:
        CG.CGEventSetFlags(down, flags)
        CG.CGEventSetFlags(up, flags)
    CG.CGEventPost(0, down)
    time.sleep(0.03)
    CG.CGEventPost(0, up)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['dump', 'find', 'type', 'press', 'text', 'focus', 'click', 'key', 'enhance'])
    ap.add_argument('--code', type=int)
    ap.add_argument('--cmd', dest='cmd_flag', action='store_true')
    ap.add_argument('--shift', action='store_true')
    ap.add_argument('--app', default='Muse')
    ap.add_argument('--role')
    ap.add_argument('--path')
    ap.add_argument('--text')
    ap.add_argument('--enter', action='store_true')
    ap.add_argument('--max', type=int, default=400)
    ap.add_argument('--full', action='store_true')
    a = ap.parse_args()

    if not AX.AXIsProcessTrusted():
        sys.exit('this process is not trusted for Accessibility')
    if a.cmd == 'key':
        flags = (0x100000 if a.cmd_flag else 0) | (0x20000 if a.shift else 0)
        press_key(a.code, flags)
        print('key', a.code, 'flags', hex(flags))
        return 0
    app = app_element(a.app)
    if a.cmd == 'enhance':
        # WebKit/Chromium expose their full DOM to assistive clients only when asked.
        for k in ('AXEnhancedUserInterface', 'AXManualAccessibility'):
            print(k, 'err', AX.AXUIElementSetAttributeValue(app, cfstr(k), kCFBooleanTrue))
        return 0
    win = front_window(app)

    if a.cmd in ('dump', 'find', 'text'):
        out: list[dict] = []
        walk(win, [], 0, out, a.max)
        if a.cmd == 'dump':
            for r in out:
                if r['role'] in ('AXGroup', 'AXUnknown') and not (r['title'] or r['desc'] or r['value']):
                    continue
                v = r['value']
                if isinstance(v, str) and len(v) > 160:
                    v = v[:160] + '…'
                print(f"[{r['path']}] {r['role']}{('/' + r['sub']) if r['sub'] else ''} t={r['title']!r} d={r['desc']!r} v={v!r} pos={r['pos']} size={r['size']}")
        elif a.cmd == 'find':
            for r in out:
                if r['role'] == a.role:
                    print(json.dumps(r, default=str))
        else:
            seen = set()
            for r in out:
                v = r['value'] if isinstance(r['value'], str) else ''
                t = (r['title'] or r['desc'] or v).strip()
                if t and r['role'] in ('AXStaticText', 'AXTextArea', 'AXTextField', 'AXButton', 'AXLink', 'AXHeading') and t not in seen:
                    seen.add(t)
                    print(f"{r['role']:12} {t if a.full else t[:300]}")
        return 0

    el = by_path(win, a.path)
    if a.cmd == 'click':
        pos, size = attr(el, 'AXPosition'), attr(el, 'AXSize')
        x, y = pos[0] + size[0] / 2, pos[1] + size[1] / 2
        CG.CGEventCreateMouseEvent.restype = CFTypeRef
        CG.CGEventCreateMouseEvent.argtypes = [CFTypeRef, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
        for et in (5, 1, 2):  # move, left down, left up
            ev = CG.CGEventCreateMouseEvent(None, et, CGPoint(x, y), 0)
            CG.CGEventPost(0, ev)
            time.sleep(0.05)
        print('clicked', (int(x), int(y)))
        return 0
    if a.cmd == 'focus':
        print('focus err', AX.AXUIElementSetAttributeValue(el, cfstr('AXFocused'), kCFBooleanTrue))
        return 0
    if a.cmd == 'type':
        AX.AXUIElementSetAttributeValue(el, cfstr('AXFocused'), kCFBooleanTrue)
        time.sleep(0.2)
        err = AX.AXUIElementSetAttributeValue(el, cfstr('AXValue'), cfstr(a.text))
        print('setvalue err', err, '| now:', (attr(el, 'AXValue') or '')[:80])
        if a.enter:
            time.sleep(0.3)
            press_key(36)
            print('sent Return')
        return 0
    if a.cmd == 'press':
        print('press err', AX.AXUIElementPerformAction(el, cfstr('AXPress')))
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
