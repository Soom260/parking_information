// 화면에서 쓸 수 있는 값만 내려준다.
// 카카오 지도 JS키는 도메인 제한으로 보호되는 공개용 키이지만, 코드에 직접 박지 않고 여기서 전달한다.
const { loadEnv } = require("./_env");

module.exports = function handler(req, res) {
  loadEnv();
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ kakaoJsKey: process.env.KAKAO_JS_KEY || null }));
};
