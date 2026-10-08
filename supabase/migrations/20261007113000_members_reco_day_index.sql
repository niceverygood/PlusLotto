-- 2026-10-07: scheduled weekly-reco scan filters meta->>'weekly_reco_day' = today ordered by id
-- (api/weekly-reco.ts scanMembers dayFilter). Without this index the filtered keyset read still
-- walks every active member and hit statement timeouts (57014). Applied manually in production
-- on 10/7 11:3x KST; IF NOT EXISTS keeps this a no-op there.
create index if not exists members_reco_day_id_idx
on public.members ((meta->>'weekly_reco_day'), id)
where status = 'active' and is_deleted = false and is_withdrawn = false and is_suspended = false;
