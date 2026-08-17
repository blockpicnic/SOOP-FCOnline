// /api/live-status?ids=streamer1,streamer2,streamer3
// SOOP이 자체 플레이어에서 쓰는 비공식 엔드포인트를 대신 호출해주는 프록시.
// 브라우저에서 직접 호출하면 CORS에 막히기 때문에 서버(이 함수)를 한 단계 거칩니다.
//
// ⚠️ 미문서화 엔드포인트라 파라미터명이 바뀔 수 있습니다.
// 배포 전에 브라우저 개발자도구(F12) > Network 탭에서
// SOOP 방송 페이지 접속 시 나가는 실제 요청의 파라미터명을 한 번 확인해서
// 아래 body 부분을 맞춰주세요.

export default async function handler(req, res) {
  const idsParam = req.query.ids || "";
  const ids = idsParam.split(",").map(s => s.trim()).filter(Boolean);

  if (ids.length === 0) {
    return res.status(400).json({ error: "ids 쿼리 파라미터가 필요합니다. 예: ?ids=streamer1,streamer2" });
  }

  const results = {};

  await Promise.all(ids.map(async (id) => {
    try {
      const response = await fetch("https://live.sooplive.co.kr/afreeca/player_live_api.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0",
        },
        // bid: 조회할 스트리머 아이디. 실제 파라미터명은 devtools에서 재확인 권장.
        body: new URLSearchParams({ bid: id, type: "live" }).toString(),
      });

      const data = await response.json();

      // 응답 구조도 미문서화 상태라 실제 확인 후 아래 판별 조건을 조정하세요.
      // 보통 방송 중이 아니면 CHANNEL.RESULT 값이 0 또는 에러 코드로 옵니다.
      const isLive = !!(data?.CHANNEL?.RESULT && data.CHANNEL.RESULT !== 0);

      results[id] = { live: isLive, raw: data?.CHANNEL ?? null };
    } catch (err) {
      results[id] = { live: false, error: String(err) };
    }
  }));

  // 60초 정도 CDN 캐시 -> SOOP 서버에 과도한 요청 방지
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
  res.status(200).json(results);
}
