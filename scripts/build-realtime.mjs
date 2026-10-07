// 실시간 빈자리를 모아 data/realtime.json 으로 저장한다.
// GitHub Actions 가 10분마다 돌려서, 인증키는 깃허브 서버 안에만 머물고
// 사이트에는 "빈자리 몇 면" 이라는 결과 숫자만 올라간다.
//
// 쓰는 법: node scripts/build-realtime.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
loadEnv();

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 서울시 시영주차장 실시간 정보 — 주차장 이름으로 맞춘다
async function seoulLive(key) {
  const out = {};
  const res = await fetch(`http://openapi.seoul.go.kr:8088/${key}/json/GetParkingInfo/1/200/`);
  const text = await res.text();
  if (!text.trim().startsWith("{")) throw new Error("서울시 응답이 JSON 이 아닙니다 (인증키 확인)");

  const body = JSON.parse(text).GetParkingInfo;
  if (!body || !Array.isArray(body.row)) throw new Error("서울시 응답에 row 가 없습니다");

  for (const r of body.row) {
    // PRK_STTS_YN === "1" 이면 20분 안쪽 연계 데이터가 있어 믿을 수 있다
    if (r.PRK_STTS_YN !== "1") continue;
    const capacity = num(r.TPKCT);
    const used = num(r.NOW_PRK_VHCL_CNT);
    if (capacity === null || used === null) continue;
    out["N:" + r.PKLT_NM.trim()] = {
      free: Math.max(0, capacity - used),
      capacity,
      updatedAt: r.NOW_PRK_VHCL_UPDT_TM || null,
    };
  }
  return out;
}

// 한국교통안전공단 실시간 주차정보 (서울) — 주차장 관리번호로 맞춘다
async function kotsaLive(key) {
  const out = {};
  const url = "https://apis.data.go.kr/B553881/Parking_v1/PrkRealtimeInfo_v1" +
    `?serviceKey=${key}&pageNo=1&numOfRows=1000&format=2&sidoCd=11`;
  const res = await fetch(url);
  const text = await res.text();
  if (!text.trim().startsWith("{")) throw new Error("교통안전공단 응답이 JSON 이 아닙니다 (인증키 확인)");

  for (const r of JSON.parse(text).PrkRealtimeInfo || []) {
    const free = num(r.pkfc_Available_ParkingLots_total);
    if (free === null) continue;
    out["K:" + r.prk_center_id] = { free, capacity: num(r.pkfc_ParkingLots_total) };
  }
  return out;
}

const live = {};
const errors = [];

if (process.env.SEOUL_API_KEY) {
  try {
    const o = await seoulLive(process.env.SEOUL_API_KEY);
    Object.assign(live, o);
    console.log(`서울시 시영주차장 실시간 ${Object.keys(o).length}곳`);
  } catch (e) {
    errors.push("서울시: " + e.message);
    console.error("서울시 실패:", e.message);
  }
} else {
  errors.push("SEOUL_API_KEY 가 없습니다");
}

if (process.env.KOTSA_API_KEY) {
  try {
    const o = await kotsaLive(process.env.KOTSA_API_KEY);
    Object.assign(live, o);
    console.log(`교통안전공단 실시간 ${Object.keys(o).length}곳`);
  } catch (e) {
    errors.push("교통안전공단: " + e.message);
    console.error("교통안전공단 실패:", e.message);
  }
} else {
  errors.push("KOTSA_API_KEY 가 없습니다");
}

// 한 곳도 못 받았으면 기존 파일을 덮어쓰지 않는다 (빈 화면이 되지 않게)
const outFile = path.join(ROOT, "data", "realtime.json");
if (!Object.keys(live).length) {
  console.error("받은 실시간 정보가 없습니다. 기존 파일을 그대로 둡니다.");
  console.error(errors.join(" / "));
  process.exit(1);
}

fs.writeFileSync(outFile, JSON.stringify({
  updatedAt: new Date().toISOString(),
  count: Object.keys(live).length,
  errors,
  live,
}));
console.log(`저장 완료 · 전체 ${Object.keys(live).length}곳`);
