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

  const response = await fetch(DIVISION_META_URL);

  if (!response.ok) {
    throw new Error(
      `division metadata ${response.status}`
    );
  }

  const data = await response.json();

  divisionCache = {};

  for (const item of data) {
    divisionCache[item.divisionId] =
      item.divisionName;
  }

  return divisionCache;
}


/* ============================================================
   Nexon API
============================================================ */

async function nexonFetch(path, apiKey) {
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
      await response.text().catch(() => "");

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
   경기 상세정보
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
   최근 경기의 division 찾기
============================================================ */

function getDivisionFromMatch(
  detail,
  ouid
) {
  const matchInfo =
    Array.isArray(detail?.matchInfo)
      ? detail.matchInfo
      : [];

  if (matchInfo.length === 0) {
    return null;
  }

  /*
   * 해당 OUID의 플레이어 정보를 우선 찾습니다.
   */
  const player =
    matchInfo.find(
      (item) =>
        String(item?.ouid) ===
        String(ouid)
    ) || null;

  if (!player) {
    return null;
  }

  /*
   * Nexon FC Online match-detail의
   * division 값을 사용합니다.
   */
  return (
    player.division ??
    player.divisionId ??
    null
  );
}


/* ============================================================
   최근 경기 티어 조회
============================================================ */

async function getLatestTier(
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

  console.log(
  "MATCH DETAIL:",
  JSON.stringify(detail, null, 2)
);
  
  const divisionId =
    getDivisionFromMatch(
      detail,
      ouid
    );

  return {
    matchId,
    divisionId,
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
        "NEXON_API_KEY가 설정되어 있지 않습니다.",
    });
  }


  const nicknames =
    String(
      req.query.nicknames || ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);


  if (nicknames.length === 0) {
    return res.status(400).json({
      error:
        "nicknames가 필요합니다.",
    });
  }


  const divisionMap =
    await getDivisionMap().catch(
      () => ({})
    );


  /*
   * streamers.json
   *
   * 기존 프로젝트의 데이터 구조를 사용합니다.
   */
  let streamers = [];

  try {
    const protocol =
      req.headers["x-forwarded-proto"] ||
      "https";

    const host =
      req.headers.host;

    const response =
      await fetch(
        `${protocol}://${host}/data/streamers.json`,
        {
          cache: "no-store",
        }
      );

    if (response.ok) {
      streamers =
        await response.json();
    }
  } catch (error) {
    console.error(
      "streamers.json 로드 실패:",
      error
    );
  }


  const streamerMap = {};

  if (Array.isArray(streamers)) {
    for (const streamer of streamers) {
      if (!streamer?.fcNickname) {
        continue;
      }

      streamerMap[
        streamer.fcNickname
      ] = streamer;
    }
  }


  const results = {};


  /*
   * 스트리머별 최근 경기 조회
   */
  for (const nickname of nicknames) {
    try {
      const streamer =
        streamerMap[nickname];


      /*
       * streamers.json에 fcOuid가 있으면
       * 그것을 그대로 사용합니다.
       */
      const ouid =
        streamer?.fcOuid;


      if (!ouid) {
        results[nickname] = {
          error:
            "streamers.json에 fcOuid가 없습니다.",
        };

        continue;
      }


      /*
       * 핵심:
       *
       * 1. user/match
       * 2. 가장 최근 공식경기 1개
       * 3. match-detail
       * 4. 해당 OUID의 division
       */
      const latest =
        await getLatestTier(
          ouid,
          apiKey
        );


      const divisionId =
        latest.divisionId;


      results[nickname] = {
        ouid,

        divisionId,

        divisionName:
          divisionId != null
            ? (
                divisionMap[divisionId] ||
                `등급 ${divisionId}`
              )
            : null,

        latestMatchId:
          latest.matchId,
      };


    } catch (error) {
      console.error(
        `티어 조회 실패: ${nickname}`,
        error
      );

      results[nickname] = {
        error:
          error?.message ||
          String(error),
      };
    }
  }


  /*
   * 너무 오래된 결과를 사용하지 않도록
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
