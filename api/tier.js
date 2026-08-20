/*
 * api/tier.js
 *
 * FC온라인 최근 공식경기 티어 조회
 *
 * 조회 우선순위
 *
 * 1. streamers.json에 fcOuid가 있으면 사용
 * 2. fcOuid가 없으면 fcNickname으로 OUID 자동 조회
 * 3. OUID로 최근 공식경기 조회
 * 4. 최근 경기 상세에서 해당 유저의 divisionId 조회
 * 5. 성공하면 latest-match
 * 6. 실패하면 streamers.json의 divisionId fallback
 *
 * 중요
 * - /user/maxdivision 사용 안 함
 * - 역대 최고 티어 사용 안 함
 * - 최근 공식경기 당시 divisionId 사용
 *
 * 추가 개선
 * - 신규 스트리머 OUID 자동 조회
 * - 429 Rate Limit 재시도
 * - 429 발생 시 다음 스트리머 조회로 계속 진행
 * - 매치 상세의 여러 division 필드 대응
 * - division 메타데이터 캐시
 */

const fs = require("fs");
const path = require("path");

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

const OFFICIAL_MATCH_TYPE = 50;


/* ============================================================
   설정
============================================================ */

const MAX_RETRIES = 3;

/*
 * 429 발생 시
 *
 * 1차: 1.5초
 * 2차: 3초
 * 3차: 6초
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
   Division 메타
============================================================ */

let divisionMapCache = null;


async function getDivisionMap() {

  if (divisionMapCache) {

    return divisionMapCache;

  }


  try {

    const response =
      await fetch(
        DIVISION_META_URL,
        {
          cache: "no-store"
        }
      );


    if (!response.ok) {

      console.warn(
        "Division metadata HTTP:",
        response.status
      );

      return {};

    }


    const data =
      await response.json();


    const map = {};


    if (Array.isArray(data)) {

      for (const item of data) {

        if (
          item &&
          item.divisionId != null
        ) {

          map[
            String(item.divisionId)
          ] =
            item.divisionName || null;

        }

      }

    }


    divisionMapCache =
      map;


    return map;

  } catch (error) {

    console.warn(
      "division metadata 조회 실패:",
      error.message
    );

    return {};

  }

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
     429 Rate Limit
  ========================================================== */

  if (response.status === 429) {

    if (retryCount < MAX_RETRIES) {

      const delay =
        RETRY_BASE_DELAY *
        Math.pow(
          2,
          retryCount
        );


      console.warn(
        `[NEXON 429] ${endpoint} → ${delay}ms 후 재시도 (${retryCount + 1}/${MAX_RETRIES})`
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
   divisionId 정규화
============================================================ */

function normalizeDivisionId(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;

  }


  const number =
    Number(value);


  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {

    return null;

  }


  return number;

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


  const data =
    await nexonFetch(
      `/id?nickname=${encodeURIComponent(nickname)}`,
      apiKey
    );


  /*
   * 정상 응답
   *
   * {
   *   "ouid": "..."
   * }
   */


  if (
    data &&
    data.ouid
  ) {

    return data.ouid;

  }


  return null;

}


/* ============================================================
   최근 공식경기 ID
============================================================ */

async function getLatestMatchId(
  ouid,
  apiKey
) {

  const endpoint =
    `/user/match` +
    `?ouid=${encodeURIComponent(ouid)}` +
    `&matchtype=${OFFICIAL_MATCH_TYPE}` +
    `&offset=0` +
    `&limit=1`;


  const data =
    await nexonFetch(
      endpoint,
      apiKey
    );


  /*
   * 일반적인 응답
   *
   * [
   *   "matchId"
   * ]
   */


  if (
    Array.isArray(data) &&
    data.length > 0
  ) {

    /*
     * 혹시 객체 형태가 반환되는 경우도 대응
     */

    if (
      typeof data[0] === "object" &&
      data[0] !== null
    ) {

      return (
        data[0].matchId ||
        data[0].matchid ||
        null
      );

    }


    return data[0];

  }


  return null;

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
   해당 OUID의 경기 참가 정보 찾기
============================================================ */

function findUserMatchInfo(
  detail,
  ouid
) {

  if (
    !detail ||
    !Array.isArray(detail.matchInfo)
  ) {

    return null;

  }


  return (
    detail.matchInfo.find(
      player => {

        if (!player) {

          return false;

        }


        return (
          String(player.ouid) ===
          String(ouid)
        );

      }
    ) || null
  );

}


/* ============================================================
   최근 경기 divisionId
============================================================ */

function extractDivisionId(
  detail,
  ouid
) {

  const player =
    findUserMatchInfo(
      detail,
      ouid
    );


  if (!player) {

    return null;

  }


  /*
   * 2026년 매치 상세 API에서 추가된
   * 당시 등급 식별자 대응
   *
   * API 구조 변화에 대비하여
   * 여러 이름을 순서대로 확인
   */

  const candidates = [

    /* 현재/공식 필드 */

    player.division,

    player.divisionId,

    player.divisionID,

    player.division_id,

    /* 호환 필드 */

    player.matchDivision,

    player.matchDivisionId,

    player.matchDivisionID,

    player.match_division,

    player.match_division_id,

    player.rankDivision,

    player.rankDivisionId,

    player.rankDivisionID,

    player.rank_division,

    player.rank_division_id,

    /* 혹시 객체 형태인 경우 */

    player.division?.divisionId,

    player.division?.id,

    player.matchDivision?.divisionId,

    player.matchDivision?.id,

    player.rankDivision?.divisionId,

    player.rankDivision?.id

  ];


  for (
    const value of candidates
  ) {

    const divisionId =
      normalizeDivisionId(value);


    if (
      divisionId !== null
    ) {

      return divisionId;

    }

  }


  return null;

}


/* ============================================================
   최근 경기 티어 조회
============================================================ */

async function getLatestTier(
  ouid,
  apiKey
) {

  /*
   * 1. 최근 공식경기
   */

  const latestMatchId =
    await getLatestMatchId(
      ouid,
      apiKey
    );


  if (!latestMatchId) {

    return {

      success: false,

      latestMatchId: null,

      divisionId: null,

      reason:
        "최근 공식경기 ID가 없습니다."

    };

  }


  /*
   * 2. 경기 상세
   */

  const detail =
    await getMatchDetail(
      latestMatchId,
      apiKey
    );


  /*
   * 3. 해당 유저의 당시 divisionId
   */

  const divisionId =
    extractDivisionId(
      detail,
      ouid
    );


  if (
    divisionId === null
  ) {

    return {

      success: false,

      latestMatchId,

      divisionId: null,

      reason:
        "최근 경기 상세정보에서 divisionId를 찾지 못했습니다."

    };

  }


  return {

    success: true,

    latestMatchId,

    divisionId,

    reason: null

  };

}


/* ============================================================
   divisionName
============================================================ */

function getDivisionName(
  divisionId,
  divisionMap
) {

  if (
    divisionId === null ||
    divisionId === undefined
  ) {

    return null;

  }


  return (
    divisionMap[
      String(divisionId)
    ] ||
    `등급 ${divisionId}`
  );

}


/* ============================================================
   Handler
============================================================ */

export default async function handler(
  req,
  res
) {

  const apiKey =
    process.env.NEXON_API_KEY;


  if (!apiKey) {

    return res.status(500).json({

      error:
        "NEXON_API_KEY가 설정되어 있지 않습니다."

    });

  }


  /*
   * 예:
   *
   * /api/tier?nicknames=메시연
   *
   * /api/tier?nicknames=메시연,감차쯔키
   */


  const rawNicknames =
    req.query?.nicknames;


  const nicknames =
    String(
      rawNicknames || ""
    )
      .split(",")
      .map(
        nickname =>
          nickname.trim()
      )
      .filter(Boolean);


  if (
    nicknames.length === 0
  ) {

    return res.status(400).json({

      error:
        "nicknames가 필요합니다."

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

      error:
        "streamers.json을 읽지 못했습니다.",

      detail:
        error.message

    });

  }


  /* ==========================================================
     fcNickname → streamer
  ========================================================== */

  const streamerMap =
    new Map();


  for (
    const streamer of streamers
  ) {

    if (
      streamer?.fcNickname
    ) {

      const nickname =
        String(
          streamer.fcNickname
        ).trim();


      if (nickname) {

        streamerMap.set(
          nickname,
          streamer
        );

      }

    }

  }


  /* ==========================================================
     Division 메타
  ========================================================== */

  const divisionMap =
    await getDivisionMap();


  const results = {};


  /* ==========================================================
     스트리머 처리
  ========================================================== */

  for (
    const nickname of nicknames
  ) {

    const streamer =
      streamerMap.get(
        nickname
      );


    /* ========================================================
       streamers.json에 없는 경우
    ======================================================== */

    if (!streamer) {

      results[nickname] = {

        ouid: null,

        divisionId: null,

        divisionName: null,

        latestMatchId: null,

        source: null,

        error:
          "streamers.json에서 해당 fcNickname을 찾지 못했습니다."

      };


      continue;

    }


    /* ========================================================
       기존 OUID
    ======================================================== */

    let ouid =
      streamer.fcOuid ||
      null;


    /*
     * fallback
     *
     * 기존에 저장된 divisionId가 있으면
     * Nexon API 실패 시 사용할 수 있음
     */

    const fallbackDivisionId =
      normalizeDivisionId(
        streamer.divisionId
      );


    let latestMatchId =
      null;


    let divisionId =
      fallbackDivisionId;


    let source =
      fallbackDivisionId !== null
        ? "streamers.json"
        : null;


    let error =
      null;


    /* ========================================================
       신규 스트리머
       OUID 자동 조회
    ======================================================== */

    if (!ouid) {

      try {

        console.log(
          `[FC TIER] OUID 조회 시작: ${nickname}`
        );


        ouid =
          await getOuidByNickname(
            nickname,
            apiKey
          );


        if (ouid) {

          console.log(
            `[FC TIER] OUID 조회 성공: ${nickname} → ${ouid}`
          );

        } else {

          console.warn(
            `[FC TIER] OUID 조회 결과 없음: ${nickname}`
          );

        }

      } catch (errorObject) {

        error =
          errorObject?.message ||
          String(errorObject);


        console.warn(
          `[FC TIER] ${nickname} OUID 조회 실패:`,
          error
        );

      }

    }


    /* ========================================================
       OUID 없음
    ======================================================== */

    if (!ouid) {

      results[nickname] = {

        ouid: null,

        divisionId,

        divisionName:
          getDivisionName(
            divisionId,
            divisionMap
          ),

        latestMatchId: null,

        source,

        error:
          error ||
          (
            fallbackDivisionId !== null
              ? "OUID를 찾지 못해 streamers.json의 divisionId를 사용했습니다."
              : "fcOuid가 없고 OUID 자동 조회에도 실패했습니다."
          )

      };


      /*
       * 다음 스트리머 계속 처리
       */

      continue;

    }


    /* ========================================================
       최근 공식경기 조회
    ======================================================== */

    try {

      console.log(
        `[FC TIER] 최근 공식경기 조회: ${nickname}`
      );


      const latest =
        await getLatestTier(
          ouid,
          apiKey
        );


      latestMatchId =
        latest.latestMatchId;


      /* ======================================================
         최근 경기 divisionId 성공
      ====================================================== */

      if (
        latest.success &&
        latest.divisionId !== null
      ) {

        divisionId =
          latest.divisionId;


        source =
          "latest-match";


        error =
          null;


        console.log(
          `[FC TIER] 성공: ${nickname} → ${divisionId}`
        );

      } else {

        /*
         * 최근 경기 조회 실패
         *
         * 기존 streamers.json divisionId 유지
         */

        error =
          latest.reason ||
          "최근 경기 티어 조회 실패";


        console.warn(
          `[FC TIER] ${nickname}: ${error}`
        );

      }

    } catch (errorObject) {

      error =
        errorObject?.message ||
        String(errorObject);


      console.warn(
        `[FC TIER] ${nickname} 최근 경기 조회 실패:`,
        error
      );

    }


    /* ========================================================
       최종 divisionName
    ======================================================== */

    const divisionName =
      getDivisionName(
        divisionId,
        divisionMap
      );


    /* ========================================================
       최종 결과
    ======================================================== */

    results[nickname] = {

      ouid,

      divisionId,

      divisionName,

      latestMatchId,

      source,

      error

    };

  }


  /* ==========================================================
     캐시 금지
  ========================================================== */

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  /* ==========================================================
     응답
  ========================================================== */

  return res.status(200).json(
    results
  );

}
