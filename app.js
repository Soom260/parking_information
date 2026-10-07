"use strict";

// ---------- 상태 ----------
const RADII = [100, 500, 1000, 3000];
const state = {
  center: null,        // { lat, lng, label }
  radius: 1000,
  parkings: [],        // 정적 데이터 (좌표 있는 것만)
  live: new Map(),     // "N:주차장이름" -> { free, capacity, updatedAt }
  liveStamp: null,
  nearby: [],
};

const $ = (id) => document.getElementById(id);
const won = (n) => Number(n).toLocaleString("ko-KR") + "원";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- 거리 (하버사인) ----------
function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- 요금 계산 ----------
// 공개된 기본요금/기본시간/추가요금/추가시간으로 계산한다. 일 최대요금이 있으면 상한을 씌운다.
function calcFee(pk, startMs, nowMs) {
  const f = pk.fee || {};
  const minutes = Math.max(0, Math.ceil((nowMs - startMs) / 60000));
  const lines = [];
  const notes = [];

  if (!pk.paid) {
    return { minutes, amount: 0, lines: ["무료 주차장입니다."], notes };
  }
  if (!f.baseFee && !f.addFee) {
    return { minutes, amount: null, lines: [], notes: ["이 주차장은 공개된 요금 정보가 없어 계산할 수 없습니다."] };
  }

  const baseMin = f.baseMin > 0 ? f.baseMin : 0;
  let amount = f.baseFee || 0;
  lines.push("기본 " + baseMin + "분까지 " + won(f.baseFee || 0));

  const over = minutes - baseMin;
  if (over > 0) {
    if (f.addMin > 0 && f.addFee > 0) {
      const units = Math.ceil(over / f.addMin);
      amount += units * f.addFee;
      lines.push("초과 " + over + "분 → " + f.addMin + "분당 " + won(f.addFee) + " × " + units + "회 = " + won(units * f.addFee));
    } else {
      notes.push("추가요금 정보가 없어 기본요금만 계산했습니다. 실제로는 더 나올 수 있습니다.");
    }
  }

  if (f.dayMax && amount > f.dayMax) {
    lines.push("일 최대요금 " + won(f.dayMax) + " 적용");
    amount = f.dayMax;
  }

  const day = new Date(nowMs).getDay();
  if (day === 6 && pk.satFree) notes.push("토요일은 무료로 안내된 주차장입니다. 현장 안내를 확인하세요.");
  if (day === 0 && pk.holidayFree) notes.push("공휴일은 무료로 안내된 주차장입니다. 현장 안내를 확인하세요.");

  return { minutes, amount, lines, notes };
}

function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? h + "시간 " + m + "분" : m + "분";
}

// ---------- 데이터 불러오기 ----------
async function loadStatic() {
  const res = await fetch("data/parkings.json");
  if (!res.ok) throw new Error("주차장 데이터를 불러오지 못했습니다");
  const json = await res.json();
  state.parkings = json.parkings.filter((p) => p.lat && p.lng);
}

// 실시간 빈자리는 GitHub Actions 가 10분마다 만들어 두는 파일에서 읽는다.
// (인증키는 깃허브 서버 안에서만 쓰이고, 화면에는 결과 숫자만 내려온다)
async function loadLive() {
  try {
    const res = await fetch("data/realtime.json?t=" + Date.now());
    if (!res.ok) return;
    const json = await res.json();
    state.live = new Map(Object.entries(json.live || {}));
    state.liveStamp = json.updatedAt || null;
  } catch {
    /* 실시간이 없어도 나머지는 보여준다 */
  }
}

// ---------- 간이 지도 ----------
function drawMini() {
  const svg = $("mini-map");
  if (!state.center) { svg.innerHTML = ""; return; }

  const W = 400, H = 300, pad = 30;
  const r = state.radius;
  const span = r * 1.18;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((state.center.lat * Math.PI) / 180);
  const scale = Math.min(W - pad * 2, H - pad * 2) / (span * 2);

  const px = (lng) => W / 2 + (lng - state.center.lng) * mPerDegLng * scale;
  const py = (lat) => H / 2 - (lat - state.center.lat) * mPerDegLat * scale;

  const label = r >= 1000 ? r / 1000 + "km" : r + "m";
  const parts = [
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#eef2f7"/>',
    // 범위 안쪽 절반 지점 안내선
    '<circle cx="' + W / 2 + '" cy="' + H / 2 + '" r="' + (r / 2) * scale +
      '" fill="none" stroke="#c7d2e0" stroke-width="1" stroke-dasharray="3 4"/>',
    '<circle cx="' + W / 2 + '" cy="' + H / 2 + '" r="' + r * scale +
      '" fill="#2b6cb0" fill-opacity="0.07" stroke="#2b6cb0" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="5 4"/>',
    '<text x="' + W / 2 + '" y="' + Math.max(12, H / 2 - r * scale - 6) +
      '" text-anchor="middle" font-size="11" fill="#5f6b7a">' + label + "</text>",
  ];

  state.nearby.forEach((pk, i) => {
    const x = px(pk.lng), y = py(pk.lat);
    const l = liveOf(pk);
    // 빈자리 상태에 따라 점 색을 달리한다
    let fill = "#2b6cb0";
    if (l && Number.isFinite(l.free)) {
      const ratio = l.capacity ? l.free / l.capacity : 1;
      fill = l.free <= 0 ? "#b3261e" : ratio < 0.1 ? "#d97706" : "#1f8a4c";
    }
    parts.push('<circle cx="' + x + '" cy="' + y + '" r="8" fill="' + fill +
      '" stroke="#fff" stroke-width="2"><title>' + esc(pk.name) + " · " + Math.round(pk.dist) + "m" +
      (l && Number.isFinite(l.free) ? " · 빈자리 " + l.free + "면" : "") + "</title></circle>");
    parts.push('<text x="' + x + '" y="' + (y + 3.5) +
      '" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" pointer-events="none">' + (i + 1) + "</text>");
  });

  parts.push('<circle cx="' + W / 2 + '" cy="' + H / 2 + '" r="8" fill="#b3261e" stroke="#fff" stroke-width="3"><title>' +
    esc(state.center.label) + "</title></circle>");
  parts.push('<text x="' + W / 2 + '" y="' + (H / 2 + 24) +
    '" text-anchor="middle" font-size="11" font-weight="700" fill="#b3261e">' + esc(state.center.label) + "</text>");

  svg.innerHTML = parts.join("");
}

// ---------- 주변 찾기 ----------
function findNearby() {
  if (!state.center) return;
  state.nearby = state.parkings
    .map((p) => Object.assign({}, p, { dist: distanceM(state.center, p) }))
    .filter((p) => p.dist <= state.radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 50);
  renderList();
  drawMini();
  fillCalcSelect();
}

function liveOf(pk) {
  return (pk.liveName ? state.live.get("N:" + pk.liveName) : null) || state.live.get(pk.id) || null;
}

function renderList() {
  const ul = $("list");
  const empty = $("empty");
  $("count").textContent = state.nearby.length ? state.nearby.length + "곳" : "";
  $("live-stamp").textContent = state.liveStamp
    ? "실시간 빈자리 기준 시각: " + new Date(state.liveStamp).toLocaleString("ko-KR")
    : "실시간 빈자리 정보를 아직 못 받았습니다.";

  if (!state.center) {
    ul.innerHTML = "";
    empty.hidden = false;
    empty.textContent = '위에서 "현 위치로 찾기"를 먼저 눌러주세요.';
    return;
  }
  if (!state.nearby.length) {
    ul.innerHTML = "";
    empty.hidden = false;
    empty.textContent = (state.radius >= 1000 ? state.radius / 1000 + "km" : state.radius + "m") +
      " 안에 시영주차장이 없습니다. 찾는 범위를 넓혀 보세요.";
    return;
  }
  empty.hidden = true;

  ul.innerHTML = state.nearby.map((pk, i) => {
    const l = liveOf(pk);
    const badges = [];
    if (l && Number.isFinite(l.free)) {
      const ratio = l.capacity ? l.free / l.capacity : 1;
      const cls = l.free <= 0 ? "live-full" : ratio < 0.1 ? "live-tight" : "live-good";
      const word = l.free <= 0 ? "만차" : "빈자리 " + l.free + "면";
      badges.push('<span class="badge ' + cls + '">' + word + "</span>");
    }
    badges.push('<span class="badge ' + (pk.paid ? "" : "free") + '">' + (pk.paid ? "유료" : "무료") + "</span>");
    if (pk.kind) badges.push('<span class="badge">' + esc(pk.kind) + "</span>");
    if (pk.nightOpen) badges.push('<span class="badge">야간 개방</span>');

    const f = pk.fee || {};
    let feeLine;
    if (!pk.paid) feeLine = "요금: 무료";
    else if (f.baseFee) {
      feeLine = "요금: 기본 " + f.baseMin + "분 " + won(f.baseFee) +
        (f.addMin && f.addFee ? " · 추가 " + f.addMin + "분당 " + won(f.addFee) : " · 추가요금 정보 없음") +
        (f.dayMax ? " · 일 최대 " + won(f.dayMax) : "");
    } else feeLine = "요금: 정보 없음";

    const wd = (pk.hours && pk.hours.weekday) || [];
    const hourLine = wd[0] && wd[1]
      ? "운영: 평일 " + wd[0].slice(0, 2) + ":" + wd[0].slice(2) + " ~ " + wd[1].slice(0, 2) + ":" + wd[1].slice(2)
      : "";

    const usedLine = l && Number.isFinite(l.free) && l.capacity
      ? " (현재 " + (l.capacity - l.free) + "면 사용 중)" : "";

    return '<li>' +
      '<div class="pk-head"><span class="pk-name">' + (i + 1) + ". " + esc(pk.name) + "</span>" +
      '<span class="pk-dist">' + Math.round(pk.dist) + "m</span></div>" +
      '<div class="pk-addr">' + esc(pk.addr) + (pk.tel ? " · " + esc(pk.tel) : "") + "</div>" +
      '<div class="badges">' + badges.join("") + "</div>" +
      '<div class="pk-facts">' +
        "<div>규모: 총 " + (pk.capacity ? pk.capacity + "면" : "정보 없음") + usedLine + "</div>" +
        "<div>" + feeLine + "</div>" +
        (hourLine ? "<div>" + hourLine + "</div>" : "") +
      "</div>" +
      '<button data-pick="' + esc(pk.id) + '">여기 주차함</button>' +
      "</li>";
  }).join("");

  ul.querySelectorAll("[data-pick]").forEach((b) => {
    b.addEventListener("click", () => {
      $("calc-parking").value = b.dataset.pick;
      if (!$("calc-time").value) setCalcTimeNow();
      runCalc();
      $("calc-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// ---------- 요금 계산기 ----------
function fillCalcSelect() {
  const sel = $("calc-parking");
  const keep = sel.value;
  const opts = state.nearby.length ? state.nearby : state.parkings;
  sel.innerHTML = '<option value="">주차장을 고르세요</option>' +
    opts.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) +
      (p.dist ? " (" + Math.round(p.dist) + "m)" : "") + "</option>").join("");
  if (keep && opts.some((p) => p.id === keep)) sel.value = keep;
}

function setCalcTimeNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  $("calc-time").value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function runCalc() {
  const box = $("calc-result");
  const id = $("calc-parking").value;
  const t = $("calc-time").value;
  if (!id || !t) { box.hidden = true; return; }

  const pk = state.parkings.find((p) => p.id === id);
  if (!pk) { box.hidden = true; return; }

  const startMs = new Date(t).getTime();
  const nowMs = Date.now();
  if (startMs > nowMs) {
    box.hidden = false;
    box.innerHTML = '<p class="calc-note">주차한 시각이 아직 오지 않았습니다. 지난 시각을 넣어주세요.</p>';
    return;
  }

  const r = calcFee(pk, startMs, nowMs);
  box.hidden = false;
  box.innerHTML =
    '<p class="calc-amount">' + (r.amount === null ? "계산 불가" : won(r.amount)) + "</p>" +
    "<div>" + esc(pk.name) + " · 주차 " + fmtDuration(r.minutes) + " 경과</div>" +
    (r.lines.length ? '<ul class="calc-lines">' + r.lines.map((l) => "<li>" + l + "</li>").join("") + "</ul>" : "") +
    r.notes.map((n) => '<p class="calc-note">' + n + "</p>").join("");
}

// ---------- 위치 정하기 ----------
function setCenter(lat, lng, label) {
  state.center = { lat: lat, lng: lng, label: label };
  const el = $("center-label");
  el.textContent = "기준 위치: " + label;
  el.classList.add("set");
  findNearby();
}

function useHere() {
  if (!navigator.geolocation) {
    $("center-label").textContent = "이 브라우저는 현 위치를 지원하지 않습니다.";
    $("fallback-row").hidden = false;
    return;
  }
  $("center-label").textContent = "현 위치를 찾는 중…";
  navigator.geolocation.getCurrentPosition(
    (pos) => setCenter(pos.coords.latitude, pos.coords.longitude, "현 위치"),
    (err) => {
      $("center-label").textContent = err.code === 1
        ? "위치 권한이 거절됐습니다. 브라우저 주소창의 자물쇠에서 위치를 허용해 주세요."
        : "현 위치를 못 받았습니다.";
      $("fallback-row").hidden = false;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ---------- 시작 ----------
async function main() {
  $("btn-here").addEventListener("click", useHere);
  $("btn-cityhall").addEventListener("click", () => setCenter(37.5663, 126.9779, "서울시청"));
  $("radius").addEventListener("input", (e) => {
    state.radius = RADII[Number(e.target.value)];
    $("radius-out").textContent = state.radius >= 1000 ? state.radius / 1000 + "km" : state.radius + "m";
    findNearby();
  });
  $("calc-parking").addEventListener("change", runCalc);
  $("calc-time").addEventListener("change", runCalc);
  $("btn-now").addEventListener("click", () => { setCalcTimeNow(); runCalc(); });

  await loadStatic();
  await loadLive();
  fillCalcSelect();
  renderList();

  // 요금은 1분마다 다시 계산하고, 실시간 빈자리 파일은 5분마다 새로 읽는다
  setInterval(runCalc, 60000);
  setInterval(async () => { await loadLive(); renderList(); drawMini(); }, 300000);
}

main().catch((e) => {
  $("empty").hidden = false;
  $("empty").textContent = "문제가 생겼습니다: " + e.message;
});
