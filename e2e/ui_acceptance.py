"""Kiểm tra giao diện theo AC-01 đến AC-12 trên trình duyệt thật.

Cần: pip install playwright, trình duyệt Microsoft Edge (hoặc đổi channel).
Chạy trên server MỚI (dữ liệu trống), adapter mock chạy nhanh:
  MUSE_DATA_DIR=<thư mục tạm> MUSE_KEY_DIR=<thư mục tạm khác> MUSE_MOCK_JOB_SECONDS=9 MUSE_MOCK_FAIL_RATE=0 npm start
  python e2e/ui_acceptance.py
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

import sys, time, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

SP = Path(__file__).parent / 'out'
IMG = SP / 'img'
SHOT = SP / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
make_images(IMG)
SHOT.mkdir(exist_ok=True)
URL = os.environ.get('MUSE_URL', 'http://localhost:8787')
problems = []

def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        problems.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='vi-VN', accept_downloads=True)
    page = ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))

    page.goto(URL)
    page.wait_for_selector('text=Danh sách prompt')
    page.screenshot(path=str(SHOT / '01-empty.png'))

    # --- Account Pool: thêm 3 tài khoản ---
    page.get_by_role('button', name='Tài khoản ·').click()
    for i in range(3):
        page.get_by_label('Định danh (email hoặc tên đăng nhập)').fill(f'nguoi.dung{i}@example.com')
        page.get_by_label('Mật khẩu hoặc API key').fill(f'MatKhau-Bi-Mat-{i}')
        page.get_by_role('button', name='Thêm tài khoản').click()
        page.wait_for_selector(f'text=ng***@e***.com >> nth={i}')
        time.sleep(0.3)
    check(page.locator('dialog[open] li:has-text("Online")').count() == 3, '3 tài khoản Online trong Account Pool')
    check('MatKhau-Bi-Mat' not in page.content(), 'AC-12: không có plaintext secret trong DOM')
    check(page.get_by_label('Mật khẩu hoặc API key').input_value() == '', 'ô secret được xóa sau khi thêm')
    page.screenshot(path=str(SHOT / '02-accounts.png'))
    page.keyboard.press('Escape')

    # --- Upload nhiều ảnh (AC-04) ---
    page.locator('section[aria-label="Kho ảnh tham chiếu"] input[type=file]').set_input_files([str(IMG / 'Santa Claus.png'), str(IMG / 'X07.png'), str(IMG / 'Sevolra.png')])
    page.wait_for_selector('text=Ảnh chờ lưu · 3')
    tags = page.locator('dialog[open] input[aria-label^="Tag cho"]')
    check(tags.count() == 3, 'AC-04: 3 dòng chờ lưu')
    check([tags.nth(i).input_value() for i in range(3)] == ['santa-claus', 'x07', 'sevolra'], 'AC-04: tag tự sinh đúng từ tên file')
    tags.nth(0).fill('santa')
    page.screenshot(path=str(SHOT / '03-upload.png'))
    page.get_by_role('button', name='Lưu 3 ảnh vào kho').click()
    page.wait_for_selector('text=Kho ảnh tham chiếu · 3 ảnh')
    check(True, 'AC-04: kho có đủ 3 ảnh')

    # --- Gõ @ gợi ý (AC-02/03) ---
    ta = page.get_by_label('Danh sách prompt', exact=True)
    ta.click()
    ta.type('Cô gái @s')
    page.wait_for_selector('[role=listbox] [role=option]')
    page.wait_for_timeout(400)
    check(page.locator('[role=option]').count() == 2, 'gõ @s gợi ý santa + sevolra')
    page.screenshot(path=str(SHOT / '04-mention.png'))
    page.keyboard.press('ArrowDown')
    page.keyboard.press('Enter')
    check(ta.input_value().startswith('Cô gái @sevolra '), 'chọn gợi ý bằng ↑↓ + Enter chèn @sevolra đầy đủ: ' + repr(ta.input_value()))
    ta.type('và @khongco')
    expect(page.get_by_role('alert').filter(has_text='Thiếu ảnh cho @khongco')).to_have_count(1, timeout=3000)
    check(True, 'AC-03: tag lạ báo đỏ ngay khi gõ, nêu rõ tag thiếu')
    check(page.get_by_role('button', name='Thêm vào hàng đợi →').is_disabled(), 'chặn thêm khi còn tag thiếu')
    page.screenshot(path=str(SHOT / '05-missing-tag.png'))

    # --- AC-01: badge đếm ---
    ta.fill('\n'.join(f'Prompt {i + 1} @santa' for i in range(10)))
    page.wait_for_selector('text=10 prompt')
    check(True, 'AC-01: dán 10 dòng → "10 prompt"')
    ta.fill('\n'.join(f'Prompt {i + 1} @santa' for i in range(8)))
    page.wait_for_selector('text=8 prompt')
    check(True, 'AC-01: còn 8 dòng → "8 prompt"')
    page.get_by_label('Cách tách prompt').select_option('all')
    page.wait_for_selector('text=1 prompt')
    check(True, 'đổi chế độ tách → đếm lại ngay "1 prompt"')
    page.get_by_label('Cách tách prompt').select_option('line')
    ta.fill('')
    page.wait_for_selector('text=0 prompt')

    # --- AC-05: Dán là chạy luôn ---
    def paste(text):
        ta.click()
        page.evaluate("""(t) => {
            const el = document.querySelector('textarea');
            const dt = new DataTransfer(); dt.setData('text/plain', t);
            el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            set.call(el, t); el.dispatchEvent(new Event('input', {bubbles: true}));
        }""", text)
    paste('@santa chạy trên tuyết\n@x07 đi dạo phố đêm\nCảnh biển lúc hoàng hôn')
    page.wait_for_selector('text=3 prompt')
    time.sleep(0.8)
    check(page.locator('li:has-text("task_")').count() == 0, 'chưa tự thêm trước 2 giây')
    page.wait_for_selector('text=Đã thêm 3 job vào hàng đợi.', timeout=5000)
    check(page.get_by_role('button', name='Hoàn tác').count() == 1, 'AC-05: toast có nút Hoàn tác')
    page.wait_for_selector('li:has-text("task_")')
    check(page.locator('ul > li:has(span.font-mono)').count() >= 3, 'AC-05: 3 job xuất hiện')
    page.screenshot(path=str(SHOT / '06-pasted.png'))
    page.get_by_role('button', name='Hoàn tác').click()
    page.wait_for_selector('text=Đã rút lại 3 job.')
    check(ta.input_value().startswith('@santa chạy'), 'Hoàn tác khôi phục nội dung ô nhập')
    # tắt toggle, dán lại -> không tự thêm
    page.get_by_role('switch', name='Dán là chạy luôn').click()
    paste('Một\nHai')
    time.sleep(3)
    check(page.locator('text=Đã thêm 2 job').count() == 0, 'AC-05: tắt toggle → dán không tự thêm')
    page.get_by_role('switch', name='Dán là chạy luôn').click()

    # --- Thêm + Chạy (AC-06) ---
    ta.fill('\n'.join(f'Video {i + 1} @santa cảnh {i + 1}' for i in range(6)))
    page.wait_for_selector('text=6 prompt')
    page.get_by_label('Luồng / tài khoản').fill('6')
    page.get_by_role('button', name='Áp dụng').click()
    page.wait_for_selector('text=Đã đặt 6 luồng.')
    check(page.locator('text=bị giới hạn bởi 3 tài khoản Online').count() == 1, 'hiển thị cả số luồng cấu hình và hiệu dụng khi khác nhau')
    page.get_by_role('button', name='Thêm vào hàng đợi →').click()
    page.wait_for_selector('text=Đã thêm 6 job vào hàng đợi.')
    page.get_by_role('button', name='▶ Chạy hàng đợi').click()
    page.wait_for_selector('section[aria-label="Đang chạy trực tiếp"]')
    peak = 0
    for _ in range(16):
        n = page.locator('section[aria-label="Đang chạy trực tiếp"] > ul > li').count()
        peak = max(peak, n)
        time.sleep(0.5)
    check(peak == 3, f'AC-06: dải trực tiếp hiện đủ 3 job chạy cùng lúc (peak={peak})')
    page.screenshot(path=str(SHOT / '07-running.png'))
    t0 = page.locator('section[aria-label="Đang chạy trực tiếp"] li').first.inner_text()
    time.sleep(2.2)
    t1 = page.locator('section[aria-label="Đang chạy trực tiếp"] li').first.inner_text()
    check(t0 != t1, 'dải trực tiếp cập nhật theo thời gian (đồng hồ / %)')
    expect(page.get_by_role('tab', name='Hoàn thành')).to_contain_text('6', timeout=90000)
    check(True, 'AC-06: cả 6 job hoàn thành (cuốn chiếu)')
    expect(page.locator('section[aria-label="Đang chạy trực tiếp"]')).to_have_count(0, timeout=6000)
    check(True, 'dải biến mất khi hết job chạy')

    # --- AC-07: xem trước rồi tải ---
    page.get_by_role('tab', name='Hoàn thành').click()
    row = page.locator('ul > li:has(span.font-mono)').first
    row.get_by_role('button', name='Phát video').click()
    page.wait_for_selector('video')
    time.sleep(1.2)
    ready = page.evaluate("() => { const v = document.querySelector('video'); return {rs: v.readyState, t: v.currentTime, w: v.videoWidth, h: v.videoHeight, err: v.error && v.error.code} }")
    check(ready['rs'] >= 2 and ready['w'] > 0 and not ready['err'], f'AC-07: video phát được trong dòng {ready}')
    page.screenshot(path=str(SHOT / '08-player.png'))
    with page.expect_download() as dl:
        row.get_by_role('link', name='Tải MP4').click()
    d = dl.value
    path = SHOT / d.suggested_filename
    d.save_as(path)
    check(d.suggested_filename.startswith('task_') and path.stat().st_size > 10000, f'AC-07: Tải MP4 ra file {d.suggested_filename} ({path.stat().st_size} B)')
    row.get_by_role('button', name='Thu nhỏ').click()
    check(page.locator('video').count() == 0, 'AC-07: thu nhỏ đóng player')

    # --- AC-10: mở rộng dòng, tìm kiếm ---
    page.get_by_role('tab', name='Tất cả').click()
    first = page.locator('ul > li:has(span.font-mono)').first
    first.locator('button[aria-expanded]').click()
    check(page.locator('text=Prompt đầy đủ').count() == 1, 'AC-10: bấm dòng mở full prompt')
    page.screenshot(path=str(SHOT / '09-expanded.png'))
    first.locator('button[aria-expanded]').click()
    check(page.locator('text=Prompt đầy đủ').count() == 0, 'AC-10: bấm lại thu gọn')
    tid = first.locator('span.font-mono').first.inner_text()
    page.get_by_label('Tìm theo prompt hoặc Task ID').fill(tid)
    time.sleep(1.2)
    check(page.locator('ul > li:has(span.font-mono)').count() == 1, 'AC-10: tìm theo Task ID ra đúng 1 job')
    page.get_by_label('Tìm theo prompt hoặc Task ID').fill('')

    # --- Studio (AC-11) ---
    page.get_by_role('button', name='Studio kéo thả').click()
    page.wait_for_selector('text=Muse Flow Studio')
    page.get_by_role('button', name='+ Thêm ảnh', exact=True).click()
    page.locator('section[aria-label^="Muse Flow Studio"] input[type=file]').set_input_files([str(IMG / 'Studio A.png'), str(IMG / 'Studio B.png')])
    page.wait_for_selector('article >> nth=1')
    check(page.locator('article').count() == 2, 'AC-11: 2 ảnh → 2 thẻ')
    cards = page.locator('article')
    b0 = cards.nth(0).bounding_box(); b1 = cards.nth(1).bounding_box()
    check(abs(b0['x'] - b1['x']) >= 300 or abs(b0['y'] - b1['y']) >= 400, 'thẻ không chồng nhau')
    page.screenshot(path=str(SHOT / '10-studio.png'))
    handle = cards.nth(0).get_by_role('button', name='Thẻ 1.', exact=False)
    hb = handle.bounding_box()
    page.mouse.move(hb['x'] + 60, hb['y'] + 10)
    page.mouse.down(); page.mouse.move(hb['x'] + 160, hb['y'] + 90, steps=6); page.mouse.up()
    time.sleep(0.8)
    nb = cards.nth(0).bounding_box()
    check(abs((nb['x'] - b0['x']) - 100) < 4 and abs((nb['y'] - b0['y']) - 80) < 4, f'AC-11: kéo-thả đổi vị trí ({nb["x"]-b0["x"]:.0f},{nb["y"]-b0["y"]:.0f})')
    ta0 = cards.nth(0).get_by_label('Prompt của thẻ')
    ta0.click(); ta0.type('Xin chào @s')
    page.wait_for_selector('[role=listbox] [role=option]')
    check(True, 'AC-11: gõ @ trong thẻ có dropdown từ kho')
    page.keyboard.press('Escape')
    ta0.fill('Nhân vật vẫy tay chào')
    cards.nth(1).get_by_label('Prompt của thẻ').fill('Cảnh núi tuyết, máy quay lia chậm')
    time.sleep(1.0)
    page.get_by_role('button', name='▶ Tạo tất cả').click()
    page.wait_for_selector('text=Đã đưa 2 thẻ vào hàng đợi.')
    expect(page.locator('article video')).to_have_count(2, timeout=90000)
    check(page.locator('article >> text=Video đã tạo').count() == 2, 'AC-11: kết quả hiện trong player trên từng thẻ')
    check(page.locator('article >> text=HD').count() == 2, 'badge chất lượng HD trên thẻ')
    page.screenshot(path=str(SHOT / '11-studio-done.png'))
    # zoom
    page.get_by_role('button', name='Thu nhỏ').first.click()
    page.get_by_role('button', name='Vừa khung').click()
    time.sleep(0.5)
    page.screenshot(path=str(SHOT / '12-studio-fit.png'))
    # chuyển tab không mất trạng thái
    page.get_by_role('button', name='Hàng đợi').click()
    check(page.get_by_role('tab', name='Tất cả').is_visible(), 'quay lại tab Hàng đợi vẫn còn danh sách')

    # --- hẹp: một cột ---
    page.set_viewport_size({'width': 390, 'height': 844})
    time.sleep(0.5)
    overflow = page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth')
    check(not overflow, 'màn hẹp: không tràn ngang')
    page.screenshot(path=str(SHOT / '13-mobile.png'), full_page=False)

    print('--- console ---')
    for l in logs:
        print(l)
    b.close()

print('PROBLEMS:', problems)
sys.exit(1 if problems else 0)
