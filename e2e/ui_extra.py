"""Kiểm tra bổ sung: slot, cấu hình N/X, dải ghim, AC-08 qua UI, lỗi + retry, player không bị reset.

Cần: pip install playwright, trình duyệt Microsoft Edge (hoặc đổi channel).
Chạy trên server MỚI (dữ liệu trống), adapter mock chạy nhanh:
  MUSE_DATA_DIR=<thư mục tạm> MUSE_KEY_DIR=<thư mục tạm khác> MUSE_MOCK_JOB_SECONDS=9 MUSE_MOCK_FAIL_RATE=0 npm start
  python e2e/ui_extra.py
Ảnh chụp màn hình lưu ở e2e/out/. Biến MUSE_URL đổi địa chỉ server.
"""
import os
import struct
import zlib


def _png(path, rgb, w=200, h=250):
    """PNG đơn sắc, tự mã hóa để không cần thư viện ảnh."""
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def make_images(folder):
    folder.mkdir(parents=True, exist_ok=True)
    for name, rgb in [('Santa Claus', (192, 57, 43)), ('X07', (37, 99, 235)), ('Sevolra', (22, 163, 74)), ('Studio A', (217, 119, 6)), ('Studio B', (124, 58, 237))]:
        _png(folder / f'{name}.png', rgb)

import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

SP = Path(__file__).parent / 'out'
IMG = SP / 'img'
SHOT = SP / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
make_images(IMG)
URL = os.environ.get('MUSE_URL', 'http://localhost:8787')
problems = []


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        problems.append(msg)


with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge')
    page = b.new_context(viewport={'width': 1440, 'height': 900}, locale='vi-VN').new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(URL)

    page.get_by_role('button', name='Tài khoản ·').click()
    for i in range(2):
        page.get_by_label('Định danh (email hoặc tên đăng nhập)').fill(f'user{i}.test@example.com')
        page.get_by_label('Mật khẩu hoặc API key').fill(f'pw-{i}-xxxxxxxx')
        page.get_by_role('button', name='Thêm tài khoản').click()
        expect(page.locator('dialog[open] li:has-text("Online")')).to_have_count(i + 1, timeout=5000)

    # cấu hình chạy + slots
    slots = page.locator('dialog[open] input[aria-label^="Số slot"]').first
    slots.fill('2')
    slots.blur()
    expect(page.get_by_text('Đã cập nhật số slot.')).to_be_visible(timeout=3000)
    check(True, 'chỉnh được số slot từng tài khoản')
    page.get_by_label('Retry tối đa (N)').fill('1')
    page.get_by_role('button', name='Lưu cấu hình').click()
    expect(page.get_by_text('Đã lưu cấu hình chạy.')).to_be_visible(timeout=3000)
    check(True, 'cấu hình N / X lưu được')
    page.screenshot(path=str(SHOT / '20-account-settings.png'))
    page.keyboard.press('Escape')

    page.locator('section[aria-label="Kho ảnh tham chiếu"] input[type=file]').set_input_files([str(IMG / 'Santa Claus.png')])
    page.wait_for_selector('dialog[open] input[aria-label^="Tag cho"]')
    page.locator('dialog[open] input[aria-label^="Tag cho"]').fill('santa')
    page.get_by_role('button', name='Lưu 1 ảnh vào kho').click()
    page.wait_for_selector('text=Kho ảnh tham chiếu · 1 ảnh')

    ta = page.get_by_label('Danh sách prompt', exact=True)
    ta.fill('\n'.join(f'Cảnh {i + 1} @santa' for i in range(4)) + '\n[lỗi] job luôn lỗi')
    page.get_by_label('Luồng / tài khoản').fill('4')
    page.get_by_role('button', name='Áp dụng').click()
    page.get_by_role('button', name='Thêm vào hàng đợi →').click()
    page.get_by_role('button', name='▶ Chạy hàng đợi').click()
    expect(page.locator('section[aria-label="Đang chạy trực tiếp"] > ul > li')).to_have_count(3, timeout=8000)

    # ghim: cuộn xuống mà dải vẫn nằm trong khung nhìn ngay dưới header
    page.mouse.wheel(0, 700)
    time.sleep(0.6)
    strip = page.locator('section[aria-label="Đang chạy trực tiếp"]')
    bb = strip.bounding_box()
    head = page.evaluate("() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h'))")
    check(bb is not None and 0 <= bb['y'] <= head + 40 and bb['y'] + bb['height'] <= 900, f'dải trực tiếp được ghim dưới header khi cuộn (y={bb["y"]:.0f}, header={head})')
    page.screenshot(path=str(SHOT / '21-sticky-strip.png'))

    # AC-08 qua UI: tắt một tài khoản đang chạy → job được gán lại
    page.mouse.wheel(0, -2000)
    page.get_by_role('button', name='Tài khoản ·').click()
    page.locator('dialog[open]').get_by_role('switch').first.click()
    time.sleep(0.5)
    page.keyboard.press('Escape')
    state = page.evaluate("() => fetch('/api/state').then(r => r.json())")
    check(state['accounts']['enabled'] == 1, 'đã tắt 1 tài khoản đang chạy')

    expect(page.get_by_role('tab', name='Hoàn thành')).to_contain_text('4', timeout=120000)
    check(True, 'AC-08: 4 job vẫn hoàn thành sau khi tắt tài khoản giữa chừng')
    expect(page.get_by_role('tab', name='Thất bại')).to_contain_text('1', timeout=60000)
    page.get_by_role('tab', name='Thất bại').click()
    row = page.locator('ul > li:has(span.font-mono)').first
    expect(row).to_be_visible()
    row.locator('button[aria-expanded]').click()
    check(page.get_by_text('Mã lỗi gốc: MOCK_GENERATION_FAILED').count() == 1, 'AC-09: job thất bại hiện mã lỗi gốc + diễn giải tiếng Việt')
    check(page.get_by_text('Đã thử lại 1/1 lần.').count() == 1, 'AC-09: số lần retry theo cấu hình N=1')
    page.screenshot(path=str(SHOT / '22-failed.png'))
    check(row.get_by_role('button', name='Chạy lại').count() == 1, 'job thất bại có nút Chạy lại')

    # player không bị reset bởi polling mỗi 2 giây
    page.get_by_role('tab', name='Hoàn thành').click()
    row = page.locator('ul > li:has(span.font-mono)').first
    row.get_by_role('button', name='Phát video').click()
    page.wait_for_selector('video')
    page.evaluate("() => { const v = document.querySelector('video'); v.__marker = 'giu-nguyen'; v.loop = false; v.muted = true; return v.play(); }")
    time.sleep(5)
    info = page.evaluate("() => { const v = document.querySelector('video'); return {m: v.__marker, t: v.currentTime, paused: v.paused, ended: v.ended} }")
    check(info['m'] == 'giu-nguyen' and (info['t'] > 3 or info['ended']), f'AC polling 2s không làm mất trạng thái player đang phát {info}')

    print('--- console ---')
    for l in logs:
        print(l)
    b.close()

print('PROBLEMS:', problems)
sys.exit(1 if problems else 0)
