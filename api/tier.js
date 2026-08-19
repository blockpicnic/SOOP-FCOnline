/*
 * api/tier.js
 *
 * FC온라인 최근 공식경기 티어 조회
 *
 * 우선순위:
 *
 * 1. streamers.json의 fcOuid 사용
 * 2. /user/match에서 최근 공식경기 ID 조회
 * 3. /match-detail에서 해당 경기 당시 divisionId 조회
 * 4. 성공하면 source = "latest-match"
 * 5. 실패하면 streamers.json의 divisionId를 fallback
 *
 * 중요:
 * /user/maxdivision 사용 안 함
 * → 역대 최고 티어를 가져오지 않음
 */

const fs = require("fs");
const path = require("path");

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

/*
 * FC온라인 공식경기 1on1
 */
const OFFICIAL_MATCH_TYPE = 50;


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
   Nexon API 요청
============================================================ */

async function nexonFetch(
  endpoint,
  apiKey
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
   숫자 divisionId 정규화
============================================================ */

function normalizeDivisionId(
  value
) {

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
   최근 경기 ID
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
   * 정상적인 /user/match 응답:
   *
   * [
   *   "match-id"
   * ]
   */

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
   해당 유저의 matchInfo 찾기
============================================================ */

function findUserMatchInfo(
  detail,
  ouid
) {

  if (
    !detail ||
    !Array.isArray(
      detail.matchInfo
    )
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
   최근 경기 당시 divisionId 추출
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
   * 2026-05-21 이후 match-detail에
   * 경기 당시 등급 식별자가 추가됨.
   *
   * API 응답 구조 변경 가능성을 고려해
   * 후보 필드를 순서대로 검사.
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

  /*
   * STEP 1
   * 최근 공식경기 ID
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
   * STEP 2
   * 경기 상세
   */

  const detail =
    await getMatchDetail(
      latestMatchId,
      apiKey
    );


  /*
   * STEP 3
   * 해당 경기에서 해당 유저의 division
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
        "최근 경기 상세정보에서 해당 유저의 divisionId를 찾지 못했습니다."
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

  /*
   * API Key
   */

  const apiKey =
    process.env.NEXON_API_KEY;


  if (!apiKey) {

    return res.status(500).json({
      error:
        "NEXON_API_KEY가 설정되어 있지 않습니다."
    });

  }


  /*
   * nicknames
   *
   * 예:
   *
   * /api/tier?nicknames=메시연
   *
   * 또는
   *
   * /api/tier?nicknames=메시연,호날두
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


  /*
   * streamers.json을
   * 서버 파일에서 직접 읽습니다.
   *
   * 더 이상
   * https://사이트/data/streamers.json
   * 를 fetch하지 않습니다.
   */

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
     스트리머별 처리
  ========================================================== */

  for (
    const nickname of nicknames
  ) {

    const streamer =
      streamerMap.get(
        nickname
      );


    /*
     * streamers.json에 없는 닉네임
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
     * OUID
     *
     * 중요:
     * streamers.json에 이미 있는 fcOuid를 사용.
     */

    const ouid =
      streamer.fcOuid || null;


    /*
     * fallback
     *
     * 최근 경기 API가 실패했을 때만 사용.
     */

    const fallbackDivisionId =
      normalizeDivisionId(
        streamer.divisionId
      );


    /*
     * OUID가 없는 경우
     */

    if (!ouid) {

      results[nickname] = {

        ouid: null,

        divisionId:
          fallbackDivisionId,

        divisionName:
          fallbackDivisionId !== null
            ? (
                divisionMap[
                  String(
                    fallbackDivisionId
                  )
                ] ||
                `등급 ${fallbackDivisionId}`
              )
            : null,

        latestMatchId: null,

        source:
          fallbackDivisionId !== null
            ? "streamers.json"
            : null,

        error:
          fallbackDivisionId !== null
            ? "fcOuid가 없어 streamers.json의 divisionId를 사용했습니다."
            : "fcOuid가 없습니다."

      };

      continue;

    }


    /*
     * 기본값
     *
     * API 실패 시 fallback.
     */

    let divisionId =
      fallbackDivisionId;


    let latestMatchId =
      null;


    let source =
      "streamers.json";


    let error =
      null;


    /* ========================================================
       최근 경기 조회
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
       * 최근 경기에서 division을 찾았다면
       * 이것을 무조건 사용.
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
         * 최근 경기 조회 실패
         *
         * fallback 유지
         */

        error =
          latest.reason ||
          "최근 경기 티어 조회 실패";

      }


    } catch (errorObject) {

      error =
        errorObject?.message ||
        String(errorObject);


      /*
       * 여기서 중요한 점:
       *
       * 429가 발생해도
       * fallback만 사용합니다.
       *
       * maxdivision API는 호출하지 않습니다.
       */

      console.warn(
        `[FC TIER] ${nickname}: ${error}`
      );

    }


    /*
     * divisionName
     */

    const divisionName =
      divisionId !== null
        ? (
            divisionMap[
              String(divisionId)
            ] ||
            `등급 ${divisionId}`
          )
        : null;


    /*
     * 최종 결과
     */

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
   * 응답 캐시
   *
   * 너무 오래된 결과를 Vercel이 재사용하지 않도록
   * 짧게 설정.
   */

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  return res.status(200).json(
    results
  );

}
