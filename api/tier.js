// /api/tier?nicknames=닉네임1,닉네임2
// 넥슨 Open API로 FC온라인 "공식경기 1대1(matchtype=50)" 티어를 조회하는 프록시.
//
// API 키는 절대 이 파일에 직접 쓰지 않습니다.
// Vercel 프로젝트 설정 > Environment Variables 에 NEXON_API_KEY 라는 이름으로 저장해두면,
// 아래 process.env.NEXON_API_KEY 로 자동으로 불러와집니다.

const NEXON_BASE = "https://open.api.nexon.com/fconline/v1";
const DIVISION_META_URL = "https://open.api.nexon.com/static/fconline/meta/division.json";
const MATCHTYPE_공식경기_1대1 = 50;

let divisionCache = null; // { [divisionId]: divisionName } 형태로 캐싱

async function getDivisionMap() {
  if (divisionCache) return divisionCache;
  const res = await fetch(DIVISION_META_URL);
  const list = await res.json();
  divisionCache = {};
  list.forEach(d => { divisionCache[d.divisionId] = d.divisionName; });
  return divisionCache;
}

async function fetchJson(url, apiKey) {
  const res = await fetch(url, {
    headers: { "x-nxopen-api-key": apiKey }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nexon API ${res.status}: ${text}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "서버에 NEXON_API_KEY 환경변수가 설정되어 있지 않습니다." });
  }

  const nicknamesParam = req.query.nicknames || "";
  const nicknames = nicknamesParam.split(",").map(s => s.trim()).filter(Boolean);

  if (nicknames.length === 0) {
    return res.status(400).json({ error: "nicknames 쿼리 파라미터가 필요합니다. 예: ?nicknames=닉네임1,닉네임2" });
  }

  const divisionMap = await
