// 내 컴퓨터에서 바로 열어보기용 정적 서버. 쓰는 법: node server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const PORT = process.env.PORT || 3000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  const route = new URL(req.url, "http://localhost").pathname;
  const rel = route === "/" ? "index.html" : route.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end("찾을 수 없습니다: " + rel);
    return;
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`주차장 찾기 → http://localhost:${PORT}`));
