// /api/tier?nicknames=닉네임1,닉네임2
//
// FC온라인 스트리머의 공식경기 1대1 티어 조회.
//
// fcOuid가 streamers.json에 저장되어 있으면:
//   fcOuid → user/basic → 현재 닉네임 확인
//   → 현재 닉네임 → maxdivision → 현재 티어
//
// fcOuid가 없는 기존 데이터는:
//   닉네임 → id → OUID → maxdivision
// 방식으로 기존처럼 처리합니다.

const NEXON_BASE = "https://open.api.nexon.com/fconline/v1";
const DIVISION_META_URL =
  "https://open.api.nexon.com/static/fconline/meta/division.json";

const MATCHTYPE_공식경기_1대1 = 50;

let divisionCache = null;


/* ============================================================
   티어 메타데이터
============================================================ */

async function getDivisionMap() {
  if (divisionCache) return divisionCache;

  const res = await fetch(DIVISION_META_URL);

  if (!res.ok) {
    throw new Error(`division metadata ${res.status}`);
  }

  const list = await res.json();

  divisionCache = {};

  list.forEach((d) => {
    divisionCache[d.divisionId] = d.divisionName;
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
   현재 닉네임 조회
============================================================ */

async function getCurrentUserByOuid(ouid, apiKey) {
  const data = await fetchJson(
    `${NEXON_BASE}/user/basic?ouid=${encodeURIComponent(ouid)}`,
    apiKey
  );

  return {
    ouid: data.ouid || ouid,
    nickname: data.nickname || null,
    level: data.level ?? null,
  };
}


/* ============================================================
   OUID → 공식경기 1대1 티어
============================================================ */

async function getMaxDivision(ouid, apiKey) {
  const data = await fetchJson(
    `${NEXON_BASE}/user/maxdivision?ouid=${encodeURIComponent(
      ouid
    )}&matchtype=${MATCHTYPE_공식경기_1대1}`,
    apiKey
  );

  const entry =
    Array.isArray(data)
      ? data[0]
      : data;

  return {
    divisionId:
      entry?.division ?? null,
  };
}


/* ============================================================
   API Handler
============================================================ */

export default async function handler(req, res) {

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
    await getDivisionMap().catch(() => ({}));


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

  streamers.forEach((streamer) => {

    if (!streamer.fcNickname) {
      return;
    }

    streamerMap[
      streamer.fcNickname
    ] = streamer;

  });


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


        /* ====================================================
           1. 저장된 fcOuid가 있으면 OUID를 우선 사용
        ==================================================== */

        if (
          streamer &&
          streamer.fcOuid
        ) {

          ouid =
            streamer.fcOuid;


          /* --------------------------------------------------
             OUID → 현재 닉네임
          -------------------------------------------------- */

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

          /* ==================================================
             2. fcOuid가 없으면 기존 방식
                닉네임 → OUID
          ================================================== */

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

            return;
          }

        }


        /* --------------------------------------------------
           현재 OUID의 공식경기 1대1 최고 티어
        -------------------------------------------------- */

        const maxDivision =
          await getMaxDivision(
            ouid,
            apiKey
          );


        const divisionId =
          maxDivision.divisionId;


        const divisionName =
          divisionId != null
            ? (
                divisionMap[divisionId] ||
                `등급 ${divisionId}`
              )
            : null;


        /* --------------------------------------------------
           결과
        -------------------------------------------------- */

        results[nickname] = {

          // 고정 식별자
          ouid,

          // 현재 닉네임
          currentNickname,

          // 이전에 등록되어 있던 닉네임
          registeredNickname:
            nickname,

          // 닉네임이 변경됐는지
          nicknameChanged:
            currentNickname !== nickname,

          // 공식경기 1대1
          divisionId,
          divisionName,

        };


        } catch (err) {

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

  res.setHeader(
    "Cache-Control",
    "s-maxage=300, stale-while-revalidate=120"
  );


  return res.status(200).json(
    results
  );
}
