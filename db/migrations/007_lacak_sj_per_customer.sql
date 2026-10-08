-- ============================================================================
-- 007: "Lacak SJ" per customer. Customer tanpa SJ fisik lewat kurir (mis. pengiriman dalam kota) dimatikan:
-- status SJ kosong, tahap Menunggu SJ / Kirim SJ dilewati, tidak dihitung terlambat.
-- ============================================================================
alter table res_partner add column sj_tracking boolean not null default true;

create or replace view v_job_status as
with pos as materialized (
  select job_id, side,
         sum(planned) filter (where phase <> 'OTHER') as planned,
         sum(billed) filter (where phase <> 'OTHER') as billed,
         sum(paid) filter (where phase <> 'OTHER') as paid,
         sum(unpaid) as unpaid_all
  from v_job_phase_position group by job_id, side
),
cfg as (
  select coalesce(nullif(max(value #>> '{}') filter (where key = 'sj_target_resi_days'), ''), '2')::int as t_resi,
         coalesce(nullif(max(value #>> '{}') filter (where key = 'sj_target_kurir_days'), ''), '4')::int as t_kurir,
         coalesce(nullif(max(value #>> '{}') filter (where key = 'sj_target_kirim_days'), ''), '3')::int as t_kirim
  from app_setting
),
base as (
  select j.id as job_id, j.state, j.gate_out_at, j.gate_in_at,
         (j.gate_in_at at time zone 'Asia/Jakarta')::date as gate_in_date,
         j.sj_resi_number, j.sj_resi_received_at, j.sj_received_at, j.sj_delivered_at,
         (now() at time zone 'Asia/Jakarta')::date as today,
         case when j.gate_out_at is null then 'BELUM_BERANGKAT' when j.gate_in_at is null then 'JALAN' else 'SAMPAI' end as trip_status,
         case when j.gate_in_at is null or not cu.sj_tracking then null
              when j.sj_delivered_at is not null then 'DIKIRIM'
              when j.sj_received_at is not null then 'DITERIMA'
              when j.sj_resi_number is not null or j.sj_resi_received_at is not null then 'DI_KURIR'
              else 'BELUM_ADA_RESI' end as sj_status,
         case when coalesce(s.planned, 0) <= 0 then 'TANPA_TAGIHAN'
              when coalesce(s.billed, 0) <= 0 then 'BELUM'
              when s.billed + 1 < s.planned then 'SEBAGIAN'
              when s.paid + 1 < s.planned then 'MENUNGGU_BAYAR'
              else 'LUNAS' end as customer_status,
         case when coalesce(p.planned, 0) <= 0 and coalesce(p.unpaid_all, 0) <= 0 then 'TANPA_TAGIHAN'
              when coalesce(p.billed, 0) <= 0 then 'BELUM'
              when p.billed + 1 < p.planned then 'SEBAGIAN'
              when coalesce(p.unpaid_all, 0) > 1 then 'MENUNGGU_BAYAR'
              else 'LUNAS' end as vendor_status
  from job j
  join res_partner cu on cu.id = j.customer_id
  left join pos s on s.job_id = j.id and s.side = 'SALE'
  left join pos p on p.job_id = j.id and p.side = 'PURCHASE'
)
select b.job_id, b.trip_status, b.sj_status, b.customer_status, b.vendor_status,
       case when b.state = 'cancelled' then 'BATAL'
            when b.trip_status = 'BELUM_BERANGKAT' then 'RENCANA'
            when b.trip_status = 'JALAN' then 'JALAN'
            when b.sj_status in ('BELUM_ADA_RESI', 'DI_KURIR') then 'MENUNGGU_SJ'
            when b.customer_status in ('BELUM', 'SEBAGIAN') then 'SIAP_TAGIH'
            when b.sj_status in ('DITERIMA') then 'KIRIM_SJ'
            when b.customer_status = 'MENUNGGU_BAYAR' or b.vendor_status in ('BELUM', 'SEBAGIAN', 'MENUNGGU_BAYAR') then 'MENUNGGU_BAYAR'
            else 'SELESAI' end as stage,
       -- lead time SJ (hari)
       coalesce(b.sj_resi_received_at, case when b.sj_resi_number is not null then b.gate_in_date end) - b.gate_in_date as hari_ke_resi,
       case when b.sj_received_at is not null then b.sj_received_at - b.gate_in_date end as lead_time_sj,
       case when b.sj_status = 'DI_KURIR' then b.today - coalesce(b.sj_resi_received_at, b.gate_in_date)
            when b.sj_received_at is not null and b.sj_resi_received_at is not null then b.sj_received_at - b.sj_resi_received_at end as hari_di_kurir,
       case when b.sj_status = 'DITERIMA' then b.today - b.sj_received_at
            when b.sj_delivered_at is not null and b.sj_received_at is not null then b.sj_delivered_at - b.sj_received_at end as hari_tunggu_kirim,
       case when b.sj_status = 'BELUM_ADA_RESI' and b.today - b.gate_in_date > c.t_resi then 'RESI_TERLAMBAT'
            when b.sj_status = 'DI_KURIR' and b.today - coalesce(b.sj_resi_received_at, b.gate_in_date) > c.t_kurir then 'KURIR_NYANGKUT'
            when b.sj_status = 'DITERIMA' and b.today - b.sj_received_at > c.t_kirim then 'TERLAMBAT_KIRIM' end as sj_late
from base b cross join cfg c;
