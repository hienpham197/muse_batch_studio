"""Kiểm tra đăng nhập bằng cookie trên giao diện (dùng cookie GIẢ).

Cần: pip install playwright, trình duyệt Microsoft Edge. Chạy trên server mới:
  MUSE_DATA_DIR=<thư mục tạm> MUSE_KEY_DIR=<thư mục tạm khác> npm start
  python e2e/ui_cookie.py
"""
import os
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('MUSE_URL', 'http://localhost:8787')
SHOT = Path(__file__).parent / 'out' / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
FAKE = 'datr=FAKE_DATR_VALUE_0123456789; sid=SECRET_SESSION_ID_ABCDEF; hatch=v1%3Axyz-FAKE'
PIECES = ['FAKE_DATR_VALUE_0123456789', 'SECRET_SESSION_ID_ABCDEF', 'v1%3Axyz-FAKE']
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
    dialog = page.locator('dialog[open]')

    dialog.locator('label:has(input[type=radio][value=cookie])').click()
    field = dialog.get_by_label('Cookie của phiên đã đăng nhập')
    check(field.get_attribute('type') == 'password', 'ô cookie được che (type=password)')
    submit = dialog.get_by_role('button', name='Thêm tài khoản')
    check(submit.is_disabled(), 'chưa dán cookie thì nút Thêm bị khóa')

    field.fill('khong-phai-cookie')
    expect(dialog.get_by_text('Chưa nhận diện được cookie nào')).to_be_visible()
    check(submit.is_disabled(), 'cookie sai định dạng thì không gửi được')

    field.fill(FAKE)
    expect(dialog.get_by_text('Nhận diện 3 cookie')).to_be_visible()
    dialog.get_by_label('Tên gợi nhớ (tùy chọn)').fill('Muse chính')
    page.screenshot(path=str(SHOT / '40-cookie-form.png'))
    submit.click()

    row = dialog.locator('li', has_text='Muse chính')
    expect(row).to_have_count(1, timeout=5000)
    check(row.get_by_text('Online').count() == 1, 'tài khoản cookie Online ngay sau khi thêm')
    check(row.get_by_text('Cookie', exact=True).count() == 1, 'hàng tài khoản có nhãn Cookie')
    check(field.input_value() == '', 'ô cookie được xóa sau khi gửi')
    html = page.content()
    check(not any(x in html for x in PIECES), 'DOM không chứa giá trị cookie')
    page.screenshot(path=str(SHOT / '41-cookie-added.png'))

    # dán lại đúng cookie đó (đổi thứ tự) → báo trùng
    field.fill('sid=SECRET_SESSION_ID_ABCDEF; hatch=v1%3Axyz-FAKE; datr=FAKE_DATR_VALUE_0123456789')
    submit.click()
    expect(page.get_by_text('Tài khoản này đã có trong pool.')).to_be_visible(timeout=5000)
    check(True, 'dán trùng cookie bị báo "đã có trong pool"')

    # cookie hết hạn (mô phỏng)
    field.fill('sid=invalid-het-han')
    dialog.get_by_label('Tên gợi nhớ (tùy chọn)').fill('Cookie hỏng')
    submit.click()
    bad = dialog.locator('li', has_text='Cookie hỏng')
    expect(bad).to_have_count(1, timeout=5000)
    check(bad.get_by_text('Offline').count() == 1 and bad.get_by_text('thêm lại bằng cookie mới').count() == 1, 'cookie bị từ chối hiện Offline kèm hướng dẫn thêm cookie mới')
    page.screenshot(path=str(SHOT / '42-cookie-offline.png'))

    check(not any(x in page.content() for x in PIECES), 'DOM vẫn không chứa giá trị cookie')
    print('--- console ---')
    for line in logs:
        print(line)
    b.close()

print('PROBLEMS:', problems)
sys.exit(1 if problems else 0)
