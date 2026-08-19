const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

const OFFICIAL_MATCH_TYPE = 50;

let divisionCache = null;


/* ============================================================
   Division 메타데이터
============================================================ */

async function getDivisionMap() {
  if (divisionCache) {
    return divisionCache;
  }

  const response = await fetch(
    DIVISION_META_URL
  );

  if (!response.ok) {
    throw new Error(
      `division metadata ${response.status}`
    );
  }

  const data = await response.json();

  divisionCache = {};

  if (Array.isArray(data)) {
    for (const item of data) {
      divisionCache[item.divisionId] =
        item.divisionName;
    }
  }

  return divisionCache;
}


/* ============================================================
   Nexon API 호출
============================================================ */

async function nexonFetch(
  path,
  apiKey
) {
  const response = await fetch(
    `${NEXON_BASE}${path}`,
    {
      headers: {
        "x-nxopen-api-key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const text =
      await response.text().catch(
        () => ""
      );

    throw new Error(
      `Nexon API ${response.status}: ${text}`
    );
  }

  return response.json();
}


/* ============================================================
   최근 공식경기 1대1
============================================================ */

async function getLatestMatchId(
  ouid,
  apiKey
) {
  const data = await nexonFetch(
    `/user/match?ouid=${encodeURIComponent(
      ouid
    )}&matchtype=${OFFICIAL_MATCH_TYPE}&offset=0&limit=1`,
    apiKey
  );

  if (!Array.isArray(data)) {
    return null;
  }

  return data[0] || null;
}


/* ============================================================
   경기 상세
============================================================ */

async function getMatchDetail(
  matchId,
  apiKey
) {
  return nexonFetch(
    `/match-detail?matchid=${encodeURIComponent(
      matchId
    )}`,
    apiKey
  );
}


/* ============================================================
   division 추출
============================================================ */

function extractDivision(
  detail,
  ouid
) {
  const matchInfo =
    Array.isArray(detail?.matchInfo)
      ? detail.matchInfo
      : [];

  if (
    matchInfo.length === 0
  ) {
    return null;
  }


  /*
   * 우선 해당 OUID의 경기 정보를 찾습니다.
   */
  const player =
    matchInfo.find(
      (item) =>
        String(item?.ouid) ===
        String(ouid)
    );


  if (!player) {
    return null;
  }


  /*
   * 2026년 현재 매치 상세에서
   * 경기 당시 등급 식별자를 우선 확인합니다.
   */
  const division =
    player.division ??
    player.divisionId ??
    null;


  if (
    division === null ||
    division === undefined ||
    division === ""
  ) {
    return null;
  }


  return Number(division);
}


/* ============================================================
   최근 경기 티어
============================================================ */

async function getLatestDivision(
  ouid,
  apiKey
) {
  const matchId =
    await getLatestMatchId(
      ouid,
      apiKey
    );


  if (!matchId) {
    return {
      matchId: null,
      divisionId: null,
    };
  }


  const detail =
    await getMatchDetail(
      matchId,
      apiKey
    );


  const divisionId =
    extractDivision(
      detail,
      ouid
    );


  return {
    matchId,
    divisionId,
  };
}


/* ============================================================
   streamers.json 읽기
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
        cache: "no-store",
      }
    );


  if (!response.ok) {
    throw new Error(
      `streamers.json ${response.status}`
    );
  }


  const data =
    await response.json();


  return Array.isArray(data)
    ? data
    : [];
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
        "NEXON_API_KEY가 설정되어 있지 않습니다.",
    });
  }


  /*
   * nicknames=닉네임1,닉네임2
   */
  const nicknames =
    String(
      req.query.nicknames || ""
    )
      .split(",")
      .map(
        (value) =>
          value.trim()
      )
      .filter(Boolean);


  if (
    nicknames.length === 0
  ) {
    return res.status(400).json({
      error:
        "nicknames가 필요합니다.",
    });
  }


  /* ----------------------------------------------------------
     Division 이름
  ---------------------------------------------------------- */

  let divisionMap = {};

  try {
    divisionMap =
      await getDivisionMap();
  } catch (error) {
    console.warn(
      "division metadata 조회 실패:",
      error.message
    );
  }


  /* ----------------------------------------------------------
     streamers.json
  ---------------------------------------------------------- */

  let streamers = [];

  try {
    streamers =
      await loadStreamers(req);
  } catch (error) {
    console.warn(
      "streamers.json 조회 실패:",
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


  /* ----------------------------------------------------------
     스트리머별 처리
  ---------------------------------------------------------- */

  for (
    const nickname of nicknames
  ) {
    const streamer =
      streamerMap[nickname];


    /*
     * --------------------------------------------------------
     * fallback divisionId
     *
     * streamers.json에 이미 입력되어 있는 값
     * --------------------------------------------------------
     */

    const fallbackDivisionId =
      streamer?.divisionId != null
        ? Number(
            streamer.divisionId
          )
        : null;


    /*
     * fcOuid가 없으면 API 조회 자체를 하지 않고
     * streamers.json의 divisionId를 사용합니다.
     */
    const ouid =
      streamer?.fcOuid;


    if (!ouid) {
      const divisionId =
        fallbackDivisionId;


      results[nickname] = {
        ouid: null,

        divisionId,

        divisionName:
          divisionId != null
            ? (
                divisionMap[
                  divisionId
                ] ||
                `등급 ${divisionId}`
              )
            : null,

        latestMatchId: null,

        source:
          "streamers.json",
      };


      continue;
    }


    /*
     * --------------------------------------------------------
     * 기본값은 streamers.json
     *
     * Nexon API가 실패하더라도 null로 만들지 않습니다.
     * --------------------------------------------------------
     */

    let divisionId =
      fallbackDivisionId;

    let latestMatchId =
      null;

    let source =
      "streamers.json";


    try {
      /*
       * 최근 공식경기 1개 조회
       */
      const latest =
        await getLatestDivision(
          ouid,
          apiKey
        );


      latestMatchId =
        latest.matchId;


      /*
       * 최근 경기에서 division을 찾았으면
       * 그것을 최우선으로 사용합니다.
       */
      if (
        latest.divisionId != null
      ) {
        divisionId =
          latest.divisionId;

        source =
          "latest-match";
      }


    } catch (error) {
      /*
       * 429 / API 오류 등이 발생해도
       * fallback divisionId를 유지합니다.
       */
      console.warn(
        `최근 경기 티어 조회 실패 (${nickname}):`,
        error.message
      );
    }


    /* --------------------------------------------------------
       최종 결과
    -------------------------------------------------------- */

    results[nickname] = {
      ouid,

      divisionId,

      divisionName:
        divisionId != null
          ? (
              divisionMap[
                divisionId
              ] ||
              `등급 ${divisionId}`
            )
          : null,

      latestMatchId,

      source,
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
