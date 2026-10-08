-- ============================================================================
-- 003: skema bayar per sisi + selisih tanpa tujuan
--
-- 1. Skema bayar dipisah: job.customer_scheme (70/30, 50/50, 100%) dan job.vendor_scheme (70/30, 100%).
--    Default per partner di res_partner.payment_scheme. Kolom lama job.payment_scheme dihapus.
-- 2. Fase dokumen dibuat umum: DP_70 -> DP, SETTLEMENT_30 -> SETTLEMENT. Persentase DP ikut skema sisi itu.
-- 3. Selisih tanpa tujuan: baris dokumen (account_move_line) boleh tanpa job_line_id. Uangnya tetap tercatat di
--    dokumen & pembayaran, tapi tidak menambah selling / cost job. Nanti diarahkan: ke baris order job (calo,
--    biaya / selling tambahan), atau dijadikan saldo partner (lebih bayar vendor / lebih tagih customer).
--    Baris SELISIH lama dipindah ke model ini.
-- ============================================================================

drop view if exists v_utang_piutang;
drop view if exists v_kurang_transfer;
drop view if exists v_job_phase_position;
drop view if exists v_cash_ledger;

-- ---------------------------------------------------------------- 1. skema per sisi
alter table job add column customer_scheme text, add column vendor_scheme text;
update job set customer_scheme = payment_scheme, vendor_scheme = payment_scheme;
alter table job
  alter column customer_scheme set not null, alter column customer_scheme set default '70_30',
  alter column vendor_scheme set not null, alter column vendor_scheme set default '70_30',
  add constraint job_customer_scheme_check check (customer_scheme in ('70_30', '50_50', 'FULL')),
  add constraint job_vendor_scheme_check check (vendor_scheme in ('70_30', 'FULL'));
alter table job drop column payment_scheme;

-- kosong = ikut lingkup job (dalam kota 100%, antar kota 70/30). Vendor hanya 70/30 atau 100%.
alter table res_partner add column payment_scheme text
  check (payment_scheme is null or payment_scheme in ('70_30', '50_50', 'FULL'));

-- ---------------------------------------------------------------- 2. fase umum
alter table account_move drop constraint account_move_phase_check;
update account_move set phase = 'DP' where phase = 'DP_70';
update account_move set phase = 'SETTLEMENT' where phase = 'SETTLEMENT_30';
alter table account_move add constraint account_move_phase_check check (phase in ('DP', 'SETTLEMENT', 'FULL', 'OTHER'));

-- ---------------------------------------------------------------- 3. selisih tanpa tujuan
alter table account_move_line alter column job_line_id drop not null;
alter table account_move_line
  add column resolution text check (resolution is null or resolution = 'PARTNER_BALANCE'),
  add column resolution_note text,
  add column resolved_at timestamptz,
  add column resolved_by integer references app_user(id),
  add constraint account_move_line_resolution_unassigned_check check (resolution is null or job_line_id is null);

-- baris SELISIH lama -> tanpa tujuan
update account_move_line ml set job_line_id = null,
       description = coalesce(ml.description, 'Selisih') || ' (tanpa tujuan)'
from job_line jl join product p on p.id = jl.product_id
where ml.job_line_id = jl.id and p.kind = 'SELISIH';
delete from job_line jl using product p where p.id = jl.product_id and p.kind = 'SELISIH';

-- ---------------------------------------------------------------- view
create view v_cash_ledger as
select pl.id, p.pay_date as tanggal, j.id as job_id, j.job_number,
       case p.payment_type when 'inbound' then 'MASUK' else 'KELUAR' end as arah,
       case when ml.job_line_id is null then 'TANPA TUJUAN'
            when jl.side = 'PURCHASE' and pr.kind <> 'TRUCKING' then pr.kind
            when m.phase = 'DP' then 'DP' when m.phase = 'SETTLEMENT' then 'PELUNASAN'
            when m.phase = 'FULL' then 'FULL' else pr.kind end as jenis,
       case when ml.job_line_id is null then null
            when m.phase = 'FULL' or x.scheme = 'FULL' then 100
            when x.scheme = '50_50' then 50
            when m.phase = 'DP' then 70 else 30 end as porsi,
       coalesce(pl.actual_payee_name, payee.name, ml.payee_holder, cust.name) as pihak,
       pl.amount as nominal,
       p.number as payment_number, m.number as move_number, m.payment_channel,
       ba.name as rekening,
       rp.number as membalik
from account_payment_line pl
join account_payment p on p.id = pl.payment_id
join account_move_line ml on ml.id = pl.move_line_id
join account_move m on m.id = ml.move_id
left join job_line jl on jl.id = ml.job_line_id
left join product pr on pr.id = jl.product_id
join job j on j.id = pl.job_id
cross join lateral (select case when m.move_type = 'out_invoice' then j.customer_scheme else j.vendor_scheme end as scheme) x
left join res_partner payee on payee.id = ml.payee_partner_id
left join res_partner cust on cust.id = m.partner_id
left join res_bank_account ba on ba.id = p.bank_account_id
left join account_payment rp on rp.id = p.reversed_payment_id;

-- Posisi per fase. Rencana:
--   DP         = DP yang sudah ditagih/diajukan, atau DP% skema x dasar (selling kotor / trucking)
--   SETTLEMENT = dasar bersih (selling setelah pajak / trucking) - rencana DP
--   FULL       = dasar bersih (sisi berskema 100%)
--   OTHER      = calo, tol, parkir, bongkar, lainnya (sisi vendor)
-- Skema per sisi: SALE = job.customer_scheme, PURCHASE = job.vendor_scheme. Baris tanpa tujuan tidak dihitung.
create view v_job_phase_position as
with line_sum as not materialized (
  select jl.job_id, jl.side,
         sum(case when jl.side = 'SALE' or p.kind = 'TRUCKING' then jl.amount else 0 end) as base,
         sum(case when jl.side = 'PURCHASE' and p.kind <> 'TRUCKING' then jl.amount else 0 end) as other
  from job_line jl join product p on p.id = jl.product_id
  group by jl.job_id, jl.side
),
moved as not materialized (
  select ml.job_id, jl.side,
         case when jl.side = 'PURCHASE' and p.kind <> 'TRUCKING' then 'OTHER' else m.phase end as phase,
         sum(ml.amount) as billed,
         sum(coalesce(pl.paid, 0)) as paid
  from account_move_line ml
  join account_move m on m.id = ml.move_id and m.state = 'posted'
  join job_line jl on jl.id = ml.job_line_id
  join product p on p.id = jl.product_id
  left join (select move_line_id, sum(amount) as paid from account_payment_line group by move_line_id) pl
    on pl.move_line_id = ml.id
  where ml.cancelled_at is null
  group by ml.job_id, jl.side, case when jl.side = 'PURCHASE' and p.kind <> 'TRUCKING' then 'OTHER' else m.phase end
)
select j.id as job_id, j.job_number, j.job_date, j.customer_id, c.name as customer, s.scheme, s.dp_pct,
       l.side, r.phase, r.base_gross, r.planned,
       coalesce(mv.billed, 0) as billed,
       coalesce(mv.paid, 0) as paid,
       greatest(r.planned - coalesce(mv.billed, 0), 0) as not_billed,
       coalesce(mv.billed, 0) - coalesce(mv.paid, 0) as outstanding,
       greatest(r.planned - coalesce(mv.billed, 0), 0) + coalesce(mv.billed, 0) - coalesce(mv.paid, 0) as unpaid
from job j
join res_partner c on c.id = j.customer_id
join line_sum l on l.job_id = j.id
cross join lateral (
  select x.scheme, case x.scheme when '70_30' then 0.7 when '50_50' then 0.5 end as dp_pct
  from (select case when l.side = 'SALE' then j.customer_scheme else j.vendor_scheme end as scheme) x
) s
left join moved dp on dp.job_id = j.id and dp.side = l.side and dp.phase = 'DP'
cross join lateral (
  select case when l.side = 'SALE'
              then coalesce(j.selling_after_tax, round(l.base * (1 - c.pph_pct / 100 + c.ppn_pct / 100)))
              else l.base end as base_net,
         coalesce(nullif(dp.billed, 0), round(l.base * s.dp_pct)) as dp_plan
) p
cross join lateral (values
  ('DP',         l.base,  case when s.scheme <> 'FULL' then p.dp_plan end),
  ('SETTLEMENT', l.base,  case when s.scheme <> 'FULL' then greatest(p.base_net - p.dp_plan, 0) end),
  ('FULL',       l.base,  case when s.scheme = 'FULL' then p.base_net end),
  ('OTHER',      l.other, case when l.other > 0 then l.other end)
) as r(phase, base_gross, planned)
left join moved mv on mv.job_id = j.id and mv.side = l.side and mv.phase = r.phase
where j.state <> 'cancelled' and r.planned is not null;

-- Kurang transfer (skema DP + pelunasan): pelunasan sudah dibayar, tidak ada DP/pelunasan yang masih terbuka,
-- tapi DP + pelunasan yang dibayar lebih kecil dari seharusnya.
--   PURCHASE = AMICO kurang transfer ke vendor,  SALE = customer kurang bayar ke AMICO
create view v_kurang_transfer as
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
       k2.kurang
from k2
join job j on j.id = k2.job_id
join res_partner c on c.id = j.customer_id;

-- Format kolom sheet UTANG PIUTANG finance. Kolom *_70 = fase DP, *_30 = fase pelunasan (50/50 ikut kolom ini juga).
create view v_utang_piutang as
with pp as materialized (select * from v_job_phase_position),
side_split as (
  select job_id, side, sum(planned) - sum(paid) as kurang,
         sum(paid) filter (where phase = 'SETTLEMENT') as pelunasan_dibayar,
         sum(outstanding) as masih_terbuka
  from pp where scheme <> 'FULL' and phase in ('DP', 'SETTLEMENT')
  group by job_id, side
),
kt as (
  select job_id, sum(kurang) filter (where side = 'PURCHASE') as vendor, sum(kurang) filter (where side = 'SALE') as customer
  from side_split where pelunasan_dibayar > 0 and masih_terbuka = 0 and kurang > 1
  group by job_id
),
agg as (
  select job_id,
         sum(planned) filter (where side = 'SALE' and phase <> 'OTHER')                                       as selling_net,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'FULL')                                       as utang_100,
         sum(paid) filter (where side = 'PURCHASE' and scheme = 'FULL')                                        as utang_100_terbayar,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'DP')                                         as utang_70,
         sum(paid) filter (where side = 'PURCHASE' and phase = 'DP')                                           as utang_70_terbayar,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'SETTLEMENT')                                 as utang_30_belum_bayar,
         sum(paid) filter (where side = 'PURCHASE' and scheme <> 'FULL' and phase in ('SETTLEMENT', 'OTHER'))  as utang_30_terbayar,
         sum(unpaid) filter (where side = 'SALE' and phase = 'FULL')                                           as piutang_100_belum_terbayar,
         sum(paid) filter (where side = 'SALE' and scheme = 'FULL')                                            as piutang_100_terbayar,
         sum(not_billed) filter (where side = 'SALE' and phase = 'DP')                                         as piutang_70_belum_tertagih,
         sum(outstanding) filter (where side = 'SALE' and phase = 'DP')                                        as piutang_70_tertagih,
         sum(paid) filter (where side = 'SALE' and phase = 'DP')                                               as piutang_70_terbayar,
         sum(not_billed) filter (where side = 'SALE' and phase = 'SETTLEMENT')                                 as piutang_30_belum_tertagih,
         sum(outstanding) filter (where side = 'SALE' and phase = 'SETTLEMENT')                                as piutang_30_tertagih,
         sum(paid) filter (where side = 'SALE' and phase = 'SETTLEMENT')                                       as piutang_30_terbayar,
         sum(paid) filter (where side = 'PURCHASE' and phase = 'OTHER')                                        as calo_lain_terbayar,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'OTHER')                                      as calo_lain_belum_bayar
  from pp group by job_id
)
select j.id as job_id, j.job_number, j.do_number, c.name as customer,
       concat(lp.code, ' - ', ld.code, case when j.trip_type = 'ROUND_TRIP' then ' PP' else '' end, ' / ', coalesce(j.plate_number, '')) as keterangan,
       j.customer_scheme, j.vendor_scheme,
       coalesce(a.selling_net, 0) as selling_net,
       coalesce(a.utang_100, 0) as utang_100, coalesce(a.utang_100_terbayar, 0) as utang_100_terbayar,
       coalesce(a.utang_70, 0) as utang_70, coalesce(a.utang_70_terbayar, 0) as utang_70_terbayar,
       coalesce(a.utang_30_belum_bayar, 0) as utang_30_belum_bayar, coalesce(a.utang_30_terbayar, 0) as utang_30_terbayar,
       coalesce(a.piutang_100_belum_terbayar, 0) as piutang_100_belum_terbayar, coalesce(a.piutang_100_terbayar, 0) as piutang_100_terbayar,
       coalesce(a.piutang_70_belum_tertagih, 0) as piutang_70_belum_tertagih, coalesce(a.piutang_70_tertagih, 0) as piutang_70_tertagih,
       coalesce(a.piutang_70_terbayar, 0) as piutang_70_terbayar,
       coalesce(a.piutang_30_belum_tertagih, 0) as piutang_30_belum_tertagih, coalesce(a.piutang_30_tertagih, 0) as piutang_30_tertagih,
       coalesce(a.piutang_30_terbayar, 0) as piutang_30_terbayar,
       coalesce(a.calo_lain_terbayar, 0) as calo_lain_terbayar, coalesce(a.calo_lain_belum_bayar, 0) as calo_lain_belum_bayar,
       coalesce(kt.vendor, 0) as kurang_transfer_vendor, coalesce(kt.customer, 0) as kurang_bayar_customer
from job j
join res_partner c on c.id = j.customer_id
join location lp on lp.id = j.pol_id
join location ld on ld.id = j.pod_id
left join agg a on a.job_id = j.id
left join kt on kt.job_id = j.id
where j.state <> 'cancelled';

-- Selisih tanpa tujuan: baris dokumen posted yang tidak menempel ke baris order job.
--   status OPEN            = belum diarahkan
--   status PARTNER_BALANCE = dijadikan saldo partner (vendor lebih dibayar -> vendor berutang ke AMICO;
--                            customer lebih tagih yang sudah dibayar -> AMICO berutang ke customer)
create view v_unassigned as
select ml.id as move_line_id, ml.move_id, m.number, m.move_type, m.phase, m.move_date,
       ml.job_id, j.job_number, j.customer_id, c.name as customer,
       case when m.move_type = 'out_invoice' then m.partner_id else ml.payee_partner_id end as partner_id,
       coalesce(pt.name, ml.payee_holder, c.name) as partner,
       ml.amount, coalesce(pl.paid, 0) as paid, ml.amount - coalesce(pl.paid, 0) as unpaid,
       ml.description, coalesce(ml.resolution, 'OPEN') as status, ml.resolution_note, ml.resolved_at, ru.display_name as resolved_by_name
from account_move_line ml
join account_move m on m.id = ml.move_id and m.state = 'posted'
join job j on j.id = ml.job_id
join res_partner c on c.id = j.customer_id
left join res_partner pt on pt.id = case when m.move_type = 'out_invoice' then m.partner_id else ml.payee_partner_id end
left join (select move_line_id, sum(amount) as paid from account_payment_line group by move_line_id) pl on pl.move_line_id = ml.id
left join app_user ru on ru.id = ml.resolved_by
where ml.job_line_id is null and ml.cancelled_at is null;
