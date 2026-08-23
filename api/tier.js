const fs = require("fs");
const path = require("path");

const NEXON_BASE = "https://open.api.nexon.com/fconline/v1";
const DIVISION_META_URL = "https://open.api.nexon.com/static/fconline/meta/division.json";
const OFFICIAL_MATCH_TYPE = 50;
const MAX_NICKNAMES = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 300;
const MAX_RETRIES = 2;
const tierCache = new Map();
let divisionMapPromise;
let nextRequestAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const loadStreamers = () => JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "streamers.json"), "utf8"));
function normalizeDivisionId(value) {
  const number = Number(value?.divisionId ?? value?.divisionID ?? value?.id ?? value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
async function getDivisionMap() {
  if (!divisionMapPromise) {
    divisionMapPromise = fetch(DIVISION_META_URL, { cache: "force-cache" }).then(async response => {
      if (!response.ok) throw new Error(`division metadata ${response.status}`);
      const data = await response.json();
      const map = {};
      for (const item of Array.isArray(data) ? data : Object.values(data)) {
        const id = normalizeDivisionId(item);
        const name = item?.divisionName ?? item?.name;
        if (id && name) map[id] = String(name);
      }
      return map;
    }).catch(error => { divisionMapPromise = null; console.warn("[TIER] division metadata failed:", error.message); return {}; });
  }
  return divisionMapPromise;
}
async function nexonFetch(endpoint, apiKey, attempt = 0) {
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(nextRequestAt, Date.now()) + MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
  const response = await fetch(`${NEXON_BASE}${endpoint}`, { headers: { "x-nxopen-api-key": apiKey, Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (response.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * (attempt + 1);
    console.warn(`[TIER] 429 on ${endpoint}; retrying in ${delay}ms`);
    await sleep(delay);
    return nexonFetch(endpoint, apiKey, attempt + 1);
  }
  if (!response.ok) throw new Error(`Nexon API ${response.status}: ${text || "request failed"}`);
  return text ? JSON.parse(text) : null;
}
async function resolveOuid(streamer, apiKey) {
  if (streamer.fcOuid) return String(streamer.fcOuid);
  const data = await nexonFetch(`/id?nickname=${encodeURIComponent(streamer.fcNickname)}`, apiKey);
  return data?.ouid ? String(data.ouid) : null;
}
function getMatchId(data) {
  const first = Array.isArray(data) ? data[0] : null;
  return typeof first === "string" ? first : first?.matchId ?? first?.matchid ?? null;
}
function getPlayer(detail, ouid) {
  return Array.isArray(detail?.matchInfo) ? detail.matchInfo.find(player => String(player?.ouid) === String(ouid)) : null;
}
function getDivisionScore(player) {
  return normalizeDivisionId(player?.division ?? player?.divisionId ?? player?.divisionID ?? player?.matchDivision);
}
async function getTier(streamer, apiKey, divisionMap) {
  const cached = tierCache.get(streamer.fcNickname);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.value;
  const ouid = await resolveOuid(streamer, apiKey);
  if (!ouid) throw new Error("OUID를 찾지 못했습니다.");
  const ids = await nexonFetch(`/user/match?ouid=${encodeURIComponent(ouid)}&matchtype=${OFFICIAL_MATCH_TYPE}&offset=0&limit=1`, apiKey);
  const latestMatchId = getMatchId(ids);
  if (!latestMatchId) throw new Error("최근 공식경기가 없습니다.");
  const detail = await nexonFetch(`/match-detail?matchid=${encodeURIComponent(latestMatchId)}`, apiKey);
  const divisionScore = getDivisionScore(getPlayer(detail, ouid));
  if (divisionScore === null) throw new Error("최근 공식경기에서 division 점수를 찾지 못했습니다.");
  const value = { ouid, latestMatchId: String(latestMatchId), divisionId: divisionScore, divisionScore, divisionName: divisionMap[divisionScore] ?? null, source: "latest-official-match", error: null };
  tierCache.set(streamer.fcNickname, { savedAt: Date.now(), value });
  return value;
}
export default async function handler(req, res) {
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "NEXON_API_KEY가 설정되어 있지 않습니다." });
  const nicknames = String(req.query?.nicknames || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!nicknames.length) return res.status(400).json({ error: "nicknames가 필요합니다." });
  if (nicknames.length > MAX_NICKNAMES) return res.status(400).json({ error: `한 번에 최대 ${MAX_NICKNAMES}명까지 조회할 수 있습니다.` });
  const byNickname = new Map(loadStreamers().map(streamer => [streamer.fcNickname, streamer]));
  const divisionMap = await getDivisionMap();
  const result = {};
  for (const nickname of nicknames) {
    const streamer = byNickname.get(nickname);
    if (!streamer) { result[nickname] = { divisionId: null, divisionName: null, source: null, error: "등록된 FC 닉네임이 아닙니다." }; continue; }
    try { result[nickname] = await getTier(streamer, apiKey, divisionMap); }
    catch (error) { result[nickname] = { ouid: streamer.fcOuid ?? null, latestMatchId: null, divisionId: null, divisionScore: null, divisionName: null, source: null, error: error.message }; }
  }
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  return res.status(200).json(result);
}
