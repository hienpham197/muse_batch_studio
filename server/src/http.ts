import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface SendOptions {
  contentType: string;
  cacheControl: string;
  /** Có giá trị thì trả về dạng tải xuống với tên file này. */
  downloadName?: string;
}

/** Trả file có hỗ trợ Range để trình phát video tua được. */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, opts: SendOptions) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy tệp.' } });
  }
  reply.header('Content-Type', opts.contentType);
  reply.header('Cache-Control', opts.cacheControl);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('X-Content-Type-Options', 'nosniff');
  if (opts.downloadName) reply.header('Content-Disposition', `attachment; filename="${opts.downloadName.replace(/[^\w.-]/g, '_')}"`);

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', stat.size);
  return reply.send(fs.createReadStream(file));
}
