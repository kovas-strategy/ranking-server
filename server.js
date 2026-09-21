// =====================================================================
// 코바스 패치 러너 — 랭킹 중계 API 서버
// =====================================================================
// 역할: 게임 웹과 DB 사이의 중계자.
//   - 웹은 이 서버에만 요청하고, DB에 직접 접속하지 않음
//   - DB 비밀번호(DATABASE_URL)는 이 서버의 '환경변수'에만 존재
//   - 인사 DB(kovasdb)와는 완전히 분리된 '게임 전용 DB'만 사용
// 실행: Render에 배포. 로컬 테스트는 `npm install && npm start`
// =====================================================================

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
// sendBeacon(페이지 종료 시 0m 전송)은 text/plain으로 오므로 함께 파싱
app.use(express.text({ type: ["text/plain"] }));
app.use((req, res, next) => {
  // text/plain으로 온 JSON 문자열을 객체로 변환
  if (typeof req.body === "string" && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch (e) { /* 무시 */ }
  }
  next();
});

// ── CORS: 게임 웹에서의 요청만 허용 ─────────────────────────────────
// ★ ALLOW_ORIGIN 환경변수에 허용할 주소를 넣으세요.
//   여러 개면 쉼표로 구분: https://new-kovas.github.io,https://trend.kovas.co.kr
//   "*" 하나면 모든 주소 허용.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const ALLOW_LIST = ALLOW_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_LIST.includes("*")) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOW_LIST.includes(origin)) {
    // 요청한 주소가 허용 목록에 있으면 그 주소를 그대로 허용(여러 도메인 대응)
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── DB 연결 ─────────────────────────────────────────────────────────
// DATABASE_URL은 Render의 게임 전용 PostgreSQL 접속 문자열(환경변수).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // Render 외부 접속 시 필요
});

// ── 유틸: 이번 주 '토요일'(주 시작일) 구하기 ─────────────────────────
// 게임 주간은 토요일 시작 ~ 다음주 금요일 마감(금요일 15시 발표) 기준.
// ── 유틸: 주 시작일(금요일 15시 KST 기준) ────────────────────────────
// 한 주기 = 금요일 15:00 ~ 다음 금요일 15:00 (KST).
// 금요일 15시에 그 주가 마감되며 동시에 위너 선정 → 억울한 구간 없음.
// 반환값: 그 주기가 시작된 '금요일'의 날짜(YYYY-MM-DD).
function currentWeekStart() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000); // KST
  const day = kst.getUTCDay();            // 0=일 … 5=금 … 6=토
  const hour = kst.getUTCHours();         // KST 시(0~23)
  let daysSinceFri = (day - 5 + 7) % 7;   // 금요일로부터 며칠 지났나
  if (day === 5 && hour < 15) daysSinceFri = 7; // 금요일 15시 이전이면 지난 금요일 기준
  const start = new Date(kst);
  start.setUTCDate(kst.getUTCDate() - daysSinceFri);
  return start.toISOString().slice(0, 10);
}

// ── 부정 점수 방어(간단 검증) ───────────────────────────────────────
// 게임 밸런스 기준으로 '불가능한 점수'를 걸러냄.
function validateScore(body) {
  const name = String(body.player_name || "").trim().slice(0, 20);
  const distance = Number(body.distance);
  const uv = Number(body.uv_blocked || 0);
  const wr = Number(body.wrinkle_filled || 0);
  const secs = Number(body.play_seconds || 0);

  if (!name) return { ok: false, why: "이름이 없습니다." };
  if (!isFinite(distance) || distance < 0) return { ok: false, why: "거리 값이 이상합니다." };

  // 거리는 플레이 시간에 비례해 계속 늘 수 있다(속도가 지속 상승).
  //   명백한 조작만 막도록 상한을 넉넉히 둔다.
  if (distance > 100000) return { ok: false, why: "비정상적으로 높은 점수입니다." };

  // 시간 대비 거리: 게임 후반 가속 상태에서는 순간 70m/s 이상, 평균도 40m/s를 넘을 수 있다.
  //   정상 플레이를 막지 않도록 초당 150m를 상한으로 둔다(명백한 조작만 차단).
  if (secs > 0 && distance / secs > 150) return { ok: false, why: "시간 대비 거리가 비정상입니다." };

  // 음수/과도한 카운트 방어
  if (uv < 0 || wr < 0 || uv > 100000 || wr > 100000) return { ok: false, why: "카운트 값이 이상합니다." };

  return { ok: true, name, distance: Math.round(distance * 1000) / 1000, uv, wr, secs };
}

// =====================================================================
// 엔드포인트
// =====================================================================

// 헬스체크
app.get("/", (req, res) => res.json({ ok: true, service: "kovas-patch-runner-ranking" }));

// 이름 정규화(중복 검사 기준): 앞뒤 공백 제거 + 내부 공백 제거 + 소문자화
// → "홍길동", "홍길동 ", "홍 길동", "HONG" 등의 사소한 차이를 같은 이름으로 취급
function normName(s) {
  return String(s || "").trim().replace(/\s+/g, "").toLowerCase();
}

// [이름 중복 확인]  GET /check-name?name=홍길동
//   응답: { ok:true, available:true|false }
app.get("/check-name", async (req, res) => {
  const name = String(req.query.name || "").trim().slice(0, 20);
  const key = normName(name);
  if (!key) return res.status(400).json({ ok: false, error: "이름이 비었습니다." });
  try {
    const { rows } = await pool.query(`SELECT 1 FROM players WHERE name_key = $1`, [key]);
    res.json({ ok: true, available: rows.length === 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "확인 실패" });
  }
});

// [이름 등록]  POST /register   body: { name }
//   먼저 쓴 사람이 임자(선착순 고유). 이미 있으면 거부.
app.post("/register", async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 20);
  const key = normName(name);
  if (!key) return res.status(400).json({ ok: false, error: "이름을 입력해주세요." });
  if (name.length < 2) return res.status(400).json({ ok: false, error: "이름이 너무 짧습니다." });
  try {
    await pool.query(`INSERT INTO players (name, name_key) VALUES ($1, $2)`, [name, key]);
    res.json({ ok: true, name });
  } catch (e) {
    // 고유 인덱스 위반 = 이미 등록된 이름
    if (e.code === "23505") return res.json({ ok: false, taken: true, error: "이미 등록된 이름입니다." });
    console.error(e);
    res.status(500).json({ ok: false, error: "등록 실패" });
  }
});

// [점수 저장]  POST /score
//   body: { player_name, distance, uv_blocked, wrinkle_filled, play_seconds }
//   - 등록된 이름만 허용
//   - 주 1회 제한: 그 이름으로 이번 주 이미 기록이 있으면 거부
app.post("/score", async (req, res) => {
  const v = validateScore(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.why });
  try {
    const key = normName(v.name);
    // 등록된 이름인지 확인
    const reg = await pool.query(`SELECT name FROM players WHERE name_key = $1`, [key]);
    if (!reg.rows.length) {
      return res.status(400).json({ ok: false, needRegister: true, error: "등록되지 않은 이름입니다." });
    }
    const officialName = reg.rows[0].name;   // 등록 당시 원래 표기 사용
    const week = currentWeekStart();
    // 주 1회 제한: 이번 주에 이미 기록이 있는지
    const dup = await pool.query(
      `SELECT 1 FROM scores WHERE player_name = $1 AND week_start = $2 LIMIT 1`,
      [officialName, week]
    );
    if (dup.rows.length) {
      return res.status(409).json({ ok: false, alreadyPlayed: true, error: "이번 주는 이미 참여하셨습니다." });
    }
    await pool.query(
      `INSERT INTO scores (player_name, distance, uv_blocked, wrinkle_filled, play_seconds, week_start)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [officialName, v.distance, v.uv, v.wr, v.secs, week]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "저장 실패" });
  }
});

// [이번 주 참여 여부]  GET /played?name=홍길동
//   응답: { ok:true, played:true|false }  — 게임이 시작 전에 확인해 막을 수 있음
app.get("/played", async (req, res) => {
  const key = normName(req.query.name);
  if (!key) return res.json({ ok: true, played: false });
  try {
    const reg = await pool.query(`SELECT name FROM players WHERE name_key = $1`, [key]);
    if (!reg.rows.length) return res.json({ ok: true, played: false });
    const week = currentWeekStart();
    const { rows } = await pool.query(
      `SELECT 1 FROM scores WHERE player_name = $1 AND week_start = $2 LIMIT 1`,
      [reg.rows[0].name, week]
    );
    res.json({ ok: true, played: rows.length > 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "확인 실패" });
  }
});

// [이번 주 TOP 5]  GET /ranking
app.get("/ranking", async (req, res) => {
  try {
    const week = currentWeekStart();
    const { rows } = await pool.query(
      `SELECT player_name, MAX(distance) AS best
       FROM scores WHERE week_start = $1
       GROUP BY player_name ORDER BY best DESC LIMIT 5`,
      [week]
    );
    res.json({ ok: true, week_start: week, ranking: rows.map(r => ({ name: r.player_name, distance: Number(r.best) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "조회 실패" });
  }
});

// [올타임 챔피언]  GET /champion
app.get("/champion", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT player_name, distance FROM scores ORDER BY distance DESC LIMIT 1`
    );
    if (!rows.length) return res.json({ ok: true, champion: null });
    res.json({ ok: true, champion: { name: rows[0].player_name, distance: Number(rows[0].distance) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "조회 실패" });
  }
});

// [역대 주간 위너 목록]  GET /winners
app.get("/winners", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT generation, player_name, distance, week_start
       FROM weekly_winners ORDER BY generation DESC`
    );
    res.json({ ok: true, winners: rows.map(r => ({
      generation: r.generation, name: r.player_name,
      distance: Number(r.distance), week_start: r.week_start
    })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "조회 실패" });
  }
});

// [주간 마감 → 위너 확정]  POST /close-week  또는  GET /close-week
//   매주 금요일 15시(KST)에 '그 주 1등'을 weekly_winners에 박제.
//   ★ 아무나 호출하면 안 되므로 ADMIN_KEY로 보호.
//   - POST: body { admin_key }
//   - GET/POST 공통: 헤더 X-Admin-Key 로도 인증 가능 (Cron에서 curl 호출 편의)
async function handleCloseWeek(req, res) {
  const key = req.headers["x-admin-key"] || (req.body && req.body.admin_key);
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: "권한 없음" });
  }
  try {
    const week = currentWeekStart();
    // 그 주 1등
    const top = await pool.query(
      `SELECT player_name, MAX(distance) AS best FROM scores
       WHERE week_start = $1 GROUP BY player_name ORDER BY best DESC LIMIT 1`,
      [week]
    );
    if (!top.rows.length) return res.json({ ok: true, note: "이번 주 기록 없음" });

    // 이미 이 주가 확정됐는지 확인(중복 방지)
    const exists = await pool.query(`SELECT 1 FROM weekly_winners WHERE week_start = $1`, [week]);
    if (exists.rows.length) return res.json({ ok: true, note: "이미 확정된 주입니다." });

    // 다음 대수(generation)
    const gen = await pool.query(`SELECT COALESCE(MAX(generation),0)+1 AS g FROM weekly_winners`);
    const generation = gen.rows[0].g;

    await pool.query(
      `INSERT INTO weekly_winners (generation, player_name, distance, week_start)
       VALUES ($1,$2,$3,$4)`,
      [generation, top.rows[0].player_name, top.rows[0].best, week]
    );
    res.json({ ok: true, winner: { generation, name: top.rows[0].player_name, distance: Number(top.rows[0].best) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "마감 실패" });
  }
}
app.post("/close-week", handleCloseWeek);
app.get("/close-week", handleCloseWeek);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Ranking API listening on " + PORT));
