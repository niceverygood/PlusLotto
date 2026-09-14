-- 검수자가 운영용으로 확정한 815 계정을 운영 회원 목록에서 제외하기 전 원문 보관한다.
-- 복구용 내부 저장소이며 앱/API/서비스 키로 조회하거나 수정할 수 없다.
CREATE SCHEMA IF NOT EXISTS private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.legacy815_operator_archive (
  run_id text NOT NULL CHECK (length(btrim(run_id)) > 0),
  source_table text NOT NULL CHECK (source_table IN (
    'members', 'payments', 'assignments',
    'legacy_member_memos', 'legacy_member_sms', 'legacy_member_wins'
  )),
  record_key text NOT NULL CHECK (length(btrim(record_key)) > 0),
  member_id text NOT NULL CHECK (length(btrim(member_id)) > 0),
  row_data jsonb NOT NULL CHECK (jsonb_typeof(row_data) = 'object'),
  row_md5 text NOT NULL CHECK (row_md5 ~ '^[0-9a-f]{32}$' AND row_md5 = md5(row_data::text)),
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_table, record_key)
);
ALTER TABLE private.legacy815_operator_archive OWNER TO postgres;
ALTER TABLE private.legacy815_operator_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.legacy815_operator_archive FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE private.legacy815_operator_archive IS
  'Postgres-only reversible archive of reviewer-confirmed 815 operator records; no application access or public RPC.';
