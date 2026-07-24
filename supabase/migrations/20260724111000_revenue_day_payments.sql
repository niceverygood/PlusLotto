-- 매출 캘린더 일자 클릭 → 결제내역(현장 피드백 7/24) — admin_revenue_calendar 와 동일 스코프.
create or replace function admin_revenue_day_payments(p_day date)
returns jsonb
language sql stable security invoker set search_path = public as $$
with ctx as (
  select (select app_role())::text as role
), scoped_members as materialized (
  select m.id, m.user_id
  from members m, ctx c
  where c.role in ('admin','manager','leader')
)
select coalesce(jsonb_agg(jsonb_build_object(
  'id', p.id,
  'depositorName', p.depositor_name,
  'memberUserId', m.user_id,
  'staffName', s.name,
  'method', p.method,
  'productName', pr.name,
  'amount', p.amount
) order by p.amount desc), '[]'::jsonb)
from payments p
join scoped_members m on m.id = p.member_id
left join staff s on s.id = p.staff_id
left join products pr on pr.id = p.product_id
where p.status::text = 'approved'
  and (coalesce(p.paid_at, p.created_at) at time zone 'Asia/Seoul')::date = p_day;
$$;

revoke execute on function admin_revenue_day_payments(date) from public, anon;
grant execute on function admin_revenue_day_payments(date) to authenticated;
