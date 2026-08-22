/*
 * api/tier.js
 *
 * FC온라인 최근 공식경기 티어 조회
 *
 * 동작 방식
 *
 * 1. streamers.json에 fcOuid가 있으면 사용
 * 2. fcOuid가 없으면 fcNickname으로 OUID 자동 조회
 * 3. OUID로 최근 공식경기 1건 조회
 * 4. 해당 경기의 match-detail 조회
 * 5. 해당 유저의 당시 divisionId 추출
 * 6. division.json으로 divisionId → 실제 티어명 변환
 *
 * 중요
 * - /user/maxdivision 사용 안 함
 * - 역대 최고 티어 사용 안 함
 * - streamers.json의 divisionId를 현재 티어로 사용하지 않음
 * - 최근 공식경기에서 확인된 divisionId만 사용
 * - 최근 경기 조회 실패 시 divisionId는 null
 * - 실패한 경우 기존 divisionId를 현재 티어처럼 표시하지 않음
 *
 * 추가
 * - 신규 스트리머 OUID 자동 조회
 * - 429 Rate Limit 재시도
 * - 429 발생 시 해당 스트리머만 실패 처리하고 다음 스트리머 계속
 * - 매치 상세의 여러 division 필드 대응
 * - division 메타데이터 캐시
 */

const fs = require("fs");
const path = require("path");


/* ============================================================
   설정
============================================================ */

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

const OFFICIAL_MATCH_TYPE = 50;

const MAX_RETRIES = 3;

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

  /*
   * 객체 형태로 들어오는 경우
   */

  if (
    typeof value === "object"
  ) {

    value =
      value.divisionId ??
      value.divisionID ??
      value.id ??
      null;

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
   Division 메타데이터
============================================================ */

let divisionMapCache = null;

async function getDivisionMap() {

  /*
   * 이미 가져온 경우 캐시 사용
   */

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
        "[DIVISION] 메타데이터 HTTP:",
        response.status
      );

      return {};

    }

    const data =
      await response.json();

    const map = {};


    /* ========================================================
       배열 형태
    ======================================================== */

    if (Array.isArray(data)) {

      for (const item of data) {

        if (!item) {
          continue;
        }

        const divisionId =
          normalizeDivisionId(
            item.divisionId ??
            item.divisionID ??
            item.id
          );

        const divisionName =
          item.divisionName ??
          item.name ??
          item.division_name ??
          null;

        if (
          divisionId !== null &&
          divisionName
        ) {

          map[String(divisionId)] =
            String(divisionName);

        }

      }

    }


    /* ========================================================
       객체 형태
    ======================================================== */

    else if (
      data &&
      typeof data === "object"
    ) {

      for (
        const [key, value]
        of Object.entries(data)
      ) {

        const divisionId =
          normalizeDivisionId(
            value?.divisionId ??
            value?.divisionID ??
            value?.id ??
            key
          );

        const divisionName =
          value?.divisionName ??
          value?.name ??
          value?.division_name ??
          (
            typeof value === "string"
              ? value
              : null
          );

        if (
          divisionId !== null &&
          divisionName
        ) {

          map[String(divisionId)] =
            String(divisionName);

        }

      }

    }


    /*
     * 캐시에 저장
     */

    divisionMapCache =
      map;

    console.log(
      `[DIVISION] 메타데이터 ${Object.keys(map).length}개 로드`
    );

    return map;

  } catch (error) {

    console.warn(
      "[DIVISION] 메타데이터 조회 실패:",
      error?.message || error
    );

    return {};

  }

}


/* ============================================================
   Nexon API 호출
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

  if (
    response.status === 429
  ) {

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
     * 혹시 객체 형태인 경우
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
   최근 경기의 divisionId 추출
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
   * 현재 매치 상세 API의 당시 등급 식별자 대응
   *
   * 여러 API 구조에 대응
   */

  const candidates = [

    /* 공식 / 기본 */

    player.division,

    player.divisionId,

    player.divisionID,

    player.division_id,


    /* 호환 */

    player.matchDivision,

    player.matchDivisionId,

    player.matchDivisionID,

    player.match_division,

    player.match_division_id,


    player.rankDivision,

    player.rankDivisionId,

    player.rankDivisionID,

    player.rank_division,

    player.rank_division_id

  ];


  for (
    const value
    of candidates
  ) {

    /*
     * 객체 형태
     */

    if (
      value &&
      typeof value === "object"
    ) {

      const nestedId =
        normalizeDivisionId(
          value.divisionId ??
          value.divisionID ??
          value.id
        );

      if (
        nestedId !== null
      ) {

        return nestedId;

      }

    }


    /*
     * 숫자 / 문자열
     */

    const divisionId =
      normalizeDivisionId(
        value
      );

    if (
      divisionId !== null
    ) {

      return divisionId;

    }

  }

  return null;

}


/* ============================================================
   최근 공식경기 티어 조회
============================================================ */

async function getLatestTier(
  ouid,
  apiKey
) {

  /*
   * 1. 최근 공식경기 ID
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


  if (!detail) {

    return {

      success: false,

      latestMatchId,

      divisionId: null,

      reason:
        "최근 경기 상세정보가 없습니다."

    };

  }


  /*
   * 3. 해당 유저의 당시 divisionId
   */

  const player =
    findUserMatchInfo(
      detail,
      ouid
    );


  if (!player) {

    return {

      success: false,

      latestMatchId,

      divisionId: null,

      reason:
        "최근 경기 상세정보에서 해당 유저를 찾지 못했습니다."

    };

  }


  /*
   * 디버깅용 로그
   */

  console.log(
    `[FC TIER] ${ouid} 최근 경기 player 정보:`,
    JSON.stringify(
      player,
      null,
      2
    )
  );


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
        "최근 경기 상세정보에서 당시 divisionId를 찾지 못했습니다."

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
   divisionId → divisionName
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

  const normalizedId =
    normalizeDivisionId(
      divisionId
    );


  if (
    normalizedId === null
  ) {

    return null;

  }


  /*
   * division.json에서 실제 이름을 찾음
   */

  return (
    divisionMap[
      String(normalizedId)
    ] ||
    null
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
    const streamer
    of streamers
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
     Division 메타데이터
  ========================================================== */

  const divisionMap =
    await getDivisionMap();


  console.log(
    "[DIVISION] 현재 division map:",
    divisionMap
  );


  const results = {};


  /* ==========================================================
     스트리머 처리
  ========================================================== */

  for (
    const nickname
    of nicknames
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
       OUID
    ======================================================== */

    let ouid =
      streamer.fcOuid ||
      null;


    let latestMatchId =
      null;


    /*
     * 중요
     *
     * streamers.json의 divisionId는
     * 절대로 현재 티어 fallback으로 사용하지 않음.
     *
     * 따라서 시작값은 무조건 null.
     */

    let divisionId =
      null;


    let divisionName =
      null;


    let source =
      null;


    let error =
      null;


    /* ========================================================
       OUID가 없는 경우
       fcNickname → OUID 자동 조회
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

        divisionId: null,

        divisionName: null,

        latestMatchId: null,

        source: null,

        error:
          error ||
          "fcOuid가 없고 OUID 자동 조회에도 실패했습니다."

      };


      /*
       * 다음 스트리머 계속
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


        divisionName =
          getDivisionName(
            divisionId,
            divisionMap
          );


        /*
         * division.json에 이름이 없는 경우
         *
         * 숫자를 티어 이름처럼 표시하지 않음.
         */

        if (!divisionName) {

          error =
            `divisionId ${divisionId}의 이름을 division 메타데이터에서 찾지 못했습니다.`;

          console.warn(
            `[FC TIER] ${nickname}: ${error}`
          );

        } else {

          error = null;

          console.log(
            `[FC TIER] 성공: ${nickname} → ${divisionId} → ${divisionName}`
          );

        }

      } else {

        /*
         * 중요
         *
         * 최근 경기 조회 실패 시
         * streamers.json의 divisionId를 사용하지 않음.
         */

        divisionId =
          null;


        divisionName =
          null;


        source =
          null;


        error =
          latest.reason ||
          "최근 공식경기 티어 조회 실패";


        console.warn(
          `[FC TIER] ${nickname}: ${error}`
        );

      }

    } catch (errorObject) {

      /*
       * API 오류가 발생해도
       * 기존 streamers.json divisionId를 사용하지 않음.
       */

      divisionId =
        null;


      divisionName =
        null;


      source =
        null;


      error =
        errorObject?.message ||
        String(errorObject);


      console.warn(
        `[FC TIER] ${nickname} 최근 경기 조회 실패:`,
        error
      );

    }


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
