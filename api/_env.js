// .env 를 읽어 process.env 에 채운다. (배포 환경에서는 이미 들어 있으므로 건너뛴다)
const fs = require("node:fs");
const path = require("node:path");

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  const f = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

module.exports = { loadEnv };
