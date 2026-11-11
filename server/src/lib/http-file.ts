import type { FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";

/** Sends a file with Range support, inline or as a download. */
export function streamFile(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  downloadName: string,
  contentType: string,
  inline = false
): unknown {
  if (!fs.existsSync(filePath)) {
    return reply.code(404).send({ error: "File not available yet" });
  }
  const stat = fs.statSync(filePath);
  reply.header("Content-Type", contentType);
  reply.header("Accept-Ranges", "bytes");
  if (!inline) {
    reply.header("Content-Disposition", `attachment; filename="${downloadName}"`);
  }

  // Range support so <audio> and <video> elements can seek.
  const match = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  const from = match?.[1] ?? "";
  const to = match?.[2] ?? "";
  if (from || to) {
    const start = from ? parseInt(from, 10) : Math.max(0, stat.size - parseInt(to, 10));
    const end = from && to ? Math.min(parseInt(to, 10), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      reply.header("Content-Range", `bytes */${stat.size}`);
      return reply.code(416).send();
    }
    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    reply.header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(filePath, { start, end }));
  }

  reply.header("Content-Length", stat.size);
  return reply.send(fs.createReadStream(filePath));
}
