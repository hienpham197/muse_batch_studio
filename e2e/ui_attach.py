"""Kiểm tra bấm vào tag đỏ (thiếu ảnh) để chọn ảnh CÓ SẴN trong kho và gắn vào prompt.

Cần: pip install playwright, trình duyệt Microsoft Edge. Chạy trên server mới:
  MUSE_DATA_DIR=<thư mục tạm> MUSE_KEY_DIR=<thư mục tạm khác> npm start
  python e2e/ui_attach.py
"""
import os
import struct
import sys
import zlib
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('MUSE_URL', 'http://localhost:8787')
OUT = Path(__file__).parent / 'out'
SHOT = OUT / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
problems = []


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        problems.append(msg)


def png(path, rgb, w=120, h=160):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


OUT.mkdir(exist_ok=True)
LIB = [('gecko-than-lan-xanh', (60, 140, 90)), ('snake-ran-kem-bandana', (200, 90, 60)), ('vulture-ong-ken-ken', (90, 90, 200))]
for tag, rgb in LIB:
    png(OUT / f'{tag}.png', rgb)

with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge')
    page = b.new_context(viewport={'width': 1440, 'height': 900}, locale='vi-VN').new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(URL)

    ta = page.get_by_label('Danh sách prompt', exact=True)
    ta.fill('@gecko-than-lan-x chạy trên cát')
    chip = page.get_by_role('button', name='Chọn ảnh trong kho cho @gecko-than-lan-x')
    expect(chip).to_be_visible(timeout=3000)
    chip.click()
    dialog = page.locator('dialog[open]')
    check(dialog.get_by_text('Kho chưa có ảnh nào').count() == 1, 'kho trống thì báo cần thêm ảnh, không có ô upload')
    check(dialog.locator('input[type=file]').count() == 0, 'hộp chọn không có upload')
    page.keyboard.press('Escape')

    # nạp kho bằng luồng thêm ảnh bình thường
    page.locator('section[aria-label="Kho ảnh tham chiếu"] input[type=file]').set_input_files([str(OUT / f'{t}.png') for t, _ in LIB])
    page.wait_for_selector('dialog[open] input[aria-label^="Tag cho"]')
    page.get_by_role('button', name='Lưu 3 ảnh vào kho').click()
    expect(page.get_by_text('Kho ảnh tham chiếu · 3 ảnh')).to_be_visible(timeout=5000)

    ta.fill('@gecko-than-lan-x chạy trên cát\n@snake-ran-kem-b trườn qua đá\n@gecko-than-lan-x nhảy lần nữa\n@sản không có')
    chip = page.get_by_role('button', name='Chọn ảnh trong kho cho @gecko-than-lan-x')
    expect(chip).to_be_visible(timeout=3000)
    expect(page.get_by_role('button', name='Chọn ảnh trong kho cho @sản')).to_have_count(1, timeout=3000)
    check(True, 'tag có dấu cũng chọn lại được từ kho')
    add = page.get_by_role('button', name='Thêm vào hàng đợi →')
    check(add.is_disabled(), 'còn tag thiếu thì chưa thêm được vào hàng đợi')

    chip.click()
    dialog = page.locator('dialog[open]')
    items = dialog.locator('ul > li button')
    check(items.count() == 3, 'hộp chọn liệt kê đủ 3 ảnh trong kho')
    check('gecko-than-lan-xanh' in items.first.inner_text() and 'Gợi ý' in items.first.inner_text(), 'ảnh giống tag nhất được xếp đầu và đánh dấu gợi ý')
    check('@gecko-than-lan-xanh' in dialog.inner_text(), 'tag đầy đủ của ảnh được hiện trọn (không bị cắt)')
    page.screenshot(path=str(SHOT / '60-picker.png'))
    dialog.get_by_label('Lọc theo tag').fill('vulture')
    check(dialog.locator('ul > li button').count() == 1, 'lọc theo tag hoạt động')
    dialog.get_by_label('Lọc theo tag').fill('')
    items.first.click()

    expect(page.get_by_text('Đã gắn @gecko-than-lan-xanh thay cho @gecko-than-lan-x trong prompt.')).to_be_visible(timeout=3000)
    value = ta.input_value()
    check(value.count('@gecko-than-lan-xanh') == 2 and '@gecko-than-lan-x ' not in value, 'cả 2 chỗ @gecko-than-lan-x trong prompt được đổi sang tag trong kho')
    expect(page.get_by_text('@gecko-than-lan-xanh · đã tự gắn ảnh')).to_be_visible()
    check(page.get_by_text('Kho ảnh tham chiếu · 3 ảnh').count() == 1, 'kho không bị thêm ảnh mới')

    page.get_by_role('button', name='Chọn ảnh trong kho cho @snake-ran-kem-b').click()
    page.locator('dialog[open] ul > li button', has_text='snake-ran-kem-bandana').click()
    page.get_by_role('button', name='Chọn ảnh trong kho cho @sản').click()
    page.locator('dialog[open] ul > li button', has_text='vulture-ong-ken-ken').click()
    expect(add).to_be_enabled(timeout=3000)
    check(True, 'đã gắn hết thì nút Thêm vào hàng đợi mở khóa')

    add.click()
    expect(page.get_by_text('Đã thêm 4 job vào hàng đợi.')).to_be_visible(timeout=5000)
    state = page.evaluate("() => fetch('/api/jobs?source=batch&pageSize=50').then(r => r.json())")
    tags = sorted({t for j in state['items'] for t in j['refTags']})
    check(tags == ['gecko-than-lan-xanh', 'snake-ran-kem-bandana', 'vulture-ong-ken-ken'], f'job được tạo với đúng ảnh từ kho {tags}')
    page.screenshot(path=str(SHOT / '61-attach-done.png'))

    print('--- console ---')
    for line in logs:
        print(line)
    b.close()

print('PROBLEMS:', problems)
sys.exit(1 if problems else 0)
