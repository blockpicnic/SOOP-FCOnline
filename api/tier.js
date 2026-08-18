// /api/tier?nicknames=닉네임1,닉네임2
//
// FC온라인 스트리머의 공식경기 1대1 "최근 경기" 티어 조회.
//
// 기존:
//   user/maxdivision → 최고 티어
//
// 변경:
//   match → 가장 최근 경기 1개
//   → match-detail → 해당 경기의 division
//
// streamers.json의 fcOuid가 있으면 OUID를 우선 사용합니다.
// fcOuid가 없으면 닉네임으로 OUID를 조회합니다.

const NEXON_BASE =
  "https://open.api.nexon.com/fconline/v1";

const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

const MATCHTYPE_공식경기_1대1 = 50;

let divisionCache = null;


/* ============================================================
   티어 메타데이터
============================================================ */

async function getDivisionMap() {
  if (divisionCache) {
    return divisionCache;
  }

  const res = await fetch(DIVISION_META_URL);

  if (!res.ok) {
    throw new Error(
      `division metadata ${res.status}`
    );
  }

  const list = await res.json();

  divisionCache = {};

  list.forEach((d) => {
    divisionCache[d.divisionId] =
      d.divisionName;
  });

  return divisionCache;
}


/* ============================================================
   Nexon API 호출
============================================================ */

async function fetchJson(url, apiKey) {
  const res = await fetch(url, {
    headers: {
      "x-nxopen-api-key": apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");

    throw new Error(
      `Nexon API ${res.status}: ${text}`
    );
  }

  return res.json();
}


/* ============================================================
   streamers.json 불러오기
============================================================ */

async function loadStreamers(req) {
  const host = req.headers.host;

  if (!host) {
    return [];
  }

  const protocol =
    req.headers["x-forwarded-proto"] || "https";

  const url =
    `${protocol}://${host}/data/streamers.json`;

  const res = await fetch(url, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `streamers.json ${res.status}`
    );
  }

  const data = await res.json();

  if (!Array.isArray(data)) {
    throw new Error(
      "streamers.json must be an array"
    );
  }

  return data;
}


/* ============================================================
   OUID → 현재 닉네임
============================================================ */

async function getCurrentUserByOuid(
  ouid,
  apiKey
) {
  const data = await fetchJson(
    `${NEXON_BASE}/user/basic?ouid=${encodeURIComponent(
      ouid
    )}`,
    apiKey
  );

  return {
    ouid: data.ouid || ouid,
    nickname: data.nickname || null,
    level: data.level ?? null,
  };
}


/* ============================================================
   OUID → 가장 최근 공식경기 1대1 경기 ID
============================================================ */

async function getLatestMatchId(
  ouid,
  apiKey
) {
  const data = await fetchJson(
    `${NEXON_BASE}/match?ouid=${encodeURIComponent(
      ouid
    )}&matchtype=${MATCHTYPE_공식경기_1대1}&offset=0&limit=1`,
    apiKey
  );

  if (!Array.isArray(data)) {
    return null;
  }

  if (data.length === 0) {
    return null;
  }

  return data[0];
}


/* ============================================================
   경기 ID → 경기 상세정보
============================================================ */

async function getMatchDetail(
  matchId,
  apiKey
) {
  return fetchJson(
    `${NEXON_BASE}/match-detail?matchid=${encodeURIComponent(
      matchId
    )}`,
    apiKey
  );
}


/* ============================================================
   최근 경기 → 해당 OUID의 division
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

  const matchInfo =
    Array.isArray(detail?.matchInfo)
      ? detail.matchInfo
      : [];

  /*
   * 최근 경기의 matchInfo 안에서
   * 현재 OUID에 해당하는 플레이어를 찾습니다.
   */
  const myInfo =
    matchInfo.find(
      (info) =>
        info?.ouid === ouid
    ) || matchInfo[0];

  /*
   * Nexon FC Online match-detail 응답에서
   * division 값은 matchInfo 쪽에 존재합니다.
   */
  const divisionId =
    myInfo?.division ??
    myInfo?.divisionId ??
    null;

  return {
    matchId,
    divisionId,
  };
}


/* ============================================================
   API Handler
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
        "서버에 NEXON_API_KEY 환경변수가 설정되어 있지 않습니다.",
    });
  }


  const nicknamesParam =
    req.query.nicknames || "";

  const nicknames =
    nicknamesParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  if (nicknames.length === 0) {
    return res.status(400).json({
      error:
        "nicknames 쿼리 파라미터가 필요합니다.",
    });
  }


  /* ----------------------------------------------------------
     티어 메타데이터
  ---------------------------------------------------------- */

  const divisionMap =
    await getDivisionMap().catch(
      () => ({})
    );


  /* ----------------------------------------------------------
     저장된 스트리머 데이터
  ---------------------------------------------------------- */

  let streamers = [];

  try {
    streamers =
      await loadStreamers(req);
  } catch (err) {
    console.warn(
      "streamers.json 로드 실패:",
      err.message || err
    );
  }


  /* ----------------------------------------------------------
     닉네임 → 스트리머 데이터 매칭
  ---------------------------------------------------------- */

  const streamerMap = {};

  streamers.forEach(
    (streamer) => {
      if (!streamer.fcNickname) {
        return;
      }

      streamerMap[
        streamer.fcNickname
      ] = streamer;
    }
  );


  const results = {};


  /* ----------------------------------------------------------
     각 스트리머 처리
  ---------------------------------------------------------- */

  for (const nickname of nicknames) {
    try {
      const streamer =
        streamerMap[nickname];

      let ouid = null;

      let currentNickname =
        nickname;


      /* ======================================================
         1. 저장된 fcOuid가 있으면 OUID 사용
      ====================================================== */

      if (
        streamer &&
        streamer.fcOuid
      ) {
        ouid =
          streamer.fcOuid;


        /* ----------------------------------------------------
           OUID → 현재 닉네임
        ---------------------------------------------------- */

        const basic =
          await getCurrentUserByOuid(
            ouid,
            apiKey
          );

        if (basic.nickname) {
          currentNickname =
            basic.nickname;
        }

      } else {

        /* ====================================================
           2. fcOuid가 없으면
              닉네임 → OUID
        ==================================================== */

        const idData =
          await fetchJson(
            `${NEXON_BASE}/id?nickname=${encodeURIComponent(
              nickname
            )}`,
            apiKey
          );

        ouid =
          idData.ouid;

        if (!ouid) {
          results[nickname] = {
            error:
              "ouid를 찾지 못했습니다 (닉네임 확인 필요)",
          };

          continue;
        }
      }


      /* ------------------------------------------------------
         최근 공식경기 1대1 조회
      ------------------------------------------------------ */

      const latest =
        await getLatestDivision(
          ouid,
          apiKey
        );


      const divisionId =
        latest.divisionId;


      const divisionName =
        divisionId != null
          ? (
              divisionMap[divisionId] ||
              `등급 ${divisionId}`
            )
          : null;


      /* ------------------------------------------------------
         결과
      ------------------------------------------------------ */

      results[nickname] = {
        ouid,

        currentNickname,

        registeredNickname:
          nickname,

        nicknameChanged:
          currentNickname !== nickname,

        divisionId,

        divisionName,

        latestMatchId:
          latest.matchId,
      };


    } catch (err) {
      console.error(
        `티어 조회 실패 (${nickname}):`,
        err
      );

      results[nickname] = {
        error:
          String(
            err.message || err
          ),
      };
    }
  }


  /* ----------------------------------------------------------
     캐시
  ---------------------------------------------------------- */

  /*
   * 너무 오래된 티어가 표시되지 않도록
   * 기존 5분 캐시는 제거하고 짧게 유지합니다.
   */
  res.setHeader(
    "Cache-Control",
    "s-maxage=60, stale-while-revalidate=30"
  );


  return res.status(200).json(
    results
  );
}
