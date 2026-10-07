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
const MAP_W = 420, MAP_H = 330, MAP_PAD = 34;

// 빈자리 상태에 따른 점 색
function dotColor(pk) {
  const l = liveOf(pk);
  if (!l || !Number.isFinite(l.free)) return "#2b6cb0";
  const ratio = l.capacity ? l.free / l.capacity : 1;
  return l.free <= 0 ? "#b3261e" : ratio < 0.1 ? "#d97706" : "#1f8a4c";
}

function drawMini() {
  const svg = $("mini-map");
  const W = MAP_W, H = MAP_H;
  const cx = W / 2, cy = H / 2;

  const parts = [
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#eaf0f6"/>',
  ];

  if (!state.center) {
    parts.push('<text x="' + cx + '" y="' + cy +
      '" text-anchor="middle" font-size="13" fill="#5f6b7a">위에서 "현 위치로 찾기"를 누르면 여기에 표시됩니다</text>');
    svg.innerHTML = parts.join("");
    return;
  }

  const r = state.radius;
  const span = r * 1.18;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((state.center.lat * Math.PI) / 180);
  const scale = Math.min(W - MAP_PAD * 2, H - MAP_PAD * 2) / (span * 2);

  const px = (lng) => cx + (lng - state.center.lng) * mPerDegLng * scale;
  const py = (lat) => cy - (lat - state.center.lat) * mPerDegLat * scale;
  const mLabel = (m) => (m >= 1000 ? m / 1000 + "km" : m + "m");

  // 바탕 격자 (100m 또는 500m 간격)
  const gridStep = r <= 500 ? 100 : r <= 1000 ? 250 : 500;
  const gridPx = gridStep * scale;
  parts.push('<g stroke="#dbe3ec" stroke-width="1">');
  for (let x = cx % gridPx; x < W; x += gridPx) parts.push('<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + H + '"/>');
  for (let y = cy % gridPx; y < H; y += gridPx) parts.push('<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '"/>');
  parts.push("</g>");

  // 거리 고리 (반경의 1/3, 2/3, 전체)
  for (const frac of [1 / 3, 2 / 3, 1]) {
    const rr = r * frac;
    const last = frac === 1;
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + rr * scale +
      '" fill="' + (last ? "#2b6cb0" : "none") + '" fill-opacity="' + (last ? 0.06 : 0) +
      '" stroke="#2b6cb0" stroke-opacity="' + (last ? 0.65 : 0.3) +
      '" stroke-width="' + (last ? 1.6 : 1) + '" stroke-dasharray="' + (last ? "6 4" : "3 4") + '"/>');
    parts.push('<text x="' + cx + '" y="' + (cy - rr * scale - 4) +
      '" text-anchor="middle" font-size="10" fill="#7a8696">' + mLabel(Math.round(rr)) + "</text>");
  }

  // 십자 기준선
  parts.push('<line x1="' + cx + '" y1="' + MAP_PAD / 2 + '" x2="' + cx + '" y2="' + (H - MAP_PAD / 2) +
    '" stroke="#c3cedb" stroke-width="1"/>');
  parts.push('<line x1="' + MAP_PAD / 2 + '" y1="' + cy + '" x2="' + (W - MAP_PAD / 2) + '" y2="' + cy +
    '" stroke="#c3cedb" stroke-width="1"/>');

  // 북쪽 표시
  parts.push('<text x="' + cx + '" y="' + (MAP_PAD / 2 - 2) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#7a8696">N ↑</text>');

  // 주차장 점 — 기준 위치와 선으로 이어 거리를 느끼게 한다
  state.nearby.forEach((pk) => {
    const x = px(pk.lng), y = py(pk.lat);
    parts.push('<line x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y +
      '" stroke="#9fb3c8" stroke-width="0.8" stroke-opacity="0.55"/>');
  });

  state.nearby.forEach((pk, i) => {
    const x = px(pk.lng), y = py(pk.lat);
    const l = liveOf(pk);
    parts.push('<circle cx="' + x + '" cy="' + y + '" r="9" fill="' + dotColor(pk) +
      '" stroke="#fff" stroke-width="2" class="pk-dot" data-idx="' + i + '"><title>' +
      esc(pk.name) + " · " + Math.round(pk.dist) + "m" +
      (l && Number.isFinite(l.free) ? " · 빈자리 " + l.free + "면" : "") + "</title></circle>");
    parts.push('<text x="' + x + '" y="' + (y + 3.5) +
      '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" pointer-events="none">' + (i + 1) + "</text>");
  });

  // 기준 위치
  parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="14" fill="#b3261e" fill-opacity="0.18"/>');
  parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="7" fill="#b3261e" stroke="#fff" stroke-width="3"><title>' +
    esc(state.center.label) + "</title></circle>");
  parts.push('<text x="' + (cx + 12) + '" y="' + (cy + 4) +
    '" font-size="11" font-weight="700" fill="#b3261e">' + esc(state.center.label) + "</text>");

  // 축척 막대
  const barM = gridStep;
  const barPx = barM * scale;
  const bx = W - MAP_PAD / 2 - barPx, by = H - 14;
  parts.push('<line x1="' + bx + '" y1="' + by + '" x2="' + (bx + barPx) + '" y2="' + by + '" stroke="#5f6b7a" stroke-width="2"/>');
  parts.push('<line x1="' + bx + '" y1="' + (by - 4) + '" x2="' + bx + '" y2="' + (by + 4) + '" stroke="#5f6b7a" stroke-width="2"/>');
  parts.push('<line x1="' + (bx + barPx) + '" y1="' + (by - 4) + '" x2="' + (bx + barPx) + '" y2="' + (by + 4) + '" stroke="#5f6b7a" stroke-width="2"/>');
  parts.push('<text x="' + (bx + barPx / 2) + '" y="' + (by - 7) +
    '" text-anchor="middle" font-size="10" fill="#5f6b7a">' + mLabel(barM) + "</text>");

  svg.innerHTML = parts.join("");

  // 점을 누르면 그 주차장으로 요금 계산기를 채운다
  svg.querySelectorAll(".pk-dot").forEach((el) => {
    el.addEventListener("click", () => {
      const pk = state.nearby[Number(el.dataset.idx)];
      if (!pk) return;
      $("calc-parking").value = pk.id;
      if (!$("calc-time").value) setCalcTimeNow();
      runCalc();
      $("calc-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
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
  drawMini();            // 아직 위치가 없어도 지도 자리를 그려 둔다

  // 위치 권한이 이미 허용돼 있으면 누르지 않아도 바로 찾아 준다
  if (navigator.permissions) {
    try {
      const p = await navigator.permissions.query({ name: "geolocation" });
      if (p.state === "granted") useHere();
    } catch { /* 지원하지 않는 브라우저는 버튼으로 */ }
  }

  // 요금은 1분마다 다시 계산하고, 실시간 빈자리 파일은 5분마다 새로 읽는다
  setInterval(runCalc, 60000);
  setInterval(async () => { await loadLive(); renderList(); drawMini(); }, 300000);
}

main().catch((e) => {
  $("empty").hidden = false;
  $("empty").textContent = "문제가 생겼습니다: " + e.message;
});
