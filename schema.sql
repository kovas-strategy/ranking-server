-- =====================================================================
-- 코바스 패치 러너 — 게임 전용 랭킹 DB 스키마
-- =====================================================================
-- ★ 이 SQL은 '게임 전용 DB'에서만 실행하세요.
--   인사데이터가 있는 kovasdb에서는 절대 실행하지 마세요.
--   (Render에서 새 PostgreSQL을 만들고, DBeaver로 그 DB에 접속해 실행)
-- =====================================================================

-- 1) 점수 기록 테이블 ---------------------------------------------------
--    한 판 끝날 때마다 한 줄씩 쌓입니다.
CREATE TABLE IF NOT EXISTS scores (
    id           BIGSERIAL PRIMARY KEY,
    player_name  VARCHAR(20)  NOT NULL,          -- 참여자 이름(닉네임)
    distance     NUMERIC(10,3) NOT NULL,         -- 거리(m), 소수점 3자리
    uv_blocked   INTEGER       NOT NULL DEFAULT 0,-- 막은 자외선 수(검증용)
    wrinkle_filled INTEGER     NOT NULL DEFAULT 0,-- 채운 주름 수(검증용)
    play_seconds NUMERIC(6,2)  NOT NULL DEFAULT 0,-- 플레이 시간(초, 검증용)
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- 주간 집계용: 이 점수가 속한 '주(week)'를 기록 (그 주 토요일 날짜)
    week_start   DATE          NOT NULL
);

-- 조회 성능용 인덱스
CREATE INDEX IF NOT EXISTS idx_scores_week      ON scores (week_start, distance DESC);
CREATE INDEX IF NOT EXISTS idx_scores_distance  ON scores (distance DESC);
CREATE INDEX IF NOT EXISTS idx_scores_created   ON scores (created_at DESC);


-- 2) 역대 주간 위너 테이블 ---------------------------------------------
--    매주 금요일 15시 마감 시, 그 주 1등을 여기에 '박제'합니다.
--    (scores 테이블은 주간 리셋 개념이지만, 위너는 영구 보존)
CREATE TABLE IF NOT EXISTS weekly_winners (
    id           BIGSERIAL PRIMARY KEY,
    generation   INTEGER      NOT NULL,           -- 몇 대 위너인지 (1대, 2대…)
    player_name  VARCHAR(20)  NOT NULL,
    distance     NUMERIC(10,3) NOT NULL,
    week_start   DATE         NOT NULL,           -- 그 주 토요일
    awarded_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_winners_gen ON weekly_winners (generation DESC);


-- =====================================================================
-- 참고: 자주 쓰는 조회 쿼리 (API 서버가 내부적으로 사용)
-- =====================================================================

-- [이번 주 TOP 5]  (:week_start = 이번 주 토요일 날짜)
--   각 사람의 '최고 기록'만 뽑아 상위 5명
--   SELECT player_name, MAX(distance) AS best
--   FROM scores WHERE week_start = :week_start
--   GROUP BY player_name ORDER BY best DESC LIMIT 5;

-- [올타임 챔피언]  (역대 최고 기록 1명)
--   SELECT player_name, distance FROM scores
--   ORDER BY distance DESC LIMIT 1;

-- [역대 주간 위너 목록]
--   SELECT generation, player_name, distance, week_start
--   FROM weekly_winners ORDER BY generation DESC;
