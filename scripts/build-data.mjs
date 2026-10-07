// 서울시 주차장 정적 데이터를 내려받아 data/parkings.json 으로 합친다.
// 쓰는 법: node scripts/build-data.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
loadEnv();

const SEOUL_KEY = process.env.SEOUL_API_KEY;
if (!SEOUL_KEY) throw new Error(".env 에 SEOUL_API_KEY 가 없습니다");

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function seoul(service, start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${SEOUL_KEY}/json/${service}/${start}/${end}/`;
  const res = await fetch(url);
  const json = await res.json();
  const body = json[service];
  if (!body || body.RESULT?.CODE !== "INFO-000") {
    throw new Error(`${service} 실패: ${JSON.stringify(body?.RESULT ?? json)}`);
  }
  return body;
}

async function seoulAll(service) {
  const first = await seoul(service, 1, 1);
  const total = first.list_total_count;
  const rows = [];
  for (let s = 1; s <= total; s += 1000) {
    const b = await seoul(service, s, Math.min(s + 999, total));
    rows.push(...b.row);
    process.stdout.write(`  ${service} ${rows.length}/${total}\r`);
  }
  console.log(`  ${service} ${rows.length}/${total} 완료`);
  return rows;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const hhmm = (v) => (v && /^\d{4}$/.test(String(v)) ? String(v) : null);

console.log("1) 서울시 공영주차장 안내 정보(GetParkInfo) 받는 중…");
const base = await seoulAll("GetParkInfo");
console.log("2) 서울시 시영주차장 실시간 정보(GetParkingInfo) 받는 중…");
const live = await seoulAll("GetParkingInfo");

// 시영 실시간 데이터를 이름으로 붙인다 (코드 체계가 서로 달라 이름으로 맞춘다)
const liveByName = new Map(live.map((r) => [r.PKLT_NM.trim(), r]));

// GetParkInfo 는 주차 구획 한 칸이 한 행이라 같은 주차장이 여러 번 나온다.
// 주차장 코드(PKLT_CD)로 묶고, 주차면수는 행 수만큼 더해 실제 규모를 구한다.
const groups = new Map();
for (const r of base) {
  const code = String(r.PKLT_CD);
  const g = groups.get(code);
  if (!g) {
    groups.set(code, { rep: r, slots: num(r.TPKCT) || 1 });
  } else {
    g.slots += num(r.TPKCT) || 1;
    // 좌표가 비어 있던 대표 행이면 좌표가 있는 행으로 바꿔 둔다
    if (!(num(g.rep.LAT) && num(g.rep.LOT)) && num(r.LAT) && num(r.LOT)) g.rep = r;
  }
}
console.log(`  주차장 코드로 묶음: ${base.length}행 → ${groups.size}곳`);

const out = [];
for (const { rep: r, slots } of groups.values()) {
  const name = r.PKLT_NM.trim();
  const l = liveByName.get(name);
  const lat = num(r.LAT), lng = num(r.LOT);
  out.push({
    id: `S${r.PKLT_CD}`,
    source: "seoul",
    name,
    addr: (r.ADDR || "").trim(),
    tel: (r.TELNO || "").trim() || null,
    lat: lat || null,
    lng: lng || null,
    kind: r.PKLT_KND_NM || null,          // 노외/노상
    operKind: r.OPER_SE_NM || null,       // 시간제 등
    capacity: (l ? num(l.TPKCT) : 0) || slots || null,   // 총 주차면수 (규모)
    paid: (l?.PAY_YN ?? r.CHGD_FREE_SE) === "Y",
    nightOpen: (l?.NGHT_PAY_YN ?? r.NGHT_FREE_OPN_YN) === "Y",
    satFree: (l?.SAT_CHGD_FREE_SE ?? r.SAT_CHGD_FREE_SE) !== "Y",
    holidayFree: (l?.LHLDY_CHGD_FREE_SE ?? r.LHLDY_YN) !== "Y",
    // 요금: 시영 실시간 쪽 값이 더 최신이라 그걸 우선
    fee: {
      baseFee: num(l?.BSC_PRK_CRG ?? r.PRK_CRG),
      baseMin: num(l?.BSC_PRK_HR ?? r.PRK_HM),
      addFee: num(l?.ADD_PRK_CRG ?? r.ADD_CRG),
      addMin: num(l?.ADD_PRK_HR ?? r.ADD_UNIT_TM_MNT),
      dayMax: num(l?.DAY_MAX_CRG ?? r.DLY_MAX_CRG) || null,
      monthly: num(l?.PRD_AMT ?? r.MNTL_CMUT_CRG) || null,
    },
    hours: {
      weekday: [hhmm(r.WD_OPER_BGNG_TM), hhmm(r.WD_OPER_END_TM)],
      weekend: [hhmm(r.WE_OPER_BGNG_TM), hhmm(r.WE_OPER_END_TM)],
      holiday: [hhmm(r.LHLDY_BGNG), hhmm(r.LHLDY)],
    },
    // 실시간을 제공하는 시영주차장이면 표시해 둔다
    liveName: l ? name : null,
    capacityLive: l ? num(l.TPKCT) || null : null,
  });
}

// 좌표 없는 곳은 지도에 못 찍으니 뒤로 보내되 버리지는 않는다
out.sort((a, b) => (b.lat ? 1 : 0) - (a.lat ? 1 : 0));

const withCoord = out.filter((p) => p.lat && p.lng).length;
const payload = {
  builtAt: new Date().toISOString(),
  counts: { total: out.length, withCoord, live: liveByName.size },
  parkings: out,
};
fs.writeFileSync(path.join(ROOT, "data", "parkings.json"), JSON.stringify(payload));
console.log(`\n저장 완료 · 전체 ${out.length}곳 / 좌표 있는 곳 ${withCoord}곳 / 실시간 ${liveByName.size}곳`);
