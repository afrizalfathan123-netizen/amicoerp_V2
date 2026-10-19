-- ============================================================================
-- 011: uang kembali dari vendor (seperti Credit Note + Register Payment di Odoo).
-- (008 dicadangkan untuk 008_kas_operasional.sql yang belum digabung.)
--
-- Kejadian: uang jalan sudah dibayar ke vendor / driver, lalu dikembalikan (trip tidak jadi jalan, atau hanya terpakai sebagian).
--   1. NOTA KREDIT VENDOR (NKV/YYYY/NNNN) = account_move in_invoice dengan credit_note_of = pengajuan asal dan fase yang sama,
--      barisnya MINUS per job (credit_of_line_id = baris pengajuan asal). "Sudah diajukan" job berkurang lewat view yang ada.
--   2. UANG KEMBALI (RFD/YYYY/NNNN) = account_payment outbound bernilai MINUS pada nota kredit itu, ke rekening yang dipilih.
--      "Dibayar" job berkurang; pengajuan asal tetap lunas, nota kredit juga tutup (dibayar = nominalnya).
-- Data lama tidak berubah. Batal bayar (salah transfer) tetap memakai reversed_payment_id seperti sebelumnya.
-- ============================================================================
alter table account_move add column credit_note_of integer references account_move(id);
create index account_move_credit_note_of_idx on account_move (credit_note_of) where credit_note_of is not null;

-- baris nota kredit bernilai minus (baris dokumen lain tetap dijaga positif oleh aplikasi)
alter table account_move_line drop constraint account_move_line_amount_check;
alter table account_move_line add constraint account_move_line_amount_check check (amount <> 0);
alter table account_move_line add column credit_of_line_id integer references account_move_line(id);
create index account_move_line_credit_of_idx on account_move_line (credit_of_line_id) where credit_of_line_id is not null;

-- Jurnal kas: uang kembali dari vendor tampil sebagai MASUK (nominal positif) supaya cocok dengan mutasi bank;
-- pembalik uang kembali tampil sebagai MASUK minus. Kolom sama dengan sebelumnya.
create or replace view v_cash_ledger as
select pl.id, p.pay_date as tanggal, j.id as job_id, j.job_number,
       case when m.credit_note_of is not null then 'MASUK'
            when p.payment_type = 'inbound' then 'MASUK' else 'KELUAR' end as arah,
       case when m.credit_note_of is not null then 'UANG KEMBALI'
            when ml.job_line_id is null then 'TANPA TUJUAN'
            when jl.side = 'PURCHASE' and pr.kind <> 'TRUCKING' then pr.kind
            when m.phase = 'DP' then 'DP' when m.phase = 'SETTLEMENT' then 'PELUNASAN'
            when m.phase = 'FULL' then 'FULL' else pr.kind end as jenis,
       case when ml.job_line_id is null then null
            when m.phase = 'FULL' or x.scheme = 'FULL' then 100
            when x.scheme = '50_50' then 50
            when m.phase = 'DP' then 70 else 30 end as porsi,
       coalesce(pl.actual_payee_name, payee.name, ml.payee_holder, cust.name) as pihak,
       (case when m.credit_note_of is not null then -pl.amount else pl.amount end)::numeric(15, 2) as nominal,
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
