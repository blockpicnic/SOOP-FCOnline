const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

/*
 * FC온라인 공식경기 1on1
 *
 * 기존 프로젝트에서 사용하던 matchtype.
 */
const OFFICIAL_MATCH_TYPE = 50;

let divisionCache = null;


/* ============================================================
   Division 메타데이터
============================================================ */

async function getDivisionMap() {

  if (divisionCache) {
    return divisionCache;
  }

  try {

    const response =
      await fetch(DIVISION_META_URL);

    if (!response.ok) {
      return {};
    }

    const data =
      await response.json();

    divisionCache = {};

    if (Array.isArray(data)) {

      for (const item of data) {

        if (
          item &&
          item.divisionId != null
        ) {

          divisionCache[
            String(item.divisionId)
          ] =
            item.divisionName || null;

        }

      }

    }

    return divisionCache;

  } catch (error) {

    console.warn(
      "Division metadata 조회 실패:",
      error.message
    );

    return {};
  }
}


/* ============================================================
   Nexon API
============================================================ */

async function nexonFetch(
  path,
  apiKey
) {

  const response =
    await fetch(
      `${NEXON_BASE}${path}`,
      {
        headers: {
          "x-nxopen-api-key":
            apiKey
        }
      }
    );


  const text =
    await response
      .text()
      .catch(() => "");


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
      "Nexon API 응답 JSON 파싱 실패"
    );

  }

}


/* ============================================================
   최근 매치 ID 조회
============================================================ */

async function getLatestMatchId(
  ouid,
  apiKey
) {

  /*
   * 절대로 /user/maxdivision을 사용하지 않습니다.
   *
   * /user/match에서 최근 경기 ID를 가져옵니다.
   */

  const path =
    `/user/match` +
    `?ouid=${encodeURIComponent(ouid)}` +
    `&matchtype=${OFFICIAL_MATCH_TYPE}` +
    `&offset=0` +
    `&limit=1`;


  const data =
    await nexonFetch(
      path,
      apiKey
    );


  /*
   * 정상적인 경우:
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
   경기 상세정보
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
   숫자 division 검증
============================================================ */

function normalizeDivision(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  /*
   * 숫자로 바로 들어오는 경우
   */
  const number =
    Number(value);


  if (
    Number.isFinite(number) &&
    number > 0
  ) {

    return number;

  }


  return null;
}


/* ============================================================
   Match Detail에서 division 찾기
============================================================ */

function findDivisionInPlayer(
  player
) {

  if (!player) {
    return null;
  }


  /*
   * 2026년 매치 상세 API에서 추가된
   * 경기 당시 등급 정보를 우선 확인합니다.
   *
   * 응답 버전/구조 차이를 고려하여
   * 여러 이름을 허용합니다.
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

    player.rankDivisionId

  ];


  for (
    const value of candidates
  ) {

    const division =
      normalizeDivision(value);


    if (division !== null) {
      return division;
    }

  }


  return null;
}


/* ============================================================
   Match Detail에서 해당 유저 찾기
============================================================ */

function findPlayerByOuid(
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


  const players =
    detail.matchInfo;


  /*
   * 가장 정확한 방법:
   * OUID가 같은 플레이어
   */

  const exact =
    players.find(
      player =>
        String(
          player?.ouid
        ) === String(ouid)
    );


  if (exact) {
    return exact;
  }


  return null;
}


/* ============================================================
   최근 경기에서 division 추출
============================================================ */

function extractLatestDivision(
  detail,
  ouid
) {

  const player =
    findPlayerByOuid(
      detail,
      ouid
    );


  /*
   * 정상적인 경우
   */
  if (player) {

    const division =
      findDivisionInPlayer(
        player
      );


    if (division !== null) {
      return division;
    }

  }


  /*
   * 혹시 OUID 구조가 달라진 경우를 대비해서
   * matchInfo 전체에서 division 필드를 찾습니다.
   *
   * 단, 첫 번째 division을 무조건 사용하는 것이 아니라
   * OUID가 존재하는 객체를 우선합니다.
   */

  if (
    Array.isArray(
      detail?.matchInfo
    )
  ) {

    for (
      const item of detail.matchInfo
    ) {

      if (
        String(item?.ouid) ===
        String(ouid)
      ) {

        const division =
          findDivisionInPlayer(
            item
          );


        if (
          division !== null
        ) {

          return division;

        }

      }

    }

  }


  return null;
}


/* ============================================================
   최근 경기의 티어 조회
============================================================ */

async function getLatestDivision(
  ouid,
  apiKey
) {

  /*
   * STEP 1
   * 최근 공식경기
   */

  const matchId =
    await getLatestMatchId(
      ouid,
      apiKey
    );


  if (!matchId) {

    return {
      success: false,
      matchId: null,
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
      matchId,
      apiKey
    );


  /*
   * STEP 3
   * 해당 경기에서 해당 유저의 division
   */

  const divisionId =
    extractLatestDivision(
      detail,
      ouid
    );


  if (
    divisionId === null
  ) {

    return {
      success: false,
      matchId,
      divisionId: null,
      reason:
        "최근 경기 상세정보에서 division을 찾지 못했습니다."
    };

  }


  return {
    success: true,
    matchId,
    divisionId,
    reason: null
  };

}


/* ============================================================
   streamers.json
============================================================ */

async function loadStreamers(
  req
) {

  const protocol =
    req.headers[
      "x-forwarded-proto"
    ] || "https";


  const host =
    req.headers.host;


  if (!host) {
    return [];
  }


  const url =
    `${protocol}://${host}/data/streamers.json`;


  const response =
    await fetch(
      url,
      {
        cache: "no-store"
      }
    );


  if (!response.ok) {

    throw new Error(
      `streamers.json ${response.status}`
    );

  }


  const data =
    await response.json();


  if (
    !Array.isArray(data)
  ) {

    throw new Error(
      "streamers.json must be an array"
    );

  }


  return data;
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
   * nicknames 파라미터
   */

  const nicknames =
    String(
      req.query.nicknames || ""
    )
      .split(",")
      .map(
        value =>
          value.trim()
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
   * Division 이름
   */

  const divisionMap =
    await getDivisionMap();


  /*
   * streamers.json
   */

  let streamers = [];

  try {

    streamers =
      await loadStreamers(req);

  } catch (error) {

    console.warn(
      "streamers.json 로드 실패:",
      error.message
    );

  }


  /*
   * fcNickname → streamer
   */

  const streamerMap = {};


  for (
    const streamer of streamers
  ) {

    if (
      !streamer?.fcNickname
    ) {
      continue;
    }


    streamerMap[
      streamer.fcNickname
    ] = streamer;

  }


  const results = {};


  /* ==========================================================
     스트리머별 조회
  ========================================================== */

  for (
    const nickname of nicknames
  ) {

    const streamer =
      streamerMap[nickname];


    /*
     * streamers.json의 OUID
     */

    const ouid =
      streamer?.fcOuid ||
      streamer?.ouid ||
      null;


    /*
     * fallback용 divisionId
     *
     * 이것은 절대로 정상적인 최근 경기 결과보다
     * 우선하지 않습니다.
     */

    const fallbackDivisionId =
      normalizeDivision(
        streamer?.divisionId
      );


    /*
     * OUID가 없으면 API 조회 불가능
     *
     * 이 경우에만 streamers.json divisionId 사용
     */

    if (!ouid) {

      const divisionId =
        fallbackDivisionId;


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

        source:
          divisionId !== null
            ? "streamers.json"
            : null,

        error:
          "fcOuid가 없습니다."

      };


      continue;
    }


    /*
     * 기본값
     *
     * API가 실패하면 fallback.
     */

    let divisionId =
      fallbackDivisionId;


    let latestMatchId =
      null;


    let source =
      "streamers.json";


    let error =
      null;


    /*
     * ========================================================
     * 가장 중요한 부분
     *
     * 최근 경기 → division
     * ========================================================
     */

    try {

      const latest =
        await getLatestDivision(
          ouid,
          apiKey
        );


      latestMatchId =
        latest.matchId;


      /*
       * 최근 경기의 division을 찾았으면
       * 무조건 이 값을 사용합니다.
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
         * 최근 경기 자체는 없거나
         * 상세에서 division을 못 찾은 경우
         *
         * fallback
         */

        error =
          latest.reason ||
          "최근 경기 티어 조회 실패";

      }


    } catch (apiError) {

      /*
       * 429 포함 Nexon API 오류
       *
       * 이 경우에만 fallback
       */

      error =
        apiError?.message ||
        String(apiError);


      console.warn(
        `최근 경기 조회 실패 (${nickname}):`,
        error
      );

    }


    /*
     * ========================================================
     * 최종 이름
     * ========================================================
     */

    let divisionName =
      null;


    if (
      divisionId !== null
    ) {

      divisionName =
        divisionMap[
          String(divisionId)
        ] ||
        `등급 ${divisionId}`;

    }


    /*
     * ========================================================
     * 최종 응답
     * ========================================================
     */

    results[nickname] = {

      ouid,

      divisionId,

      divisionName,

      latestMatchId,

      source,

      /*
       * 성공이면 null
       * fallback이면 원인 표시
       */
      error

    };

  }


  /*
   * 1분 캐시
   */

  res.setHeader(
    "Cache-Control",
    "s-maxage=60, stale-while-revalidate=30"
  );


  return res.status(200).json(
    results
  );

}
