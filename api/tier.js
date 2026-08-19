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
 * 중요:
 * /user/maxdivision 사용 안 함
 * → 역대 최고 티어를 사용하지 않음
 */

const fs = require("fs");
const path = require("path");

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

const OFFICIAL_MATCH_TYPE = 50;


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
   Division 메타
============================================================ */

let divisionMapCache = null;

async function getDivisionMap() {

  if (divisionMapCache) {
    return divisionMapCache;
  }

  try {

    const response = await fetch(
      DIVISION_META_URL,
      {
        cache: "no-store"
      }
    );

    if (!response.ok) {
      return {};
    }

    const data = await response.json();

    const map = {};

    if (Array.isArray(data)) {

      for (const item of data) {

        if (
          item &&
          item.divisionId != null
        ) {

          map[String(item.divisionId)] =
            item.divisionName || null;

        }

      }

    }

    divisionMapCache = map;

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
  apiKey
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

  if (!response.ok) {

    throw new Error(
      `Nexon API ${response.status}: ${text}`
    );

  }

  if (!text) {
    return null;
  }

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

  const number = Number(value);

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

  const data = await nexonFetch(
    `/id?nickname=${encodeURIComponent(nickname)}`,
    apiKey
  );

  /*
   * 정상 응답:
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

  const data = await nexonFetch(
    endpoint,
    apiKey
  );

  if (
    Array.isArray(data) &&
    data.length > 0
  ) {

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
      player =>
        String(player?.ouid) ===
        String(ouid)
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
   * API 응답 구조 변화에 대비하여
   * 가능한 필드를 순서대로 검사
   */

  const candidates = [

    player.division,

    player.divisionId,

    player.divisionID,

    player.division_id,

    player.matchDivision,

    player.matchDivisionId,

    player.matchDivisionID,

    player.rankDivision,

    player.rankDivisionId,

    player.rankDivisionID

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


  const detail =
    await getMatchDetail(
      latestMatchId,
      apiKey
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
    String(rawNicknames || "")
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
     streamers.json 직접 읽기
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


  /*
   * fcNickname → streamer
   */

  const streamerMap =
    new Map();


  for (
    const streamer of streamers
  ) {

    if (
      streamer?.fcNickname
    ) {

      streamerMap.set(
        String(
          streamer.fcNickname
        ).trim(),
        streamer
      );

    }

  }


  /*
   * Division 이름
   */

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
      streamerMap.get(nickname);


    /*
     * streamers.json에 없는 경우
     */

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


    /*
     * 기존 OUID
     */

    let ouid =
      streamer.fcOuid || null;


    /*
     * fallback divisionId
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
       OUID가 없는 신규 스트리머
    ======================================================== */

    if (!ouid) {

      try {

        console.log(
          `[FC TIER] OUID 조회: ${nickname}`
        );

        ouid =
          await getOuidByNickname(
            nickname,
            apiKey
          );

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


    /*
     * OUID를 찾지 못한 경우
     */

    if (!ouid) {

      results[nickname] = {

        ouid: null,

        divisionId,

        divisionName:
          divisionId !== null
            ? (
                divisionMap[
                  String(divisionId)
                ] ||
                `등급 ${divisionId}`
              )
            : null,

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

      continue;

    }


    /* ========================================================
       OUID 확보 성공
    ======================================================== */

    try {

      const latest =
        await getLatestTier(
          ouid,
          apiKey
        );


      latestMatchId =
        latest.latestMatchId;


      /*
       * 최근 경기 divisionId 성공
       */

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

      } else {

        /*
         * 최근 경기 실패
         *
         * 기존 divisionId fallback
         */

        error =
          latest.reason ||
          "최근 경기 티어 조회 실패";

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
       divisionName
    ======================================================== */

    const divisionName =
      divisionId !== null
        ? (
            divisionMap[
              String(divisionId)
            ] ||
            `등급 ${divisionId}`
          )
        : null;


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


  /*
   * 캐시 금지
   */

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  return res.status(200).json(
    results
  );

}
