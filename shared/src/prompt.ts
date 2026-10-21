import { LIMITS } from './constants.js';
import type { SplitMode } from './types.js';

/** Dùng chung cho UI (badge đếm trực tiếp) và server (nguồn sự thật khi tạo job). */

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function splitPrompts(text: string, mode: SplitMode): string[] {
  const src = normalizeNewlines(text);
  if (mode === 'all') {
    const whole = src.trim();
    return whole ? [whole] : [];
  }
  if (mode === 'paragraph') {
    return src
      .split(/\n[ \t]*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function countPrompts(text: string, mode: SplitMode): number {
  return splitPrompts(text, mode).length;
}

// Không khớp khi @ đứng sau chữ / số / @ (ví dụ email a@b.com).
const MENTION_RE = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_-]+)/gu;

/** Các @tag trong prompt theo thứ tự xuất hiện, chữ thường, không trùng. */
export function extractMentions(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(MENTION_RE)) {
    const tag = m[1]!.toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export interface MentionRange {
  tag: string;
  start: number;
  end: number;
  known: boolean;
}

/** Vị trí từng @tag trong văn bản, để UI tô đỏ tag thiếu. */
export function findMentionRanges(text: string, known: ReadonlySet<string>): MentionRange[] {
  const out: MentionRange[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const tag = m[1]!.toLowerCase();
    out.push({ tag, start: m.index!, end: m.index! + m[0].length, known: known.has(tag) });
  }
  return out;
}

export interface PromptAnalysis {
  prompt: string;
  tags: string[];
  missing: string[];
}

export function analyzePrompts(prompts: string[], known: ReadonlySet<string>): PromptAnalysis[] {
  return prompts.map((prompt) => {
    const tags = extractMentions(prompt);
    return { prompt, tags, missing: tags.filter((t) => !known.has(t)) };
  });
}

/** Tag thiếu của cả batch, không trùng, giữ thứ tự xuất hiện. */
export function collectMissingTags(analysis: PromptAnalysis[]): string[] {
  const out: string[] = [];
  for (const a of analysis) for (const t of a.missing) if (!out.includes(t)) out.push(t);
  return out;
}

export function isPromptTooLong(prompt: string): boolean {
  return prompt.length > LIMITS.maxPromptLength;
}

/** Đổi mọi `@from` trong văn bản thành `@to` (so khớp không phân biệt hoa thường, đúng ranh giới tag). */
export function replaceMention(text: string, from: string, to: string): string {
  const want = from.toLowerCase();
  return text.replace(MENTION_RE, (whole, tag: string) => (tag.toLowerCase() === want ? `@${to}` : whole));
}
