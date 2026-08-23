/*
 * api/streamer-matches.js
 *
 * 등록된 스트리머끼리 진행한 1:1 친선경기 조회
 *
 * 동작
 * 1. data/streamers.json 로드
 * 2. 등록된 스트리머들의 fcOuid 사용
 * 3. fcOuid가 없으면 fcNickname으로 OUID 자동 조회
 * 4. 친선경기(matchtype=30) matchId 조회
 * 5. match-detail 조회
 * 6. matchInfo 안에 등록 스트리머 2명이 모두 있는 경기만 추출
 * 7. matchId 기준 중복 제거
 * 8. 최신 경기부터 정렬
 *
 * 중요
 * - 공식경기 1:1 = 50
 * - 친선경기 = 30
 * - 이 API에서는 골 수 / 승패를 계산하지 않음
 * - 핵심은 "등록 스트리머 2명이 같은 경기에서 만났는가" 확인
 */

const fs = require("fs");
const path = require("path");

/* ============================================================
   설정
============================================================ */

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

/*
 * FC온라인 리그 친선
 */
const FRIENDLY_MATCH_TYPE = 30;

/*
 * 스트리머 1명당 가져올 최근 친선경기 수
 *
 * 등록 스트리머가 많아질수록 API 호출량이 증가하므로
 * 30경기 정도로 제한
 */
const MATCH_LIMIT = 30;

/*
 * API 호출 간격
 *
 * 429 방지
 */
const REQUEST_DELAY = 250;

/*
 * 429 재시도 횟수
 */
const MAX_RETRIES = 3;

/*
 * 429 재시도 기본 대기시간
 */
const RETRY_BASE_DELAY = 1500;


/* ============================================================
   sleep
============================================================ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ============================================================
   streamers.json
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
   Nexon API
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


  /* ==========================================================
     429 Rate Limit
  ========================================================== */

  if (response.status === 429) {
    if (retryCount < MAX_RETRIES) {
      const delay =
        RETRY_BASE_DELAY *
        Math.pow(2, retryCount);

      console.warn(
        `[FRIENDLY 429] ${endpoint} → ${delay}ms 후 재시도`
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


  /* ==========================================================
     기타 오류
  ========================================================== */

  if (!response.ok) {
    throw new Error(
      `Nexon API ${response.status}: ${text}`
    );
  }


  /* ==========================================================
     빈 응답
  ========================================================== */

  if (!text) {
    return null;
  }


  /* ==========================================================
     JSON
  ========================================================== */

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Nexon API JSON 파싱 실패"
    );
  }
}


/* ============================================================
   닉네임 → OUID
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
    return data.ouid;
  }

  return null;
}


/* ============================================================
   최근 친선경기 ID
============================================================ */

async function getMatchIds(
  ouid,
  apiKey
) {
  if (!ouid) {
    return [];
  }

  const endpoint =
    `/user/match` +
    `?ouid=${encodeURIComponent(ouid)}` +
    `&matchtype=${FRIENDLY_MATCH_TYPE}` +
    `&offset=0` +
    `&limit=${MATCH_LIMIT}`;

  const data = await nexonFetch(
    endpoint,
    apiKey
  );

  if (!Array.isArray(data)) {
    return [];
  }

  /*
   * Nexon API의 MatchIdList는
   *
   * [
   *   {
   *     "matchId": "..."
   *   }
   * ]
   *
   * 형태를 기본으로 사용
   *
   * 혹시 문자열 형태가 들어오는 경우도 방어
   */

  return data
    .map(item => {
      if (typeof item === "string") {
        return item;
      }

      if (
        item &&
        typeof item === "object"
      ) {
        return (
          item.matchId ||
          item.matchid ||
          null
        );
      }

      return null;
    })
    .filter(Boolean);
}


/* ============================================================
   경기 상세
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
   등록 스트리머 Map
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
   matchInfo 추출
============================================================ */

function getMatchPlayers(
  detail
) {
  if (
    !detail ||
    !Array.isArray(detail.matchInfo)
  ) {
    return [];
  }

  return detail.matchInfo;
}


/* ============================================================
   등록 스트리머 찾기
============================================================ */

function findStreamerPlayers(
  detail,
  streamerMap
) {
  const players =
    getMatchPlayers(detail);

  const found = [];

  for (
    const player of players
  ) {
    if (
      !player ||
      !player.ouid
    ) {
      continue;
    }

    const streamer =
      streamerMap.get(
        String(player.ouid)
      );

    if (!streamer) {
      continue;
    }

    found.push({
      streamer,
      player
    });
  }


  /*
   * 같은 OUID가 중복으로 들어오는
   * 비정상 데이터 방지
   */

  const unique =
    new Map();

  for (
    const item of found
  ) {
    unique.set(
      String(item.streamer.fcOuid),
      item
    );
  }

  return Array.from(
    unique.values()
  );
}


/* ============================================================
   경기 날짜 추출
============================================================ */

function extractMatchDate(
  detail
) {
  if (!detail) {
    return null;
  }

  /*
   * Nexon match-detail의 공식 필드
   */
  return (
    detail.matchDate ||
    detail.matchdate ||
    null
  );
}


/* ============================================================
   경기 결과 생성
============================================================ */

function buildMatchResult(
  matchId,
  detail,
  streamerPlayers
) {
  /*
   * 등록 스트리머가 정확히 2명인 경우만
   * 스트리머끼리의 친선경기로 인정
   */

  if (
    streamerPlayers.length !== 2
  ) {
    return null;
  }

  const first =
    streamerPlayers[0];

  const second =
    streamerPlayers[1];

  return {
    matchId,

    matchType:
      FRIENDLY_MATCH_TYPE,

    matchDate:
      extractMatchDate(detail),

    player1: {
      id:
        first.streamer.id ||
        null,

      name:
        first.streamer.name ||
        first.streamer.fcNickname ||
        first.player.nickname ||
        null,

      fcNickname:
        first.streamer.fcNickname ||
        first.player.nickname ||
        null,

      fcOuid:
        first.streamer.fcOuid ||
        first.player.ouid ||
        null
    },

    player2: {
      id:
        second.streamer.id ||
        null,

      name:
        second.streamer.name ||
        second.streamer.fcNickname ||
        second.player.nickname ||
        null,

      fcNickname:
        second.streamer.fcNickname ||
        second.player.nickname ||
        null,

      fcOuid:
        second.streamer.fcOuid ||
        second.player.ouid ||
        null
    }
  };
}


/* ============================================================
   날짜 → timestamp
============================================================ */

function getTimestamp(
  value
) {
  if (!value) {
    return 0;
  }

  const timestamp =
    new Date(value).getTime();

  if (
    Number.isFinite(timestamp)
  ) {
    return timestamp;
  }

  return 0;
}


/* ============================================================
   Handler
============================================================ */

export default async function handler(
  req,
  res
) {

  /* ==========================================================
     API KEY
  ========================================================== */

  const apiKey =
    process.env.NEXON_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,

      error:
        "NEXON_API_KEY가 설정되어 있지 않습니다."
    });
  }


  /* ==========================================================
     streamers.json
  ========================================================== */

  let streamers;

  try {
    streamers =
      loadStreamers();
  } catch (error) {
    return res.status(500).json({
      success: false,

      error:
        "streamers.json을 읽지 못했습니다.",

      detail:
        error.message
    });
  }


  /* ==========================================================
     활성 스트리머
  ========================================================== */

  const activeStreamers =
    streamers.filter(
      streamer =>
        streamer &&
        streamer.active !== false
    );


  /* ==========================================================
     등록 스트리머 없음
  ========================================================== */

  if (
    activeStreamers.length === 0
  ) {
    return res.status(200).json({
      success: true,

      matchType:
        FRIENDLY_MATCH_TYPE,

      count: 0,

      matches: []
    });
  }


  /* ==========================================================
     OUID 없는 스트리머 자동 조회
  ========================================================== */

  for (
    const streamer
    of activeStreamers
  ) {

    /*
     * 이미 OUID가 있으면
     * API를 다시 조회하지 않음
     */

    if (
      streamer.fcOuid
    ) {
      continue;
    }

    /*
     * FC 닉네임이 없으면 조회 불가
     */

    if (
      !streamer.fcNickname
    ) {
      continue;
    }

    try {
      console.log(
        `[FRIENDLY] OUID 조회: ${streamer.fcNickname}`
      );

      const ouid =
        await getOuidByNickname(
          streamer.fcNickname,
          apiKey
        );

      if (ouid) {
        /*
         * 이번 요청에서만 사용
         *
         * streamers.json 자체를 수정하지 않음
         */

        streamer.fcOuid =
          ouid;

        console.log(
          `[FRIENDLY] OUID 성공: ${streamer.fcNickname} → ${ouid}`
        );
      }

    } catch (error) {
      console.warn(
        `[FRIENDLY] OUID 조회 실패: ${streamer.fcNickname}`,
        error?.message
      );
    }

    await sleep(
      REQUEST_DELAY
    );
  }


  /* ==========================================================
     OUID Map
  ========================================================== */

  const streamerMap =
    createStreamerMap(
      activeStreamers
    );


  /* ==========================================================
     OUID 없는 스트리머 제외
  ========================================================== */

  const ouidStreamers =
    activeStreamers.filter(
      streamer =>
        !!streamer.fcOuid
    );


  /* ==========================================================
     최소 2명 확인
  ========================================================== */

  if (
    ouidStreamers.length < 2
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );

    return res.status(200).json({
      success: true,

      matchType:
        FRIENDLY_MATCH_TYPE,

      count: 0,

      matches: [],

      message:
        "친선경기를 확인할 수 있는 스트리머가 2명 미만입니다."
    });
  }


  /* ==========================================================
     모든 matchId 수집
  ========================================================== */

  const matchOwnerMap =
    new Map();

  for (
    const streamer
    of ouidStreamers
  ) {

    try {
      console.log(
        `[FRIENDLY] 경기 목록 조회: ${streamer.name || streamer.fcNickname}`
      );

      const matchIds =
        await getMatchIds(
          streamer.fcOuid,
          apiKey
        );

      for (
        const matchId
        of matchIds
      ) {

        /*
         * 같은 matchId는
         * 여러 스트리머의 최근 경기 목록에
         * 동시에 존재할 수 있으므로
         * 여기서부터 중복 제거
         */

        if (
          !matchOwnerMap.has(
            matchId
          )
        ) {
          matchOwnerMap.set(
            matchId,
            streamer.fcOuid
          );
        }
      }

    } catch (error) {
      console.warn(
        `[FRIENDLY] 경기 목록 조회 실패: ${streamer.fcNickname}`,
        error?.message
      );
    }

    await sleep(
      REQUEST_DELAY
    );
  }


  /* ==========================================================
     match-detail 조회
  ========================================================== */

  const matches = [];

  const processed =
    new Set();

  for (
    const matchId
    of matchOwnerMap.keys()
  ) {

    /*
     * 이중 안전장치
     */

    if (
      processed.has(matchId)
    ) {
      continue;
    }

    processed.add(
      matchId
    );

    try {

      const detail =
        await getMatchDetail(
          matchId,
          apiKey
        );

      if (!detail) {
        continue;
      }


      /*
       * 실제 match-detail의 matchType이
       * 30인지 한 번 더 확인
       *
       * 다른 종류의 경기가 섞이는 것을 방지
       */

      if (
        detail.matchType != null &&
        Number(detail.matchType) !==
          FRIENDLY_MATCH_TYPE
      ) {
        continue;
      }


      /*
       * matchInfo 안에서
       * 등록 스트리머 찾기
       */

      const streamerPlayers =
        findStreamerPlayers(
          detail,
          streamerMap
        );


      /*
       * 등록 스트리머가 정확히 2명인 경우만
       * 스트리머끼리의 경기로 인정
       */

      if (
        streamerPlayers.length !== 2
      ) {
        continue;
      }


      /*
       * 최종 경기 데이터 생성
       *
       * 골 수 / 승패는 저장하지 않음
       */

      const match =
        buildMatchResult(
          matchId,
          detail,
          streamerPlayers
        );

      if (!match) {
        continue;
      }

      matches.push(
        match
      );

    } catch (error) {
      console.warn(
        `[FRIENDLY] match-detail 실패: ${matchId}`,
        error?.message
      );
    }

    await sleep(
      REQUEST_DELAY
    );
  }


  /* ==========================================================
     matchId 기준 최종 중복 제거
  ========================================================== */

  const uniqueMatches =
    new Map();

  for (
    const match
    of matches
  ) {
    uniqueMatches.set(
      match.matchId,
      match
    );
  }


  /* ==========================================================
     최신 경기순 정렬
  ========================================================== */

  const sortedMatches =
    Array.from(
      uniqueMatches.values()
    )
      .sort(
        (a, b) =>
          getTimestamp(
            b.matchDate
          ) -
          getTimestamp(
            a.matchDate
          )
      );


  /* ==========================================================
     캐시 금지
  ========================================================== */

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  /* ==========================================================
     최종 응답
  ========================================================== */

  return res.status(200).json({
    success: true,

    matchType:
      FRIENDLY_MATCH_TYPE,

    count:
      sortedMatches.length,

    matches:
      sortedMatches
  });
}
