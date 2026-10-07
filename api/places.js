// 카카오 장소 검색 프록시. "홍대입구역 교촌치킨" 같은 가게 이름을 좌표로 바꿔준다.
// 카카오 REST 키가 없으면 빈 목록을 돌려주고, 화면에서는 주차장 이름 검색으로 대체된다.
const { loadEnv } = require("./_env");

module.exports = async function handler(req, res) {
  loadEnv();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const q = new URL(req.url, "http://localhost").searchParams.get("q");
  if (!q) {
    res.statusCode = 400;
    res.end(JSON.stringify({ places: [], error: "검색어(q)가 없습니다" }));
    return;
  }

  const key = process.env.KAKAO_REST_KEY;
  if (!key) {
    res.end(JSON.stringify({ places: [], error: "KAKAO_REST_KEY 가 없습니다" }));
    return;
  }

  try {
    // 가게/건물 이름으로 찾기
    const kw = await fetch(
      "https://dapi.kakao.com/v2/local/search/keyword.json?size=8&query=" + encodeURIComponent(q),
      { headers: { Authorization: "KakaoAK " + key } }
    ).then((r) => r.json());

    let docs = kw.documents || [];

    // 이름으로 못 찾으면 주소로 한 번 더 찾는다
    if (!docs.length) {
      const addr = await fetch(
        "https://dapi.kakao.com/v2/local/search/address.json?size=8&query=" + encodeURIComponent(q),
        { headers: { Authorization: "KakaoAK " + key } }
      ).then((r) => r.json());
      docs = (addr.documents || []).map((d) => ({
        place_name: d.address_name,
        road_address_name: d.road_address ? d.road_address.address_name : "",
        address_name: d.address_name,
        x: d.x,
        y: d.y,
      }));
    }

    const places = docs.map((d) => ({
      name: d.place_name,
      addr: d.road_address_name || d.address_name || "",
      lat: Number(d.y),
      lng: Number(d.x),
    })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    res.setHeader("Cache-Control", "public, s-maxage=600");
    res.end(JSON.stringify({ places }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ places: [], error: e.message }));
  }
};
