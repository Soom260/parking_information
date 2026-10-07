// 실시간 빈자리만 모아서 내려준다.
//  - 서울시 시영주차장 실시간 정보(GetParkingInfo): 122곳, 이름으로 맞춘다
//  - 한국교통안전공단 주차정보(PrkRealtimeInfo_v1): 전국, prk_center_id 로 맞춘다
// 인증키는 서버에서만 쓰고 화면에는 내보내지 않는다.
const { loadEnv } = require("./_env");

const TTL = 3 * 60 * 1000; // 3분
let cache = { at: 0, body: null };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function seoulLive(key) {
  const out = {};
  const url = `http://openapi.seoul.go.kr:8088/${key}/json/GetParkingInfo/1/200/`;
  const res = await fetch(url);
  const body = (await res.json()).GetParkingInfo;
  if (!body || !Array.isArray(body.row)) return out;

  for (const r of body.row) {
    // PRK_STTS_YN === "1" 이면 20분 안쪽 연계 데이터가 있어 믿을 수 있다
    if (r.PRK_STTS_YN !== "1") continue;
    const capacity = num(r.TPKCT);
    const used = num(r.NOW_PRK_VHCL_CNT);
    if (capacity == null || used == null) continue;
    out["N:" + r.PKLT_NM.trim()] = {
      free: Math.max(0, capacity - used),
      capacity,
      updatedAt: r.NOW_PRK_VHCL_UPDT_TM || null,
      from: "서울시",
    };
  }
  return out;
}

async function kotsaLive(key) {
  const out = {};
  // 서울(sidoCd=11) 실시간만 받는다. 수백 건 수준이라 한 번에 들어온다.
  const url = `https://apis.data.go.kr/B553881/Parking_v1/PrkRealtimeInfo_v1` +
    `?serviceKey=${key}&pageNo=1&numOfRows=1000&format=2&sidoCd=11`;
  const res = await fetch(url);
  const text = await res.text();
  if (!text.trim().startsWith("{")) return out; // 키 오류 등은 조용히 넘긴다

  const json = JSON.parse(text);
  for (const r of json.PrkRealtimeInfo || []) {
    const capacity = num(r.pkfc_ParkingLots_total);
    const free = num(r.pkfc_Available_ParkingLots_total);
    if (free == null) continue;
    out["K:" + r.prk_center_id] = { free, capacity, from: "교통안전공단" };
  }
  return out;
}

module.exports = async function handler(req, res) {
  loadEnv();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (cache.body && Date.now() - cache.at < TTL) {
    res.setHeader("Cache-Control", "public, s-maxage=180");
    res.end(cache.body);
    return;
  }

  const live = {};
  const errors = [];
  const jobs = [];

  if (process.env.SEOUL_API_KEY) {
    jobs.push(seoulLive(process.env.SEOUL_API_KEY)
      .then((o) => Object.assign(live, o))
      .catch((e) => errors.push("서울시: " + e.message)));
  }
  if (process.env.KOTSA_API_KEY) {
    jobs.push(kotsaLive(process.env.KOTSA_API_KEY)
      .then((o) => Object.assign(live, o))
      .catch((e) => errors.push("교통안전공단: " + e.message)));
  }
  await Promise.all(jobs);

  const body = JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: Object.keys(live).length,
    errors,
    live,
  });
  cache = { at: Date.now(), body };
  res.setHeader("Cache-Control", "public, s-maxage=180");
  res.end(body);
};
