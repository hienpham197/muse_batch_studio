import { describe, expect, it } from 'vitest';
import { analyzePrompts, checkTag, collectMissingTags, countPrompts, extractMentions, findMentionRanges, replaceMention, splitPrompts, suggestTag, uniqueTag } from '../src/index.js';

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `Prompt số ${i + 1}`).join('\n');

describe('splitPrompts / countPrompts (AC-01)', () => {
  it('chế độ dòng: dán 10 dòng → 10, xóa 2 dòng → 8', () => {
    expect(countPrompts(TEN_LINES, 'line')).toBe(10);
    expect(countPrompts(TEN_LINES.split('\n').slice(2).join('\n'), 'line')).toBe(8);
  });

  it('bỏ qua dòng trống và khoảng trắng thừa, chịu được CRLF', () => {
    expect(splitPrompts('  a  \r\n\r\n   \r\nb\r\n', 'line')).toEqual(['a', 'b']);
  });

  it('chế độ đoạn: đoạn cách nhau dòng trống, giữ xuống dòng bên trong', () => {
    const text = 'a1\na2\n\n\nb1\n  \nc1';
    expect(splitPrompts(text, 'paragraph')).toEqual(['a1\na2', 'b1', 'c1']);
  });

  it('chế độ toàn bộ: luôn 1 prompt khi có nội dung, 0 khi rỗng', () => {
    expect(splitPrompts('- ý 1\n- ý 2\n\nđoạn 2', 'all')).toEqual(['- ý 1\n- ý 2\n\nđoạn 2']);
    expect(countPrompts('   \n  ', 'all')).toBe(0);
    expect(countPrompts('', 'line')).toBe(0);
  });
});

describe('extractMentions', () => {
  it('giữ thứ tự xuất hiện, không trùng, chữ thường', () => {
    expect(extractMentions('@Santa đứng cạnh @x07 và @santa, rồi @sevolra.')).toEqual(['santa', 'x07', 'sevolra']);
  });

  it('không nhận email, nhận tag có gạch', () => {
    expect(extractMentions('gửi a@b.com và @san-ta_2')).toEqual(['san-ta_2']);
  });

  it('tag có dấu tiếng Việt được giữ nguyên để báo thiếu thay vì cắt ngầm', () => {
    expect(extractMentions('@sản')).toEqual(['sản']);
  });

  it('báo tag thiếu theo từng prompt', () => {
    const a = analyzePrompts(['@santa chạy', '@khongco và @santa', 'không tag'], new Set(['santa']));
    expect(a.map((x) => x.missing)).toEqual([[], ['khongco'], []]);
    expect(collectMissingTags(a)).toEqual(['khongco']);
  });

  it('findMentionRanges trả vị trí và trạng thái', () => {
    const r = findMentionRanges('ab @santa cd @lạ', new Set(['santa']));
    expect(r).toEqual([
      { tag: 'santa', start: 3, end: 9, known: true },
      { tag: 'lạ', start: 13, end: 16, known: false },
    ]);
  });
});

describe('tag (Mục 3.2)', () => {
  it('sinh tag từ tên file', () => {
    expect(suggestTag('Santa Claus.png')).toBe('santa-claus');
    expect(suggestTag('X07.jpg')).toBe('x07');
    expect(suggestTag('Chú Sói đỏ (1).WEBP')).toBe('chu-soi-do-1');
    expect(suggestTag('....png')).toBe('anh');
  });

  it('tránh trùng khi đề xuất', () => {
    expect(uniqueTag('santa', new Set(['santa', 'santa-2']))).toBe('santa-3');
  });

  it('kiểm tra tag hợp lệ', () => {
    expect(checkTag('santa-01_a')).toBeNull();
    expect(checkTag('')).toBe('empty');
    expect(checkTag('Santa')).toBe('chars');
    expect(checkTag('a b')).toBe('chars');
    expect(checkTag('x'.repeat(41))).toBe('too-long');
  });
});

describe('replaceMention', () => {
  it('đổi mọi lần xuất hiện của đúng tag, không đụng tag dài hơn hay email', () => {
    const text = '@gecko-x chạy, @Gecko-X nhảy, @gecko-xanh đứng, mail a@gecko-x.com, @gecko-x.';
    expect(replaceMention(text, 'gecko-x', 'gecko-than-lan-xanh')).toBe(
      '@gecko-than-lan-xanh chạy, @gecko-than-lan-xanh nhảy, @gecko-xanh đứng, mail a@gecko-x.com, @gecko-than-lan-xanh.',
    );
  });
});
