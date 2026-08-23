/*
 * api/streamer-matches.js
 *
 * 등록된 스트리머끼리 진행한 FC온라인 클래식 1on1 경기 조회
 *
 * 동작
 * 1. data/streamers.json 로드
 * 2. 등록된 스트리머의 fcOuid 사용
 * 3. fcOuid가 없으면 fcNickname으로 OUID 자동 조회
 * 4. 각 스트리머의 최근 클래식 1on1 경기 ID 조회
 * 5. match-detail 조회
 * 6. matchInfo 안에 등록 스트리머 2명이 모두 있는 경기만 추출
 * 7. matchId 기준 중복 제거
 * 8. 최신 경기부터 정렬
 *
 * Nexon FC온라인 Match Type
 *
 * 40 = 클래식 1on1
 *
 * 주의
 * - 공식경기 1on1 = 50
 * - 클래식 1on1 = 40
 * - 이 API에서는 클래식 1on1만 조회
 */

/* ============================================================
   Node
============================================================ */

const fs = require("fs");
const path = require("path");


/* ============================================================
   설정
============================================================ */

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";


/*
 * FC온라인 클래식 1on1
 *
 * Nexon matchtype:
 * 40 = 클래식 1on1
 */
const FRIENDLY_MATCH_TYPE = 40;


/*
 * 스트리머 한 명당 가져올 최근 경기 수
 */
const MATCH_LIMIT = 30;


/*
 * Nexon API 호출 간격
 *
 * 너무 빠르게 호출하면 429가 발생할 수 있으므로
 * 각 요청 사이에 잠시 대기
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

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );

}


/* ============================================================
   JSON 응답
============================================================ */

function sendJson(
  res,
  status,
  data
) {

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  return res
    .status(status)
    .json(data);

}


/* ============================================================
   streamers.json
============================================================ */

function loadStreamers() {

  const filePath =
    path.join(
      process.cwd(),
      "data",
      "streamers.json"
    );


  const text =
    fs.readFileSync(
      filePath,
      "utf8"
    );


  const data =
    JSON.parse(text);


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

  const response =
    await fetch(
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


  const text =
    await response.text();


  /* ==========================================================
     429
  ========================================================== */

  if (response.status === 429) {

    if (
      retryCount < MAX_RETRIES
    ) {

      const delay =
        RETRY_BASE_DELAY *
        Math.pow(
          2,
          retryCount
        );


      console.warn(
        `[CLASSIC 1ON1 429] ${endpoint} → ${delay}ms 후 재시도`
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
     기타 HTTP 오류
  ========================================================== */

  if (!response.ok) {

    throw new Error(
      `Nexon API ${response.status}: ${text || "Unknown error"}`
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


  const endpoint =
    `/id?nickname=${encodeURIComponent(nickname)}`;


  const data =
    await nexonFetch(
      endpoint,
      apiKey
    );


  if (
    data &&
    data.ouid
  ) {

    return String(
      data.ouid
    );

  }


  return null;

}


/* ============================================================
   최근 클래식 1on1 경기 ID
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


  console.log(
    `[CLASSIC 1ON1] match 목록 요청: ${endpoint}`
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
    .map(
      item => {

        /*
         * 일반적으로 matchId 문자열 배열
         */

        if (
          typeof item === "string"
        ) {

          return item;

        }


        /*
         * 혹시 객체 형태로 반환될 경우 대응
         */

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

      }
    )
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

  const map =
    new Map();


  for (
    const streamer
    of streamers
  ) {

    if (
      !streamer ||
      streamer.active === false
    ) {

      continue;

    }


    if (
      !streamer.fcOuid
    ) {

      continue;

    }


    map.set(
      String(
        streamer.fcOuid
      ),
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
   등록 스트리머 참가자 찾기
============================================================ */

function findStreamerPlayers(
  detail,
  streamerMap
) {

  const players =
    getMatchPlayers(
      detail
    );


  const found =
    [];


  for (
    const player
    of players
  ) {

    if (
      !player ||
      !player.ouid
    ) {

      continue;

    }


    const streamer =
      streamerMap.get(
        String(
          player.ouid
        )
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
   * 같은 OUID가 비정상적으로 중복되는 경우 제거
   */

  const unique =
    new Map();


  for (
    const item
    of found
  ) {

    unique.set(
      String(
        item.streamer.fcOuid
      ),
      item
    );

  }


  return Array.from(
    unique.values()
  );

}


/* ============================================================
   날짜 추출
============================================================ */

function extractDate(
  detail
) {

  if (!detail) {

    return null;

  }


  return (
    detail.matchDate ||
    detail.matchdate ||
    detail.matchTime ||
    detail.matchtime ||
    detail.date ||
    null
  );

}


/* ============================================================
   선수 닉네임 추출
============================================================ */

function extractPlayerNickname(
  player
) {

  if (!player) {

    return null;

  }


  return (
    player.nickname ||
    player.nickName ||
    player.name ||
    null
  );

}


/* ============================================================
   점수 추출
============================================================ */

function extractScore(
  player
) {

  if (!player) {

    return null;

  }


  /*
   * Nexon API 응답 구조가 버전에 따라 다를 수 있으므로
   * 대표적인 필드만 확인합니다.
   */

  const candidates = [

    player.shoot,

    player.goal,

    player.score,

    player.scores,

    player.matchScore,

    player.matchscore

  ];


  for (
    const value
    of candidates
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
   결과 계산
============================================================ */

function calculateResult(
  firstScore,
  secondScore
) {

  /*
   * 점수 데이터가 없는 경우
   * 억지로 승/패를 만들지 않음
   */

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
   경기 결과 생성
============================================================ */

function buildMatchResult(
  matchId,
  detail,
  streamerPlayers
) {

  /*
   * 등록 스트리머가 정확히 2명이어야 함
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


  const firstPlayer =
    first.player;


  const secondPlayer =
    second.player;


  const firstScore =
    extractScore(
      firstPlayer
    );


  const secondScore =
    extractScore(
      secondPlayer
    );


  const result =
    calculateResult(
      firstScore,
      secondScore
    );


  return {

    matchId,

    matchType:
      FRIENDLY_MATCH_TYPE,

    matchTypeName:
      "클래식 1on1",

    matchDate:
      extractDate(
        detail
      ),

    player1: {

      id:
        first.streamer.id ||
        null,

      name:
        first.streamer.name ||
        first.streamer.fcNickname ||
        extractPlayerNickname(
          firstPlayer
        ),

      fcNickname:
        first.streamer.fcNickname ||
        extractPlayerNickname(
          firstPlayer
        ),

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
        extractPlayerNickname(
          secondPlayer
        ),

      fcNickname:
        second.streamer.fcNickname ||
        extractPlayerNickname(
          secondPlayer
        ),

      fcOuid:
        second.streamer.fcOuid,

      score:
        secondScore

    },

    result

  };

}


/* ============================================================
   날짜 → Timestamp
============================================================ */

function getTimestamp(
  value
) {

  if (!value) {

    return 0;

  }


  const timestamp =
    new Date(
      value
    ).getTime();


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

  /*
   * 항상 JSON 응답
   */

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  try {

    /* ========================================================
       API KEY
    ======================================================== */

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


    /* ========================================================
       streamers.json
    ======================================================== */

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


    /* ========================================================
       활성 스트리머
    ======================================================== */

    const activeStreamers =
      streamers.filter(
        streamer =>
          streamer &&
          streamer.active !== false
      );


    if (
      activeStreamers.length === 0
    ) {

      return sendJson(
        res,
        200,
        {

          success: true,

          matchType:
            FRIENDLY_MATCH_TYPE,

          matchTypeName:
            "클래식 1on1",

          count: 0,

          matches: []

        }
      );

    }


    /* ========================================================
       OUID 자동 조회
    ======================================================== */

    for (
      const streamer
      of activeStreamers
    ) {

      /*
       * 이미 OUID가 있으면 사용
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
            `[CLASSIC 1ON1] OUID 성공: ${streamer.fcNickname} → ${ouid}`
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


    /* ========================================================
       OUID Map
    ======================================================== */

    const streamerMap =
      createStreamerMap(
        activeStreamers
      );


    /* ========================================================
       OUID가 있는 스트리머
    ======================================================== */

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
            FRIENDLY_MATCH_TYPE,

          matchTypeName:
            "클래식 1on1",

          count: 0,

          matches: [],

          message:
            "클래식 1on1 경기를 확인할 수 있는 스트리머가 2명 미만입니다."

        }
      );

    }


    /* ========================================================
       모든 스트리머의 경기 ID 수집
    ======================================================== */

    const matchOwnerMap =
      new Map();


    for (
      const streamer
      of ouidStreamers
    ) {

      try {

        console.log(
          `[CLASSIC 1ON1] 경기 목록 조회: ${streamer.name || streamer.fcNickname}`
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


        console.log(
          `[CLASSIC 1ON1] ${streamer.fcNickname}: ${matchIds.length}개`
        );

      } catch (error) {

        console.warn(
          `[CLASSIC 1ON1] 경기 목록 조회 실패: ${streamer.fcNickname}`,
          error?.message
        );

      }


      await sleep(
        REQUEST_DELAY
      );

    }


    /* ========================================================
       경기 상세 조회
    ======================================================== */

    const matches =
      [];


    const processed =
      new Set();


    for (
      const matchId
      of matchOwnerMap.keys()
    ) {

      if (
        processed.has(
          matchId
        )
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
         * 이 경기의 matchInfo에서
         * 등록된 스트리머를 찾음
         */

        const streamerPlayers =
          findStreamerPlayers(
            detail,
            streamerMap
          );


        /*
         * 등록 스트리머가 정확히 2명인 경기만
         * 스트리머끼리의 경기로 인정
         */

        if (
          streamerPlayers.length !== 2
        ) {

          continue;

        }


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


        console.log(
          `[CLASSIC 1ON1] 스트리머 경기 발견: ${match.player1.name} vs ${match.player2.name}`
        );

      } catch (error) {

        console.warn(
          `[CLASSIC 1ON1] match-detail 실패: ${matchId}`,
          error?.message
        );

      }


      await sleep(
        REQUEST_DELAY
      );

    }


    /* ========================================================
       matchId 중복 제거
    ======================================================== */

    const uniqueMatches =
      new Map();


    for (
      const match
      of matches
    ) {

      uniqueMatches.set(
        String(
          match.matchId
        ),
        match
      );

    }


    /* ========================================================
       최신 경기순 정렬
    ======================================================== */

    const sortedMatches =
      Array.from(
        uniqueMatches.values()
      )
        .sort(
          (
            a,
            b
          ) =>
            getTimestamp(
              b.matchDate
            ) -
            getTimestamp(
              a.matchDate
            )
        );


    /* ========================================================
       최종 응답
    ======================================================== */

    return sendJson(
      res,
      200,
      {

        success: true,

        matchType:
          FRIENDLY_MATCH_TYPE,

        matchTypeName:
          "클래식 1on1",

        count:
          sortedMatches.length,

        matches:
          sortedMatches

      }
    );

  } catch (error) {

    /*
     * Vercel에서 HTML 에러 페이지가 반환되는 것을 방지
     *
     * 프론트에서 JSON.parse 오류가 발생하지 않도록
     * 모든 서버 오류를 JSON으로 반환
     */

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
