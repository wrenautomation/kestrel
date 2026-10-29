/**
 * `kestrel view`: a local server for the built page, its data, and notes to a Claude Code
 * session through Devboard's `/api/notify` (the page's `n` key). Loopback only.
 */
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ASSETS = fileURLToPath(new URL("../viewer/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export interface ServeOptions {
  port: number;
  /** Devboard's canvas server, where notes go. */
  devboard: string;
  data: () => Promise<unknown>;
}

export interface Served {
  url: string;
  /** Drops the held data and tells open pages to fetch it again. */
  changed(): void;
}

export async function serve(opts: ServeOptions & { live?: boolean }): Promise<Served> {
  let cached: Buffer | undefined;
  const pages = new Set<ServerResponse>();
  const data = async () => {
    cached ??= gzipSync(JSON.stringify(await opts.data()));
    return cached;
  };
  await data();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname === "/data.json") {
        if (url.searchParams.has("fresh")) cached = undefined;
        res.writeHead(200, { "content-type": TYPES[".json"], "content-encoding": "gzip" });
        res.end(await data());
        return;
      }
      if (url.pathname === "/events" && opts.live) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(": open\n\n");
        pages.add(res);
        req.on("close", () => pages.delete(res));
        return;
      }
      if (url.pathname === "/api/watchers") {
        const r = await fetch(`${opts.devboard}/api/watchers`);
        res.writeHead(r.status, { "content-type": TYPES[".json"] });
        res.end(await r.text());
        return;
      }
      if (url.pathname === "/api/note" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const r = await fetch(`${opts.devboard}/api/notify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(r.status, { "content-type": TYPES[".json"] });
        res.end(await r.text());
        return;
      }
      const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
      if (rel.startsWith("..")) throw new Error("outside");
      const body = await readFile(join(ASSETS, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead((e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 502);
      res.end(String((e as Error).message));
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, "127.0.0.1", ok);
  });
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : opts.port}/`,
    changed() {
      cached = undefined;
      for (const p of pages) p.write("data: map\n\n");
    },
  };
}
