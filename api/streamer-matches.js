const fs = require("fs");
const path = require("path");
const NEXON_BASE = "https://open.api.nexon.com/fconline/v1";
const MATCH_TYPE = 40;
const RECENT_MATCH_LIMIT = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 300;
let nextRequestAt = 0;
let matchesCache;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const loadStreamers = () => JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "streamers.json"), "utf8"));

async function nexonFetch(endpoint, apiKey, attempt = 0) {
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(nextRequestAt, Date.now()) + MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
  const response = await fetch(`${NEXON_BASE}${endpoint}`, { headers: { "x-nxopen-api-key": apiKey, Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (response.status === 429 && attempt < 2) { await sleep(2000 * (attempt + 1)); return nexonFetch(endpoint, apiKey, attempt + 1); }
  if (!response.ok) throw new Error(`Nexon API ${response.status}: ${text || "request failed"}`);
  return text ? JSON.parse(text) : null;
}
async function resolveOuid(streamer, apiKey) {
  if (streamer.fcOuid) return String(streamer.fcOuid);
  const data = await nexonFetch(`/id?nickname=${encodeURIComponent(streamer.fcNickname)}`, apiKey);
  return data?.ouid ? String(data.ouid) : null;
}
async function getRecentMatchIds(ouid, apiKey) {
  const data = await nexonFetch(`/user/match?ouid=${encodeURIComponent(ouid)}&matchtype=${MATCH_TYPE}&offset=0&limit=${RECENT_MATCH_LIMIT}`, apiKey);
  return new Set((Array.isArray(data) ? data : []).map(value => typeof value === "string" ? value : value?.matchId ?? value?.matchid).filter(Boolean).map(String));
}
function score(player) { const value = Number(player?.goal ?? player?.goals ?? player?.score); return Number.isFinite(value) ? value : null; }
function buildMatch(matchId, detail, streamerByOuid) {
  const players = Array.isArray(detail?.matchInfo) ? detail.matchInfo : [];
  // matchInfo의 두 참가자가 모두 등록 스트리머인 1:1 경기만 허용한다.
  if (players.length !== 2) return null;
  const registered = players.map(player => ({ player, streamer: streamerByOuid.get(String(player?.ouid)) })).filter(value => value.streamer);
  if (registered.length !== 2 || registered[0].streamer.fcOuid === registered[1].streamer.fcOuid) return null;
  const [first, second] = registered;
  const firstScore = score(first.player), secondScore = score(second.player);
  const member = value => ({ id: value.streamer.id, name: value.streamer.name, fcNickname: value.streamer.fcNickname, fcOuid: value.streamer.fcOuid, score: score(value.player) });
  return { matchId: String(matchId), matchType: MATCH_TYPE, matchTypeName: "클래식 1on1", matchDate: detail.matchDate ?? detail.matchdate ?? null, player1: member(first), player2: member(second), result: firstScore === null || secondScore === null ? "unknown" : firstScore === secondScore ? "draw" : firstScore > secondScore ? "win" : "lose" };
}
export default async function handler(req, res) {
  const apiKey = process.env.NEXON_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: "NEXON_API_KEY가 설정되어 있지 않습니다." });
  if (matchesCache && Date.now() - matchesCache.savedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json(matchesCache.value);
  }
  try {
    const streamers = loadStreamers().filter(streamer => streamer?.active !== false && streamer?.fcNickname);
    // 매치 화면 하나를 열 때 누락된 OUID를 전부 재조회하면 호출 수가 급증한다.
    // streamers.json에 확정된 OUID가 있는 등록 스트리머만 이 조회에 포함한다.
    const registered = streamers.filter(streamer => streamer.fcOuid);
    const byOuid = new Map(registered.map(streamer => [String(streamer.fcOuid), streamer]));
    const matchOwners = new Map();
    for (const streamer of registered) {
      const ids = await getRecentMatchIds(streamer.fcOuid, apiKey).catch(error => { console.warn("[STREAMER MATCHES] list failed", streamer.fcNickname, error.message); return new Set(); });
      for (const id of ids) { const owners = matchOwners.get(id) ?? new Set(); owners.add(String(streamer.fcOuid)); matchOwners.set(id, owners); }
    }
    // 목록 교집합만 상세 조회: 무관한 수천 건의 match-detail 호출을 하지 않는다.
    const candidates = [...matchOwners].filter(([, owners]) => owners.size === 2).map(([id]) => id);
    const matches = [];
    for (const matchId of candidates) {
      const detail = await nexonFetch(`/match-detail?matchid=${encodeURIComponent(matchId)}`, apiKey);
      const match = buildMatch(matchId, detail, byOuid);
      if (match) matches.push(match);
    }
    matches.sort((a, b) => new Date(b.matchDate || 0) - new Date(a.matchDate || 0));
    const value = { success: true, matchType: MATCH_TYPE, matchTypeName: "클래식 1on1", streamerCount: registered.length, searchedMatchCount: candidates.length, count: matches.length, matches };
    matchesCache = { savedAt: Date.now(), value };
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json(value);
  } catch (error) { return res.status(500).json({ success: false, error: "스트리머 매치 데이터를 불러오지 못했습니다.", detail: error.message }); }
}
