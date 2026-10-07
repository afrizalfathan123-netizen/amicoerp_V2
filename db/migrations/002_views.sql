-- ============================================================================
-- View: semua saldo dihitung dari dokumen + pembayaran, tidak disimpan.
--
--   v_move_status          total, terbayar, sisa per dokumen
--   v_job_line_status      per baris order: sudah ditagih/diajukan, sudah dibayar
--   v_job_balance          rekap uang per job
--   v_cash_ledger          JURNAL KAS: 1 baris = 1 kali uang masuk/keluar untuk 1 job
--   v_job_phase_position   per job x sisi x fase (DP 70 / pelunasan 30 / full 100 / calo-lain)
--   v_kurang_transfer      job 70/30 yang pelunasannya sudah dibayar tapi totalnya kurang
--   v_utang_piutang        format sheet UTANG PIUTANG finance (JOB REGISTRATION)
--   v_aging                umur dokumen belum lunas (Aged Receivable / Payable)
--   v_titipan_operasional  transfer malam: dana di kas operasional yang belum disalurkan ke vendor
--   v_bank_balance         saldo per rekening AMICO (dari pembayaran + transfer internal)
--   v_tracker              status perjalanan job + SLA
--
-- Aturan:
--   - Sisi customer: semua selling (trucking + selling tambahan) ditagih bertahap DP 70% lalu pelunasan.
--   - Sisi vendor: DP / pelunasan / FULL untuk baris TRUCKING; calo, tol, dll = fase OTHER.
--   - Selling setelah pajak = selling x (1 - PPh% + PPN%) customer; job.selling_after_tax mengganti kalau diisi.
--   - Job batal (state cancelled) tidak dihitung. Baris dokumen batal (cancelled_at) tidak dihitung.
-- ============================================================================

create view v_move_status as
select m.id as move_id,
       coalesce(sum(ml.amount) filter (where ml.cancelled_at is null), 0) as amount_total,
       coalesce(sum(pl.paid), 0) as amount_paid,
       coalesce(sum(ml.amount) filter (where ml.cancelled_at is null), 0) - coalesce(sum(pl.paid), 0) as amount_residual
from account_move m
left join account_move_line ml on ml.move_id = m.id
left join (select move_line_id, sum(amount) as paid from account_payment_line group by move_line_id) pl
  on pl.move_line_id = ml.id
group by m.id;

create view v_job_line_status as
select jl.id as job_line_id, jl.job_id, jl.side, p.kind, jl.amount, jl.description, jl.partner_id, jl.partner_bank_id,
       coalesce(b.billed, 0) as billed,
       coalesce(b.paid, 0) as paid
from job_line jl
join product p on p.id = jl.product_id
left join (
  select ml.job_line_id,
         sum(ml.amount) filter (where m.state = 'posted' and ml.cancelled_at is null) as billed,
         sum(coalesce(pl.paid, 0)) as paid
  from account_move_line ml
  join account_move m on m.id = ml.move_id
  left join (select move_line_id, sum(amount) as paid from account_payment_line group by move_line_id) pl
    on pl.move_line_id = ml.id
  group by ml.job_line_id
) b on b.job_line_id = jl.id;

create view v_job_balance as
select j.id as job_id, j.job_number,
       coalesce(sum(s.amount) filter (where s.side = 'SALE'), 0) as selling,
       coalesce(sum(s.amount) filter (where s.side = 'PURCHASE'), 0) as cost,
       coalesce(sum(s.amount) filter (where s.side = 'PURCHASE' and s.kind = 'TRUCKING'), 0) as cost_trucking,
       coalesce(sum(s.billed) filter (where s.side = 'SALE'), 0) as invoiced,
       coalesce(sum(s.paid) filter (where s.side = 'SALE'), 0) as received,
       coalesce(sum(s.billed) filter (where s.side = 'PURCHASE'), 0) as requested,
       coalesce(sum(s.paid) filter (where s.side = 'PURCHASE'), 0) as paid
from job j
left join v_job_line_status s on s.job_id = j.id
group by j.id, j.job_number;

create view v_cash_ledger as
select pl.id, p.pay_date as tanggal, j.id as job_id, j.job_number,
       case p.payment_type when 'inbound' then 'MASUK' else 'KELUAR' end as arah,
       case when jl.side = 'PURCHASE' and pr.kind <> 'TRUCKING' then pr.kind
            when m.phase = 'DP_70' then 'DP' when m.phase = 'SETTLEMENT_30' then 'PELUNASAN'
            when m.phase = 'FULL' then 'FULL' else pr.kind end as jenis,
       case m.phase when 'DP_70' then 70 when 'SETTLEMENT_30' then 30 when 'FULL' then 100
            else case j.payment_scheme when 'FULL' then 100 else 30 end end as porsi,
       coalesce(pl.actual_payee_name, payee.name, ml.payee_holder, cust.name) as pihak,
       pl.amount as nominal,
       p.number as payment_number, m.number as move_number, m.payment_channel,
       ba.name as rekening,
       rp.number as membalik
from account_payment_line pl
join account_payment p on p.id = pl.payment_id
join account_move_line ml on ml.id = pl.move_line_id
join account_move m on m.id = ml.move_id
join job_line jl on jl.id = ml.job_line_id
join product pr on pr.id = jl.product_id
join job j on j.id = pl.job_id
left join res_partner payee on payee.id = ml.payee_partner_id
left join res_partner cust on cust.id = m.partner_id
left join res_bank_account ba on ba.id = p.bank_account_id
left join account_payment rp on rp.id = p.reversed_payment_id;

-- Posisi per fase. Rencana:
--   DP_70         = DP yang sudah ditagih/diajukan, atau 70% dari dasar (selling kotor / trucking)
--   SETTLEMENT_30 = dasar bersih (selling setelah pajak / trucking) - rencana DP
--   FULL          = dasar bersih (job skema 100%)
--   OTHER         = calo, tol, parkir, bongkar, lainnya, selisih (sisi vendor)
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
select j.id as job_id, j.job_number, j.job_date, j.customer_id, c.name as customer, j.payment_scheme,
       l.side, r.phase, r.base_gross, r.planned,
       coalesce(mv.billed, 0) as billed,
       coalesce(mv.paid, 0) as paid,
       greatest(r.planned - coalesce(mv.billed, 0), 0) as not_billed,
       coalesce(mv.billed, 0) - coalesce(mv.paid, 0) as outstanding,
       greatest(r.planned - coalesce(mv.billed, 0), 0) + coalesce(mv.billed, 0) - coalesce(mv.paid, 0) as unpaid
from job j
join res_partner c on c.id = j.customer_id
join line_sum l on l.job_id = j.id
left join moved dp on dp.job_id = j.id and dp.side = l.side and dp.phase = 'DP_70'
cross join lateral (
  select case when l.side = 'SALE'
              then coalesce(j.selling_after_tax, round(l.base * (1 - c.pph_pct / 100 + c.ppn_pct / 100)))
              else l.base end as base_net,
         coalesce(nullif(dp.billed, 0), round(l.base * 0.7)) as dp_plan
) p
cross join lateral (values
  ('DP_70',         l.base,  case when j.payment_scheme = '70_30' then p.dp_plan end),
  ('SETTLEMENT_30', l.base,  case when j.payment_scheme = '70_30' then greatest(p.base_net - p.dp_plan, 0) end),
  ('FULL',          l.base,  case when j.payment_scheme = 'FULL' then p.base_net end),
  ('OTHER',         l.other, case when l.other > 0 then l.other end)
) as r(phase, base_gross, planned)
left join moved mv on mv.job_id = j.id and mv.side = l.side and mv.phase = r.phase
where j.state <> 'cancelled' and r.planned is not null;

-- Kurang transfer (skema 70/30): pelunasan sudah dibayar, tidak ada DP/pelunasan yang masih terbuka,
-- tapi DP + pelunasan yang dibayar lebih kecil dari seharusnya.
--   PURCHASE = AMICO kurang transfer ke vendor,  SALE = customer kurang bayar ke AMICO
create view v_kurang_transfer as
with pp as materialized (
  select * from v_job_phase_position
  where payment_scheme = '70_30' and phase in ('DP_70', 'SETTLEMENT_30')
),
k as (
  select job_id, side, max(base_gross) as base_gross, sum(planned) as seharusnya,
         coalesce(sum(paid) filter (where phase = 'DP_70'), 0) as dp_dibayar,
         coalesce(sum(paid) filter (where phase = 'SETTLEMENT_30'), 0) as pelunasan_dibayar,
         coalesce(sum(outstanding), 0) as masih_terbuka
  from pp group by job_id, side
),
k2 as (
  select k.*, round(k.base_gross * 0.7) as dp_seharusnya, k.seharusnya - k.dp_dibayar - k.pelunasan_dibayar as kurang
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

-- Format kolom sheet UTANG PIUTANG finance (UTANG / BELUM = sisa belum dibayar, 0 setelah lunas).
-- Angkanya sisa sebenarnya; rumus Excel yang salah tidak ditiru.
create view v_utang_piutang as
with pp as materialized (select * from v_job_phase_position),
side_70_30 as (
  select job_id, side, sum(planned) - sum(paid) as kurang,
         sum(paid) filter (where phase = 'SETTLEMENT_30') as pelunasan_dibayar,
         sum(outstanding) as masih_terbuka
  from pp where payment_scheme = '70_30' and phase in ('DP_70', 'SETTLEMENT_30')
  group by job_id, side
),
kt as (
  select job_id, sum(kurang) filter (where side = 'PURCHASE') as vendor, sum(kurang) filter (where side = 'SALE') as customer
  from side_70_30 where pelunasan_dibayar > 0 and masih_terbuka = 0 and kurang > 1
  group by job_id
),
agg as (
  select job_id,
         sum(planned) filter (where side = 'SALE' and phase <> 'OTHER')                                       as selling_net,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'FULL')                                       as utang_100,
         sum(paid) filter (where side = 'PURCHASE' and payment_scheme = 'FULL')                                as utang_100_terbayar,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'DP_70')                                      as utang_70,
         sum(paid) filter (where side = 'PURCHASE' and phase = 'DP_70')                                        as utang_70_terbayar,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'SETTLEMENT_30')                              as utang_30_belum_bayar,
         sum(paid) filter (where side = 'PURCHASE' and payment_scheme = '70_30' and phase in ('SETTLEMENT_30', 'OTHER')) as utang_30_terbayar,
         sum(unpaid) filter (where side = 'SALE' and phase = 'FULL')                                           as piutang_100_belum_terbayar,
         sum(paid) filter (where side = 'SALE' and payment_scheme = 'FULL')                                    as piutang_100_terbayar,
         sum(not_billed) filter (where side = 'SALE' and phase = 'DP_70')                                      as piutang_70_belum_tertagih,
         sum(outstanding) filter (where side = 'SALE' and phase = 'DP_70')                                     as piutang_70_tertagih,
         sum(paid) filter (where side = 'SALE' and phase = 'DP_70')                                            as piutang_70_terbayar,
         sum(not_billed) filter (where side = 'SALE' and phase = 'SETTLEMENT_30')                              as piutang_30_belum_tertagih,
         sum(outstanding) filter (where side = 'SALE' and phase = 'SETTLEMENT_30')                             as piutang_30_tertagih,
         sum(paid) filter (where side = 'SALE' and phase = 'SETTLEMENT_30')                                    as piutang_30_terbayar,
         sum(paid) filter (where side = 'PURCHASE' and phase = 'OTHER')                                        as calo_lain_terbayar,
         sum(unpaid) filter (where side = 'PURCHASE' and phase = 'OTHER')                                      as calo_lain_belum_bayar
  from pp group by job_id
)
select j.id as job_id, j.job_number, j.do_number, c.name as customer,
       concat(lp.code, ' - ', ld.code, case when j.trip_type = 'ROUND_TRIP' then ' PP' else '' end, ' / ', coalesce(j.plate_number, '')) as keterangan,
       j.payment_scheme,
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

create view v_aging as
select m.id as move_id, m.number, m.move_type, m.phase, m.move_date, m.partner_id,
       case when m.move_type = 'out_invoice' then c.name
            else (select string_agg(distinct coalesce(pp.name, ml.payee_holder), ', ')
                  from account_move_line ml left join res_partner pp on pp.id = ml.payee_partner_id
                  where ml.move_id = m.id and ml.cancelled_at is null) end as partner,
       (now() at time zone 'Asia/Jakarta')::date - m.move_date as age_days,
       s.amount_total, s.amount_paid, s.amount_residual as residual
from account_move m
join v_move_status s on s.move_id = m.id
left join res_partner c on c.id = m.partner_id
where m.state = 'posted' and s.amount_residual > 0;

-- Transfer malam: dana pengajuan yang sudah dikirim ke kas operasional tapi belum disalurkan ke vendor.
create view v_titipan_operasional as
with dana as (
  select t.move_id,
         sum(case when ta.kind = 'OPERATIONAL' then t.amount else 0 end)
         - sum(case when fa.kind = 'OPERATIONAL' then t.amount else 0 end) as dana_masuk,
         max(t.transfer_date) as tanggal_dana
  from internal_transfer t
  join res_bank_account ta on ta.id = t.to_account_id
  join res_bank_account fa on fa.id = t.from_account_id
  where t.move_id is not null
  group by t.move_id
),
salur as (
  select p.move_id, sum(p.amount) as disalurkan
  from account_payment p join res_bank_account a on a.id = p.bank_account_id and a.kind = 'OPERATIONAL'
  group by p.move_id
)
select m.id as move_id, m.number, m.move_date, d.tanggal_dana,
       d.dana_masuk, coalesce(s.disalurkan, 0) as disalurkan, d.dana_masuk - coalesce(s.disalurkan, 0) as titipan,
       st.amount_residual as sisa_pengajuan
from account_move m
join dana d on d.move_id = m.id
left join salur s on s.move_id = m.id
join v_move_status st on st.move_id = m.id;

-- Saldo per rekening AMICO: uang masuk/keluar dari pembayaran + transfer internal.
create view v_bank_balance as
select a.id as bank_account_id, a.name, a.kind, a.bank_name, a.account_number,
       coalesce(pin.amount, 0) as diterima_customer,
       coalesce(pout.amount, 0) as dibayar_ke_vendor,
       coalesce(tin.amount, 0) as transfer_masuk,
       coalesce(tout.amount, 0) as transfer_keluar,
       coalesce(pin.amount, 0) - coalesce(pout.amount, 0) + coalesce(tin.amount, 0) - coalesce(tout.amount, 0) as mutasi_bersih
from res_bank_account a
left join (select bank_account_id, sum(amount) as amount from account_payment where payment_type = 'inbound' group by 1) pin on pin.bank_account_id = a.id
left join (select bank_account_id, sum(amount) as amount from account_payment where payment_type = 'outbound' group by 1) pout on pout.bank_account_id = a.id
left join (select to_account_id, sum(amount) as amount from internal_transfer group by 1) tin on tin.to_account_id = a.id
left join (select from_account_id, sum(amount) as amount from internal_transfer group by 1) tout on tout.from_account_id = a.id;

-- Tracker: status perjalanan job + SLA rute
create view v_tracker as
select j.id as job_id, j.job_number, j.job_date, c.name as customer, lp.code as pol, ld.code as pod, j.trip_type,
       j.truck_type, j.plate_number, j.driver1_name, j.driver1_phone, j.delivery_scope, j.rit_number,
       j.gate_out_at, j.gate_in_at,
       case when j.gate_out_at is null then 'BELUM BERANGKAT'
            when j.gate_in_at is null then 'DALAM PERJALANAN'
            else 'SELESAI' end as trip_status,
       round((extract(epoch from (coalesce(j.gate_in_at, now()) - j.gate_out_at)) / 3600)::numeric, 1) as durasi_jam,
       s.sla_hours,
       case when j.gate_out_at is null or s.sla_hours is null then null
            else extract(epoch from (coalesce(j.gate_in_at, now()) - j.gate_out_at)) / 3600 > s.sla_hours end as lewat_sla,
       u.at as update_terakhir_at, u.location as posisi_terakhir
from job j
join res_partner c on c.id = j.customer_id
join location lp on lp.id = j.pol_id
join location ld on ld.id = j.pod_id
left join route_sla s on s.pol_id = j.pol_id and s.pod_id = j.pod_id and s.trip_type = j.trip_type
left join lateral (select at, location from trip_update tu where tu.job_id = j.id order by at desc limit 1) u on true
where j.state <> 'cancelled';
