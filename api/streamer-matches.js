```javascript
/*
 * api/streamer-matches.js
 *
 * 등록된 스트리머끼리 진행한 FC온라인 클래식 1on1 경기 조회
 *
 * MATCHTYPE
 * 40 = 클래식 1on1
 *
 * 동작
 * 1. streamers.json 로드
 * 2. fcOuid가 없으면 fcNickname으로 OUID 조회
 * 3. 각 스트리머의 클래식 1on1 경기 ID를 최대한 확보
 * 4. 중복 matchId 제거
 * 5. match-detail 조회
 * 6. 상세 데이터 전체에서 등록 스트리머 OUID 탐색
 * 7. 등록 스트리머 2명이 참가한 경기만 추출
 * 8. 최신순 정렬
 */

const fs = require("fs");
const path = require("path");

/* ============================================================
   설정
============================================================ */

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const MATCH_TYPE = 40;

/*
 * 한 스트리머당 한 번에 가져오는 경기 수
 *
 * 기존 30 → 100
 */
const MATCH_LIMIT = 100;

/*
 * 여러 페이지를 확인
 *
 * API가 100개까지 허용되는 경우
 * 100개씩 여러 번 확인합니다.
 */
const MAX_PAGES = 5;

/*
 * API 요청 간격
 */
const REQUEST_DELAY = 200;

/*
 * 429 재시도
 */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

/* ============================================================
   sleep
============================================================ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   JSON RESPONSE
============================================================ */

function sendJson(res, status, data) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  return res.status(status).json(data);
}

/* ============================================================
   STREAMERS
============================================================ */

function loadStreamers() {
  const filePath = path.join(
    process.cwd(),
    "data",
    "streamers.json"
  );

  const text = fs.readFileSync(
    filePath,
    "utf8"
  );

  const data = JSON.parse(text);

  if (!Array.isArray(data)) {
    throw new Error(
      "streamers.json must be an array"
    );
  }

  return data;
}

/* ============================================================
   NEXON FETCH
============================================================ */

async function nexonFetch(
  endpoint,
  apiKey,
  retryCount = 0
) {
  const response = await fetch(
    `${NEXON_BASE}${endpoint}`,
    {
      method: "GET",

      headers: {
        "x-nxopen-api-key": apiKey,
        "Accept": "application/json"
      },

      cache: "no-store"
    }
  );

  const text = await response.text();

  /* 429 */

  if (response.status === 429) {
    if (retryCount < MAX_RETRIES) {
      const delay =
        RETRY_BASE_DELAY *
        Math.pow(2, retryCount);

      console.warn(
        `[CLASSIC 1ON1] 429 → ${delay}ms 후 재시도`
      );

      await sleep(delay);

      return nexonFetch(
        endpoint,
        apiKey,
        retryCount + 1
      );
    }

    throw new Error(
      `Nexon API 429: ${text || "Rate Limit"}`
    );
  }

  /* HTTP ERROR */

  if (!response.ok) {
    throw new Error(
      `Nexon API ${response.status}: ${
        text || "Unknown error"
      }`
    );
  }

  /* EMPTY */

  if (!text) {
    return null;
  }

  /* JSON */

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Nexon API JSON 파싱 실패"
    );
  }
}

/* ============================================================
   NICKNAME → OUID
============================================================ */

async function getOuidByNickname(
  nickname,
  apiKey
) {
  if (!nickname) {
    return null;
  }

  const data = await nexonFetch(
    `/id?nickname=${encodeURIComponent(nickname)}`,
    apiKey
  );

  if (
    data &&
    data.ouid
  ) {
    return String(data.ouid);
  }

  return null;
}

/* ============================================================
   MATCH ID 추출
============================================================ */

function extractMatchId(item) {
  if (!item) {
    return null;
  }

  if (typeof item === "string") {
    return item;
  }

  if (typeof item === "object") {
    return (
      item.matchId ||
      item.matchid ||
      item.matchID ||
      null
    );
  }

  return null;
}

/* ============================================================
   한 페이지 경기 조회
============================================================ */

async function getMatchPage(
  ouid,
  offset,
  apiKey
) {
  const endpoint =
    `/user/match` +
    `?ouid=${encodeURIComponent(ouid)}` +
    `&matchtype=${MATCH_TYPE}` +
    `&offset=${offset}` +
    `&limit=${MATCH_LIMIT}`;

  console.log(
    `[CLASSIC 1ON1] 경기 목록 요청: offset=${offset}`
  );

  const data =
    await nexonFetch(
      endpoint,
      apiKey
    );

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map(extractMatchId)
    .filter(Boolean);
}

/* ============================================================
   한 스트리머의 경기 전체 조회
============================================================ */

async function getAllMatchIds(
  ouid,
  apiKey
) {
  if (!ouid) {
    return [];
  }

  const result = new Set();

  for (
    let page = 0;
    page < MAX_PAGES;
    page++
  ) {
    const offset =
      page * MATCH_LIMIT;

    let ids = [];

    try {
      ids =
        await getMatchPage(
          ouid,
          offset,
          apiKey
        );
    } catch (error) {
      console.warn(
        `[CLASSIC 1ON1] 경기 목록 조회 실패 offset=${offset}:`,
        error?.message
      );

      break;
    }

    console.log(
      `[CLASSIC 1ON1] offset=${offset}, ${ids.length}개`
    );

    if (!ids.length) {
      break;
    }

    for (const id of ids) {
      result.add(String(id));
    }

    /*
     * 요청한 limit보다 적게 왔다면
     * 더 이상 다음 페이지가 없다고 판단
     */
    if (ids.length < MATCH_LIMIT) {
      break;
    }

    await sleep(
      REQUEST_DELAY
    );
  }

  return Array.from(result);
}

/* ============================================================
   MATCH DETAIL
============================================================ */

async function getMatchDetail(
  matchId,
  apiKey
) {
  if (!matchId) {
    return null;
  }

  return nexonFetch(
    `/match-detail?matchid=${encodeURIComponent(matchId)}`,
    apiKey
  );
}

/* ============================================================
   등록 스트리머 MAP
============================================================ */

function createStreamerMap(
  streamers
) {
  const map = new Map();

  for (
    const streamer of streamers
  ) {
    if (
      !streamer ||
      streamer.active === false
    ) {
      continue;
    }

    if (!streamer.fcOuid) {
      continue;
    }

    map.set(
      String(streamer.fcOuid),
      streamer
    );
  }

  return map;
}

/* ============================================================
   객체 안에서 OUID 찾기
============================================================ */

/*
 * matchInfo 구조를 너무 강하게 가정하지 않기 위해
 * 상세 응답 전체를 재귀적으로 탐색합니다.
 *
 * 예:
 *
 * {
 *   ouid: "...",
 *   matchInfo: [...]
 * }
 *
 * 뿐 아니라
 *
 * {
 *   matchInfo: {
 *     player: {
 *       ouid: "..."
 *     }
 *   }
 * }
 *
 * 같은 구조도 대응합니다.
 */

function collectOuidObjects(
  value,
  streamerMap,
  found,
  visited = new Set()
) {
  if (
    value === null ||
    value === undefined
  ) {
    return;
  }

  if (
    typeof value !== "object"
  ) {
    return;
  }

  if (
    visited.has(value)
  ) {
    return;
  }

  visited.add(value);

  /*
   * 현재 객체에 ouid가 있는 경우
   */

  if (
    value.ouid !== null &&
    value.ouid !== undefined
  ) {
    const ouid =
      String(value.ouid);

    const streamer =
      streamerMap.get(ouid);

    if (streamer) {
      found.set(
        ouid,
        {
          streamer,
          player: value
        }
      );
    }
  }

  /*
   * 배열
   */

  if (Array.isArray(value)) {
    for (const item of value) {
      collectOuidObjects(
        item,
        streamerMap,
        found,
        visited
      );
    }

    return;
  }

  /*
   * 객체 전체 탐색
   */

  for (
    const key of Object.keys(value)
  ) {
    collectOuidObjects(
      value[key],
      streamerMap,
      found,
      visited
    );
  }
}

/* ============================================================
   스트리머 참가자 찾기
============================================================ */

function findStreamerPlayers(
  detail,
  streamerMap
) {
  const found =
    new Map();

  collectOuidObjects(
    detail,
    streamerMap,
    found
  );

  return Array.from(
    found.values()
  );
}

/* ============================================================
   날짜 찾기
============================================================ */

function findDateRecursive(
  value,
  visited = new Set()
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value !== "object"
  ) {
    return null;
  }

  if (
    visited.has(value)
  ) {
    return null;
  }

  visited.add(value);

  const keys = [
    "matchDate",
    "matchdate",
    "matchTime",
    "matchtime",
    "date",
    "datetime",
    "matchDatetime",
    "matchdatetime"
  ];

  for (
    const key of keys
  ) {
    if (
      value[key] !== null &&
      value[key] !== undefined &&
      value[key] !== ""
    ) {
      return value[key];
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result =
        findDateRecursive(
          item,
          visited
        );

      if (result) {
        return result;
      }
    }

    return null;
  }

  for (
    const key of Object.keys(value)
  ) {
    const result =
      findDateRecursive(
        value[key],
        visited
      );

    if (result) {
      return result;
    }
  }

  return null;
}

/* ============================================================
   SCORE
============================================================ */

function extractScore(
  player
) {
  if (!player) {
    return null;
  }

  const candidates = [
    player.goal,
    player.goals,
    player.score,
    player.scores,
    player.matchScore,
    player.matchscore,
    player.shoot
  ];

  for (
    const value of candidates
  ) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const number =
      Number(value);

    if (
      Number.isFinite(number)
    ) {
      return number;
    }
  }

  return null;
}

/* ============================================================
   RESULT
============================================================ */

function calculateResult(
  firstScore,
  secondScore
) {
  if (
    firstScore === null ||
    secondScore === null
  ) {
    return "unknown";
  }

  if (
    firstScore >
    secondScore
  ) {
    return "win";
  }

  if (
    firstScore <
    secondScore
  ) {
    return "lose";
  }

  return "draw";
}

/* ============================================================
   MATCH RESULT
============================================================ */

function buildMatchResult(
  matchId,
  detail,
  streamerPlayers
) {
  if (
    streamerPlayers.length !== 2
  ) {
    return null;
  }

  const first =
    streamerPlayers[0];

  const second =
    streamerPlayers[1];

  const firstScore =
    extractScore(
      first.player
    );

  const secondScore =
    extractScore(
      second.player
    );

  return {
    matchId: String(matchId),

    matchType:
      MATCH_TYPE,

    matchTypeName:
      "클래식 1on1",

    matchDate:
      findDateRecursive(
        detail
      ),

    player1: {
      id:
        first.streamer.id ||
        null,

      name:
        first.streamer.name ||
        first.streamer.fcNickname ||
        null,

      fcNickname:
        first.streamer.fcNickname ||
        null,

      fcOuid:
        first.streamer.fcOuid,

      score:
        firstScore
    },

    player2: {
      id:
        second.streamer.id ||
        null,

      name:
        second.streamer.name ||
        second.streamer.fcNickname ||
        null,

      fcNickname:
        second.streamer.fcNickname ||
        null,

      fcOuid:
        second.streamer.fcOuid,

      score:
        secondScore
    },

    result:
      calculateResult(
        firstScore,
        secondScore
      )
  };
}

/* ============================================================
   TIMESTAMP
============================================================ */

function getTimestamp(
  value
) {
  if (!value) {
    return 0;
  }

  const timestamp =
    new Date(value).getTime();

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

/* ============================================================
   HANDLER
============================================================ */

export default async function handler(
  req,
  res
) {
  try {
    /*
     * API KEY
     */

    const apiKey =
      process.env.NEXON_API_KEY;

    if (!apiKey) {
      return sendJson(
        res,
        500,
        {
          success: false,
          error:
            "NEXON_API_KEY가 설정되어 있지 않습니다."
        }
      );
    }

    /*
     * STREAMERS
     */

    let streamers;

    try {
      streamers =
        loadStreamers();
    } catch (error) {
      return sendJson(
        res,
        500,
        {
          success: false,
          error:
            "streamers.json을 읽지 못했습니다.",
          detail:
            error?.message ||
            String(error)
        }
      );
    }

    /*
     * ACTIVE
     */

    const activeStreamers =
      streamers.filter(
        streamer =>
          streamer &&
          streamer.active !== false
      );

    if (
      activeStreamers.length < 2
    ) {
      return sendJson(
        res,
        200,
        {
          success: true,
          matchType:
            MATCH_TYPE,
          matchTypeName:
            "클래식 1on1",
          count: 0,
          matches: [],
          message:
            "등록된 활성 스트리머가 2명 미만입니다."
        }
      );
    }

    /*
     * OUID 확보
     */

    for (
      const streamer
      of activeStreamers
    ) {
      if (
        streamer.fcOuid
      ) {
        continue;
      }

      if (
        !streamer.fcNickname
      ) {
        continue;
      }

      try {
        console.log(
          `[CLASSIC 1ON1] OUID 조회: ${streamer.fcNickname}`
        );

        const ouid =
          await getOuidByNickname(
            streamer.fcNickname,
            apiKey
          );

        if (ouid) {
          streamer.fcOuid =
            ouid;

          console.log(
            `[CLASSIC 1ON1] OUID 성공: ${streamer.fcNickname}`
          );
        }
      } catch (error) {
        console.warn(
          `[CLASSIC 1ON1] OUID 조회 실패: ${streamer.fcNickname}`,
          error?.message
        );
      }

      await sleep(
        REQUEST_DELAY
      );
    }

    /*
     * MAP
     */

    const streamerMap =
      createStreamerMap(
        activeStreamers
      );

    const ouidStreamers =
      activeStreamers.filter(
        streamer =>
          streamer.fcOuid
      );

    if (
      ouidStreamers.length < 2
    ) {
      return sendJson(
        res,
        200,
        {
          success: true,
          matchType:
            MATCH_TYPE,
          matchTypeName:
            "클래식 1on1",
          count: 0,
          matches: [],
          message:
            "OUID가 확인된 스트리머가 2명 미만입니다."
        }
      );
    }

    /*
     * MATCH ID 수집
     */

    const matchIds =
      new Set();

    for (
      const streamer
      of ouidStreamers
    ) {
      try {
        console.log(
          `[CLASSIC 1ON1] ${streamer.name || streamer.fcNickname} 경기 조회 시작`
        );

        const ids =
          await getAllMatchIds(
            streamer.fcOuid,
            apiKey
          );

        console.log(
          `[CLASSIC 1ON1] ${streamer.name || streamer.fcNickname}: ${ids.length}개 확보`
        );

        for (
          const matchId
          of ids
        ) {
          matchIds.add(
            String(matchId)
          );
        }
      } catch (error) {
        console.warn(
          `[CLASSIC 1ON1] 경기 목록 오류: ${streamer.fcNickname}`,
          error?.message
        );
      }

      await sleep(
        REQUEST_DELAY
      );
    }

    console.log(
      `[CLASSIC 1ON1] 전체 중복 제거 후 경기 ID: ${matchIds.size}개`
    );

    /*
     * MATCH DETAIL
     */

    const matches = [];

    for (
      const matchId
      of matchIds
    ) {
      try {
        const detail =
          await getMatchDetail(
            matchId,
            apiKey
          );

        if (!detail) {
          continue;
        }

        const players =
          findStreamerPlayers(
            detail,
            streamerMap
          );

        /*
         * 등록 스트리머가 정확히 2명 참가
         */

        if (
          players.length !== 2
        ) {
          continue;
        }

        const match =
          buildMatchResult(
            matchId,
            detail,
            players
          );

        if (!match) {
          continue;
        }

        matches.push(
          match
        );

        console.log(
          `[CLASSIC 1ON1] 발견: ${match.player1.name} vs ${match.player2.name}`
        );
      } catch (error) {
        console.warn(
          `[CLASSIC 1ON1] 상세조회 실패: ${matchId}`,
          error?.message
        );
      }

      await sleep(
        REQUEST_DELAY
      );
    }

    /*
     * 중복 제거
     */

    const unique =
      new Map();

    for (
      const match
      of matches
    ) {
      unique.set(
        String(match.matchId),
        match
      );
    }

    /*
     * 최신순
     */

    const sorted =
      Array.from(
        unique.values()
      ).sort(
        (a, b) =>
          getTimestamp(
            b.matchDate
          ) -
          getTimestamp(
            a.matchDate
          )
      );

    /*
     * RESPONSE
     */

    return sendJson(
      res,
      200,
      {
        success: true,

        matchType:
          MATCH_TYPE,

        matchTypeName:
          "클래식 1on1",

        streamerCount:
          ouidStreamers.length,

        searchedMatchCount:
          matchIds.size,

        count:
          sorted.length,

        matches:
          sorted
      }
    );

  } catch (error) {
    console.error(
      "[CLASSIC 1ON1] 서버 오류:",
      error
    );

    return sendJson(
      res,
      500,
      {
        success: false,

        error:
          "클래식 1on1 경기 데이터를 불러오는 중 서버 오류가 발생했습니다.",

        detail:
          error?.message ||
          String(error)
      }
    );
  }
}
```
