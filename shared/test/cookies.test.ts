import { describe, expect, it } from 'vitest';
import { parseCookies, serializeCookies } from '../src/index.js';

describe('parseCookies', () => {
  it('đọc chuỗi header Cookie, giữ dấu = và % trong giá trị', () => {
    const r = parseCookies('dpr=1; datr=ab_c-D%3Ae=f ; flag=');
    expect(r).toEqual({ ok: true, cookies: [{ name: 'dpr', value: '1' }, { name: 'datr', value: 'ab_c-D%3Ae=f' }, { name: 'flag', value: '' }] });
  });

  it('bỏ tiền tố "Cookie:", dấu ngoặc kép và dấu chấm phẩy thừa', () => {
    const r = parseCookies('Cookie: a="x";; b=y;');
    expect(r).toEqual({ ok: true, cookies: [{ name: 'a', value: 'x' }, { name: 'b', value: 'y' }] });
  });

  it('nhận JSON xuất từ tiện ích trình duyệt (mảng và object)', () => {
    expect(parseCookies('[{"name":"a","value":"1","domain":"x"},{"name":"b","value":"2"}]')).toEqual({ ok: true, cookies: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] });
    expect(parseCookies('{"a":"1"}')).toEqual({ ok: true, cookies: [{ name: 'a', value: '1' }] });
  });

  it('trùng tên thì giữ giá trị sau cùng', () => {
    expect(parseCookies('a=1; a=2')).toEqual({ ok: true, cookies: [{ name: 'a', value: '2' }] });
  });

  it('từ chối nội dung sai và không đưa giá trị vào lý do', () => {
    expect(parseCookies('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseCookies('khong-co-dau-bang')).toEqual({ ok: false, reason: 'format' });
    expect(parseCookies('a=1\r\nSet-Cookie: b=2')).toEqual({ ok: false, reason: 'format' });
    expect(parseCookies('a b=1')).toEqual({ ok: false, reason: 'format' });
    expect(parseCookies('[1,2]')).toEqual({ ok: false, reason: 'format' });
    expect(parseCookies('x='.repeat(20000))).toEqual({ ok: false, reason: 'too-large' });
    expect(parseCookies(Array.from({ length: 101 }, (_, i) => `c${i}=1`).join(';'))).toEqual({ ok: false, reason: 'too-many' });
  });

  it('serialize ra chuỗi header', () => {
    expect(serializeCookies([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])).toBe('a=1; b=2');
  });
});
