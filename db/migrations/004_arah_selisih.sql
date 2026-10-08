-- ============================================================================
-- 004: arah selisih dilihat dari kas AMICO
--
--   selisih_kas > 0  SURPLUS: uang di AMICO lebih dari seharusnya
--                    (kurang transfer ke vendor = masih utang; customer lebih tagih yang sudah dibayar = utang ke customer)
--   selisih_kas < 0  MINUS:   uang di AMICO kurang dari seharusnya
--                    (customer kurang bayar = piutang; vendor lebih dibayar = piutang ke vendor)
--   Bagian yang belum dibayar belum mengubah kas: selisih_kas hanya dari yang sudah dibayar.
-- ============================================================================

create or replace view v_kurang_transfer as
with pp as materialized (select * from v_job_phase_position),
k as (
  select job_id, side, max(dp_pct) as dp_pct, max(base_gross) as base_gross, sum(planned) as seharusnya,
         coalesce(sum(paid) filter (where phase = 'DP'), 0) as dp_dibayar,
         coalesce(sum(paid) filter (where phase = 'SETTLEMENT'), 0) as pelunasan_dibayar,
         coalesce(sum(outstanding), 0) as masih_terbuka
  from pp where scheme <> 'FULL' and phase in ('DP', 'SETTLEMENT')
  group by job_id, side
),
k2 as (
  select k.*, round(k.base_gross * k.dp_pct) as dp_seharusnya, k.seharusnya - k.dp_dibayar - k.pelunasan_dibayar as kurang
  from k
  where k.pelunasan_dibayar > 0 and k.masih_terbuka = 0 and k.seharusnya - k.dp_dibayar - k.pelunasan_dibayar > 1
)
select j.id as job_id, j.job_number, j.job_date, c.name as customer, k2.side,
       k2.seharusnya, k2.dp_seharusnya, k2.dp_dibayar, k2.seharusnya - k2.dp_seharusnya as pelunasan_seharusnya, k2.pelunasan_dibayar,
       least(greatest(k2.dp_seharusnya - k2.dp_dibayar, 0), k2.kurang) as dp_kurang,
       k2.kurang - least(greatest(k2.dp_seharusnya - k2.dp_dibayar, 0), k2.kurang) as pelunasan_kurang,
       k2.kurang,
       case when k2.side = 'PURCHASE' then k2.kurang else -k2.kurang end as selisih_kas
from k2
join job j on j.id = k2.job_id
join res_partner c on c.id = j.customer_id;

create or replace view v_unassigned as
select ml.id as move_line_id, ml.move_id, m.number, m.move_type, m.phase, m.move_date,
       ml.job_id, j.job_number, j.customer_id, c.name as customer,
       case when m.move_type = 'out_invoice' then m.partner_id else ml.payee_partner_id end as partner_id,
       coalesce(pt.name, ml.payee_holder, c.name) as partner,
       ml.amount, coalesce(pl.paid, 0) as paid, ml.amount - coalesce(pl.paid, 0) as unpaid,
       ml.description, coalesce(ml.resolution, 'OPEN') as status, ml.resolution_note, ml.resolved_at, ru.display_name as resolved_by_name,
       case when m.move_type = 'out_invoice' then coalesce(pl.paid, 0) else -coalesce(pl.paid, 0) end as selisih_kas
from account_move_line ml
join account_move m on m.id = ml.move_id and m.state = 'posted'
join job j on j.id = ml.job_id
join res_partner c on c.id = j.customer_id
left join res_partner pt on pt.id = case when m.move_type = 'out_invoice' then m.partner_id else ml.payee_partner_id end
left join (select move_line_id, sum(amount) as paid from account_payment_line group by move_line_id) pl on pl.move_line_id = ml.id
left join app_user ru on ru.id = ml.resolved_by
where ml.job_line_id is null and ml.cancelled_at is null;
