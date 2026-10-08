-- ============================================================================
-- Impor data ERP AMICO lama (skema amico_legacy, lihat staging.sql) ke model ERP AMICO v2.
-- Dipanggil oleh scripts/import-amico.js:  select amico_legacy.run_import();
--
--   customers                        -> res_partner (customer; pajak dari deduct_tax: PPh 2% + PPN 1,1%)
--   transfer_payees, nama penerima   -> res_partner (vendor) + res_partner_bank
--   company_accounts                 -> res_bank_account (BANK); rekening operasional transfer malam -> OPERATIONAL
--   locations, vehicles              -> location, vehicle
--   selling_rates, cost_rates        -> pricelist_item (cost per kendaraan tidak diimpor)
--   jobs (yang tidak diarsipkan)     -> job + job_line (selling_items / selling_amount, cost_items / cost_amount)
--   payment_request_batches + items  -> account_move in_invoice + baris; PAID -> account_payment
--     transfer malam: PAID = dana ke kas operasional (internal_transfer); disalurkan (DISBURSED / RECONCILED) = pembayaran
--     dari kas operasional; dikembalikan sebelum disalurkan = transfer balik + baris dibatalkan
--   customer_invoice_batches + items -> account_move out_invoice (nominal fase: DP 70%, pelunasan = selling setelah pajak - DP)
--   finance_workflow_status *_PAID customer -> account_payment masuk
--   status tanpa dokumen             -> dokumen SALDO AWAL
-- ============================================================================

create or replace function amico_legacy.norm(p text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')), '')
$$;

create or replace function amico_legacy.num(p text) returns numeric language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then 0
    when btrim(p) ~ '^-?\d+(\.\d+)?$' then btrim(p)::numeric
    else coalesce(nullif(regexp_replace(p, '[^0-9]', '', 'g'), '')::numeric, 0)
  end
$$;

create or replace function amico_legacy.kind(p text) returns text language sql immutable as $$
  select case when upper(btrim(coalesce(p, ''))) in ('TRUCKING', 'CALO', 'TOL', 'PARKIR', 'BONGKAR', 'LAINNYA')
              then upper(btrim(p)) else 'LAINNYA' end
$$;

create or replace function amico_legacy.jkt_date(p timestamptz) returns date language sql immutable as $$
  select (p at time zone 'Asia/Jakarta')::date
$$;

create or replace function amico_legacy.billed(p_job_line_id integer) returns numeric language sql stable as $$
  select coalesce(sum(ml.amount), 0) from account_move_line ml join account_move m on m.id = ml.move_id
  where ml.job_line_id = p_job_line_id and ml.cancelled_at is null and m.state = 'posted'
$$;

-- Tempel nominal ke baris order job. Kelebihan: biaya vendor jenis baru -> baris order jenis itu;
-- selain itu -> "selisih tanpa tujuan" (baris dokumen tanpa baris order, diarahkan finance nanti)
create or replace function amico_legacy.add_lines(
  p_move_id integer, p_job_id integer, p_side text, p_kind text, p_amount numeric, p_counted boolean, p_key text,
  p_payee_partner integer default null, p_bank text default null, p_account text default null, p_holder text default null,
  p_legacy_item uuid default null
) returns void language plpgsql as $$
declare
  v_left numeric := p_amount;
  v_no integer;
  v_line integer;
  v_take numeric;
  l record;
begin
  if coalesce(p_amount, 0) <= 0 then return; end if;
  select coalesce(max(line_no), 0) into v_no from account_move_line where move_id = p_move_id;
  for l in
    select jl.id, jl.amount - amico_legacy.billed(jl.id) as remaining
    from job_line jl join product p on p.id = jl.product_id
    where jl.job_id = p_job_id and jl.side = p_side and p.kind <> 'SELISIH' and (p_side = 'SALE' or p.kind = p_kind)
    order by (p.kind <> 'TRUCKING'), jl.id
  loop
    exit when v_left <= 0;
    if not p_counted then
      v_take := v_left;
    else
      continue when l.remaining <= 0;
      v_take := least(v_left, l.remaining);
    end if;
    v_no := v_no + 1;
    insert into account_move_line (move_id, line_no, job_line_id, job_id, amount, payee_partner_id, payee_bank_name, payee_account_number, payee_holder, legacy_item_id)
    values (p_move_id, v_no, l.id, p_job_id, v_take, p_payee_partner, p_bank, p_account, p_holder, p_legacy_item);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    v_line := null;
    if p_side = 'PURCHASE' and p_kind <> 'TRUCKING' and not exists (
        select 1 from job_line jl join product p on p.id = jl.product_id where jl.job_id = p_job_id and jl.side = p_side and p.kind = p_kind) then
      insert into job_line (job_id, side, product_id, partner_id, description, amount, legacy_key)
      values (p_job_id, p_side, (select id from product where kind = p_kind), p_payee_partner, 'Dari data lama: ' || p_key, v_left, 'import:' || p_key)
      returning id into v_line;
    end if;
    v_no := v_no + 1;
    insert into account_move_line (move_id, line_no, job_line_id, job_id, amount, description, payee_partner_id, payee_bank_name, payee_account_number, payee_holder, legacy_item_id)
    values (p_move_id, v_no, v_line, p_job_id, v_left, case when v_line is null then 'Selisih tanpa tujuan (data lama: ' || p_key || ')' end,
            p_payee_partner, p_bank, p_account, p_holder, p_legacy_item);
  end if;
end $$;

-- Bayar (atau balik bayar kalau p_amount minus) baris dokumen untuk satu job / satu item / semua baris
create or replace function amico_legacy.pay(
  p_move_id integer, p_job_id integer, p_item uuid, p_amount numeric, p_date date, p_number text, p_bank integer,
  p_legacy_source text, p_legacy_id uuid, p_reverse_of integer default null, p_actual jsonb default null
) returns integer language plpgsql as $$
declare
  m account_move;
  v_id integer;
  v_left numeric := abs(p_amount);
  v_sign integer := sign(p_amount);
  v_take numeric;
  l record;
begin
  if coalesce(p_amount, 0) = 0 then return null; end if;
  select * into m from account_move where id = p_move_id;
  insert into account_payment (number, payment_type, move_id, pay_date, amount, bank_account_id, reversed_payment_id, note, legacy_source, legacy_id)
  values (p_number, case when m.move_type = 'out_invoice' then 'inbound' else 'outbound' end, p_move_id, p_date, 0, p_bank, p_reverse_of,
          'Dari ERP AMICO lama', p_legacy_source, p_legacy_id)
  returning id into v_id;
  for l in
    select ml.id, ml.job_id, ml.amount, coalesce((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id), 0) as paid
    from account_move_line ml
    where ml.move_id = p_move_id and (p_job_id is null or ml.job_id = p_job_id) and (p_item is null or ml.legacy_item_id = p_item)
    order by case when v_sign > 0 then ml.line_no else -ml.line_no end
  loop
    exit when v_left <= 0;
    v_take := case when v_sign > 0 then least(v_left, l.amount - l.paid) else least(v_left, l.paid) end;
    continue when v_take <= 0;
    insert into account_payment_line (payment_id, move_line_id, job_id, amount, actual_payee_name, actual_bank_name, actual_account_number, actual_holder)
    values (v_id, l.id, l.job_id, v_sign * v_take, p_actual->>'payee_name', p_actual->>'bank_name', p_actual->>'account_number', p_actual->>'holder');
    v_left := v_left - v_take;
  end loop;
  update account_payment set amount = (select coalesce(sum(amount), 0) from account_payment_line where payment_id = v_id) where id = v_id;
  if (select amount from account_payment where id = v_id) = 0 then
    delete from account_payment where id = v_id;
    return null;
  end if;
  if p_reverse_of is not null then update account_payment set state = 'reversed' where id = p_reverse_of; end if;
  return v_id;
end $$;

create or replace function amico_legacy.transfer(
  p_number text, p_date date, p_from integer, p_to integer, p_amount numeric, p_move integer, p_note text, p_legacy uuid
) returns void language sql as $$
  insert into internal_transfer (number, transfer_date, from_account_id, to_account_id, amount, move_id, note, legacy_source, legacy_id)
  select p_number, p_date, p_from, p_to, p_amount, p_move, p_note, 'payment_request_batches', p_legacy where coalesce(p_amount, 0) > 0
$$;

create or replace function amico_legacy.run_import() returns jsonb language plpgsql as $$
declare
  v_bank integer;
  v_ops_default integer;
  v_ops integer;
  b record;
  it record;
  st record;
  t record;
  v_move integer;
  v_pay integer;
  v_state text;
  v_counted boolean;
  v_night boolean;
  v_disbursed boolean;
  v_returned boolean;
  v_paid_date date;
  v_sum numeric;
  v_deduct boolean;
  v_amount numeric;
  v_left numeric;
  v_phase text;
  v_skipped integer;
begin
  if exists (select 1 from job) then
    raise exception 'Database tujuan sudah berisi job. Impor hanya ke database kosong (atau jalankan dengan --reset).';
  end if;

  -- ---------------------------------------------------------------- master
  insert into location (code, name, province, active)
  select distinct on (upper(btrim(location_code))) upper(btrim(location_code)), coalesce(name, location_code), province, coalesce(is_active, true)
  from amico_legacy.locations where nullif(btrim(location_code), '') is not null
  order by upper(btrim(location_code)), is_active desc nulls last;

  insert into res_partner (code, name, is_customer, address, pph_pct, ppn_pct, payment_terms_days, bill_to_name, bill_to_address, bill_to_npwp, active, legacy_id)
  select coalesce(amico_legacy.norm(customer_code), 'C-' || left(id::text, 8)), coalesce(btrim(name), customer_code), true, address,
         case when deduct_tax then 2 else 0 end, case when deduct_tax then 1.1 else 0 end, coalesce(payment_terms_days, 0),
         invoice_bill_name, invoice_bill_address, invoice_bill_npwp, coalesce(is_active, true), id
  from amico_legacy.customers;

  -- vendor / penerima transfer: semua nama penerima yang pernah dipakai
  create temporary table imp_vendor on commit drop as
  with names as (
    select amico_legacy.norm(payee_name) as n from amico_legacy.transfer_payees
    union select amico_legacy.norm(payment_receiver_name) from amico_legacy.jobs
    union select amico_legacy.norm(vendor_name) from amico_legacy.payment_request_items
    union select amico_legacy.norm(unit_owner) from amico_legacy.vehicles
  ),
  coded as (
    select n, 'V-' || left(regexp_replace(n, '[^A-Z0-9]+', '-', 'g'), 24) as base from names where n is not null
  )
  select n, base || case when row_number() over (partition by base order by n) > 1 then '-' || row_number() over (partition by base order by n) else '' end as code
  from coded;
  insert into res_partner (code, name, is_vendor) select code, n, true from imp_vendor;
  create temporary table imp_vendor_map on commit drop as
    select v.n, p.id from imp_vendor v join res_partner p on p.code = v.code;
  create index on imp_vendor_map (n);

  insert into res_partner_bank (partner_id, bank_name, account_number, holder, legacy_id)
  select distinct on (vm.id, upper(btrim(tp.bank_name)), btrim(tp.bank_account)) vm.id, upper(btrim(tp.bank_name)), btrim(tp.bank_account),
         coalesce(nullif(btrim(tp.account_name), ''), tp.payee_name), tp.id
  from amico_legacy.transfer_payees tp join imp_vendor_map vm on vm.n = amico_legacy.norm(tp.payee_name)
  where nullif(btrim(tp.bank_account), '') is not null and nullif(btrim(tp.bank_name), '') is not null
  on conflict (partner_id, bank_name, account_number) do nothing;
  insert into res_partner_bank (partner_id, bank_name, account_number, holder)
  select distinct vm.id, upper(btrim(x.bank)), btrim(x.acct), coalesce(nullif(btrim(x.holder), ''), x.name)
  from (select payment_receiver_name as name, payment_bank_name as bank, payment_bank_account as acct, payment_account_name as holder from amico_legacy.jobs
        union all select vendor_name, bank_name, bank_account, account_name from amico_legacy.payment_request_items) x
  join imp_vendor_map vm on vm.n = amico_legacy.norm(x.name)
  where nullif(btrim(x.acct), '') is not null and nullif(btrim(x.bank), '') is not null
  on conflict (partner_id, bank_name, account_number) do nothing;

  -- rekening AMICO
  insert into res_bank_account (name, bank_name, account_number, holder, kind, for_tax_invoice, is_default, active, legacy_id)
  select coalesce(label, bank_name || ' ' || account_number), coalesce(bank_name, '-'), coalesce(account_number, '-'), coalesce(account_name, '-'),
         'BANK', coalesce(for_tax_invoice, false), row_number() over (order by is_active desc nulls last, for_tax_invoice desc nulls last, label) = 1,
         coalesce(is_active, true), id
  from amico_legacy.company_accounts;
  if not exists (select 1 from res_bank_account where kind = 'BANK') then
    insert into res_bank_account (name, bank_name, account_number, holder, kind, is_default) values ('Rekening AMICO (impor)', '-', '-', 'PT AMICO', 'BANK', true);
  end if;
  select id into v_bank from res_bank_account where kind = 'BANK' order by is_default desc, id limit 1;
  insert into res_bank_account (name, bank_name, account_number, holder, kind)
  select distinct on (coalesce(btrim(operational_bank_account), '-'))
         'Kas operasional - ' || coalesce(nullif(btrim(operational_payee_name), ''), nullif(btrim(operational_account_name), ''), 'impor'),
         coalesce(nullif(btrim(operational_bank_name), ''), '-'), coalesce(nullif(btrim(operational_bank_account), ''), '-'),
         coalesce(nullif(btrim(operational_account_name), ''), nullif(btrim(operational_payee_name), ''), 'Operasional'), 'OPERATIONAL'
  from amico_legacy.payment_request_batches where payment_channel = 'TRANSFER_MALAM'
  order by coalesce(btrim(operational_bank_account), '-'), created_at desc;
  select id into v_ops_default from res_bank_account where kind = 'OPERATIONAL' order by id limit 1;

  insert into vehicle (plate_number, truck_type, owner_partner_id, pic, active, legacy_id)
  select distinct on (amico_legacy.norm(plate_number)) amico_legacy.norm(plate_number), coalesce(truck_type, '-'), vm.id, pic_trip, coalesce(is_active, true), v.id
  from amico_legacy.vehicles v left join imp_vendor_map vm on vm.n = amico_legacy.norm(v.unit_owner)
  where amico_legacy.norm(plate_number) is not null
  order by amico_legacy.norm(plate_number), is_active desc nulls last;

  insert into pricelist_item (customer_id, pol_id, pod_id, truck_type, trip_type, selling, effective_from, effective_to, active)
  select c.id, lp.id, ld.id, upper(btrim(r.truck_type)), coalesce(r.trip_type, 'ONE_WAY'), r.selling_price, r.effective_from, r.effective_to, coalesce(r.is_active, true)
  from amico_legacy.selling_rates r
  join amico_legacy.locations olp on olp.id = r.origin_location_id join location lp on lp.code = upper(btrim(olp.location_code))
  join amico_legacy.locations old on old.id = r.destination_location_id join location ld on ld.code = upper(btrim(old.location_code))
  left join res_partner c on c.legacy_id = r.customer_id
  where r.truck_type is not null and r.trip_type in ('ONE_WAY', 'ROUND_TRIP');
  insert into pricelist_item (pol_id, pod_id, truck_type, trip_type, cost, effective_from, effective_to, active)
  select lp.id, ld.id, upper(btrim(r.truck_type)), coalesce(r.trip_type, 'ONE_WAY'), r.cost_price, r.effective_from, r.effective_to, coalesce(r.is_active, true)
  from amico_legacy.cost_rates r
  join amico_legacy.locations olp on olp.id = r.origin_location_id join location lp on lp.code = upper(btrim(olp.location_code))
  join amico_legacy.locations old on old.id = r.destination_location_id join location ld on ld.code = upper(btrim(old.location_code))
  where r.vehicle_id is null and r.truck_type is not null and r.trip_type in ('ONE_WAY', 'ROUND_TRIP');

  -- ---------------------------------------------------------------- job
  insert into job (job_number, job_date, customer_id, vendor_id, pol_id, pod_id, trip_type, service_type, delivery_scope, rit_number,
                   truck_type, vehicle_id, plate_number, driver1_name, driver1_phone, driver2_name, driver2_phone, do_number,
                   customer_scheme, vendor_scheme, selling_mode, state, gate_out_at, gate_in_at,
                   sj_number, sj_resi_received_at, sj_received_at, sj_resi_number, sj_delivered_at, sj_delivered_resi_number,
                   note, source, legacy_id, created_at)
  select lj.job_number, lj.operational_date, c.id, vm.id, lp.id, ld.id,
         case when lj.trip_type = 'ROUND_TRIP' then 'ROUND_TRIP' else 'ONE_WAY' end,
         case when lj.service_type = 'FORWARDING_EXPORT_IMPORT' then 'FORWARDING' else 'TRUCKING' end,
         case when lj.delivery_scope = 'INNERCITY' then 'INNERCITY' else 'INTERCITY' end, lj.rit_number,
         coalesce(lv.truck_type, '-'), v.id, amico_legacy.norm(lv.plate_number),
         lj.driver_1_name, lj.driver_1_phone, lj.driver_2_name, lj.driver_2_phone, lj.task_code,
         case when lj.delivery_scope = 'INNERCITY' then 'FULL' else '70_30' end,
         case when lj.delivery_scope = 'INNERCITY' then 'FULL' else '70_30' end, 'CUSTOM',
         case when lj.gate_in_at is not null then 'done' else 'confirmed' end, lj.gate_out_at, lj.gate_in_at,
         lj.legacy_sj_number, amico_legacy.jkt_date(lj.sj_resi_received_at), amico_legacy.jkt_date(lj.sj_received_at), lj.sj_resi_number,
         amico_legacy.jkt_date(lj.sj_delivered_at), lj.sj_delivered_resi_number,
         nullif(concat_ws(E'\n', 'Ket finance DP: ' || nullif(lj.finance_dp_note, ''), 'Ket finance pelunasan: ' || nullif(lj.finance_settlement_note, '')), ''),
         'AMICO', lj.id, coalesce(lj.operational_date::timestamptz, now())
  from amico_legacy.jobs lj
  join res_partner c on c.legacy_id = lj.customer_id
  join amico_legacy.locations olp on olp.id = lj.pol_location_id join location lp on lp.code = upper(btrim(olp.location_code))
  join amico_legacy.locations old on old.id = lj.pod_location_id join location ld on ld.code = upper(btrim(old.location_code))
  left join amico_legacy.vehicles lv on lv.id = lj.vehicle_id
  left join vehicle v on v.plate_number = amico_legacy.norm(lv.plate_number)
  left join imp_vendor_map vm on vm.n = amico_legacy.norm(lj.payment_receiver_name)
  where lj.deleted_at is null;
  select count(*) into v_skipped from amico_legacy.jobs lj where lj.deleted_at is null and not exists (select 1 from job j where j.legacy_id = lj.id);

  -- job yang pernah diajukan FULL = skema vendor 100%, pernah ditagih FULL = skema customer 100%
  update job j set vendor_scheme = 'FULL'
  where j.vendor_scheme <> 'FULL' and exists (
    select 1 from amico_legacy.payment_request_items i join amico_legacy.payment_request_batches pb on pb.id = i.batch_id
    where i.job_id = j.legacy_id and i.request_type = 'FULL' and pb.cancelled_at is null and pb.status not in ('CANCELLED', 'REJECTED'));
  update job j set customer_scheme = 'FULL'
  where j.customer_scheme <> 'FULL' and exists (
    select 1 from amico_legacy.customer_invoice_items i join amico_legacy.customer_invoice_batches cb on cb.id = i.batch_id
    where i.job_id = j.legacy_id and cb.invoice_type = 'FULL' and cb.cancelled_at is null);

  -- baris order: selling_items atau selling_amount; cost_items atau cost_amount
  insert into job_line (job_id, side, product_id, partner_id, description, amount, legacy_key)
  select j.id, 'SALE', p.id, j.customer_id, coalesce(nullif(el.e->>'note', ''), p.name), amico_legacy.num(el.e->>'amount'), 'jobs.selling_items[' || (el.ord - 1) || ']'
  from job j join amico_legacy.jobs lj on lj.id = j.legacy_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(lj.selling_items) = 'array' then lj.selling_items else '[]'::jsonb end) with ordinality el(e, ord)
  join product p on p.kind = amico_legacy.kind(el.e->>'type')
  where amico_legacy.num(el.e->>'amount') > 0;
  insert into job_line (job_id, side, product_id, partner_id, description, amount, legacy_key)
  select j.id, 'SALE', (select id from product where kind = 'TRUCKING'), j.customer_id, 'Jasa trucking', coalesce(lj.selling_amount, 0), 'jobs.selling_amount'
  from job j join amico_legacy.jobs lj on lj.id = j.legacy_id
  where not exists (select 1 from job_line x where x.job_id = j.id and x.side = 'SALE');
  insert into job_line (job_id, side, product_id, partner_id, partner_bank_id, description, amount, legacy_key)
  select j.id, 'PURCHASE', p.id, case when p.kind = 'TRUCKING' then j.vendor_id end,
         case when p.kind = 'TRUCKING' then (select pb.id from res_partner_bank pb where pb.partner_id = j.vendor_id and pb.account_number = btrim(lj.payment_bank_account) limit 1) end,
         coalesce(nullif(el.e->>'note', ''), p.name), amico_legacy.num(el.e->>'amount'), 'jobs.cost_items[' || (el.ord - 1) || ']'
  from job j join amico_legacy.jobs lj on lj.id = j.legacy_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(lj.cost_items) = 'array' then lj.cost_items else '[]'::jsonb end) with ordinality el(e, ord)
  join product p on p.kind = amico_legacy.kind(el.e->>'type')
  where amico_legacy.num(el.e->>'amount') > 0;
  insert into job_line (job_id, side, product_id, partner_id, partner_bank_id, description, amount, legacy_key)
  select j.id, 'PURCHASE', (select id from product where kind = 'TRUCKING'), j.vendor_id,
         (select pb.id from res_partner_bank pb where pb.partner_id = j.vendor_id and pb.account_number = btrim(lj.payment_bank_account) limit 1),
         'Sewa truk', coalesce(lj.cost_amount, 0), 'jobs.cost_amount'
  from job j join amico_legacy.jobs lj on lj.id = j.legacy_id
  where not exists (select 1 from job_line x join product p on p.id = x.product_id where x.job_id = j.id and x.side = 'PURCHASE' and p.kind = 'TRUCKING');
  analyze job, job_line;

  -- ---------------------------------------------------------------- pengajuan vendor
  for b in select * from amico_legacy.payment_request_batches order by created_at, batch_number loop
    v_state := case when b.cancelled_at is not null or b.status in ('CANCELLED', 'REJECTED') then 'cancelled'
                    when b.status = 'DRAFT' then 'draft' else 'posted' end;
    v_counted := v_state = 'posted';
    v_night := coalesce(b.payment_channel, 'NORMAL') = 'TRANSFER_MALAM';
    insert into account_move (number, move_type, phase, move_date, state, approval_state, payment_channel, note, rejection_reason, cancel_reason,
                              legacy_source, legacy_id, legacy_number, posted_at, approved_at, cancelled_at, created_at)
    values (case when v_state = 'draft' then null else b.batch_number end, 'in_invoice',
            case b.request_type when 'DP_70' then 'DP' when 'FULL' then 'FULL' else 'SETTLEMENT' end,
            amico_legacy.jkt_date(b.created_at), v_state,
            case b.status when 'PENDING_APPROVAL' then 'PENDING' when 'REJECTED' then 'REJECTED'
                          when 'SUBMITTED' then 'NOT_REQUIRED' when 'DRAFT' then 'NOT_REQUIRED' else 'APPROVED' end,
            case when v_night then 'TRANSFER_MALAM' else 'NORMAL' end, b.note, b.rejection_reason, b.cancel_reason,
            'payment_request_batches', b.id, b.batch_number, case when v_state <> 'draft' then b.created_at end, b.approved_at, b.cancelled_at,
            coalesce(b.created_at, now()))
    returning id into v_move;

    for it in
      select i.*, j.id as job_id_new, vm.id as payee_id
      from amico_legacy.payment_request_items i
      join job j on j.legacy_id = i.job_id
      left join imp_vendor_map vm on vm.n = amico_legacy.norm(i.vendor_name)
      where i.batch_id = b.id and (not v_counted or i.cancelled_at is null or i.refunded_at is not null)
      order by i.item_no
    loop
      perform amico_legacy.add_lines(v_move, it.job_id_new, 'PURCHASE', amico_legacy.kind(coalesce(it.cost_type, 'TRUCKING')), it.request_amount,
        v_counted, 'item:' || it.id, it.payee_id, upper(btrim(it.bank_name)), btrim(it.bank_account), coalesce(nullif(btrim(it.account_name), ''), it.vendor_name), it.id);
    end loop;
    if not exists (select 1 from account_move_line where move_id = v_move) then
      delete from account_move where id = v_move;   -- batch berisi job yang diarsipkan semua
      continue;
    end if;

    if v_counted and (b.status in ('PAID', 'REFUNDED') or b.paid_at is not null) then
      v_paid_date := amico_legacy.jkt_date(coalesce(b.paid_at, b.created_at));
      v_disbursed := not v_night or b.reconciliation_status in ('DISBURSED_BY_OPERATIONAL', 'RECONCILED');
      v_returned := b.refunded_at is not null or b.status = 'REFUNDED' or b.reconciliation_status in ('REFUNDED', 'CANCELLED');
      if v_night then
        select id into v_ops from res_bank_account where kind = 'OPERATIONAL' and account_number = coalesce(nullif(btrim(b.operational_bank_account), ''), '-') limit 1;
        v_ops := coalesce(v_ops, v_ops_default);
        select coalesce(sum(amount), 0) into v_sum from account_move_line where move_id = v_move;
        perform amico_legacy.transfer('TRF:' || b.batch_number, v_paid_date, v_bank, v_ops, v_sum, v_move, 'Transfer malam ke kas operasional', b.id);
      end if;
      if v_night and not v_disbursed then
        -- belum disalurkan ke vendor: dana tetap titipan di kas operasional, kecuali sudah dikembalikan
        if v_returned then
          perform amico_legacy.transfer('TRF-BALIK:' || b.batch_number, amico_legacy.jkt_date(coalesce(b.refunded_at, b.paid_at)), v_ops, v_bank, v_sum, v_move,
            'Dana kembali dari kas operasional', b.id);
          update account_move_line set cancelled_at = coalesce(b.refunded_at, b.paid_at), cancel_reason = 'Transfer malam dikembalikan sebelum disalurkan'
          where move_id = v_move;
        else
          for it in select i.* from amico_legacy.payment_request_items i where i.batch_id = b.id and i.refunded_at is not null loop
            select coalesce(sum(amount), 0) into v_amount from account_move_line where move_id = v_move and legacy_item_id = it.id;
            perform amico_legacy.transfer('TRF-BALIK:' || b.batch_number || ':' || it.item_no, amico_legacy.jkt_date(it.refunded_at), v_ops, v_bank, v_amount, v_move,
              coalesce(it.refund_note, 'Refund item'), b.id);
            update account_move_line set cancelled_at = it.refunded_at, cancel_reason = coalesce(it.refund_note, 'Refund')
            where move_id = v_move and legacy_item_id = it.id;
          end loop;
        end if;
      else
        for it in
          select i.* from amico_legacy.payment_request_items i
          where i.batch_id = b.id and (i.cancelled_at is null or i.refunded_at is not null) order by i.item_no
        loop
          v_pay := amico_legacy.pay(v_move, null, it.id, (select coalesce(sum(amount), 0) from account_move_line where move_id = v_move and legacy_item_id = it.id),
            amico_legacy.jkt_date(coalesce(case when v_night then coalesce(it.disbursed_at, b.disbursed_at, b.reconciled_at) end, b.paid_at, b.created_at)),
            'PAY:' || b.batch_number || ':' || it.item_no, case when v_night then v_ops else v_bank end, 'payment_request_items', it.id, null,
            case when nullif(btrim(it.actual_payee_name), '') is not null then jsonb_build_object('payee_name', it.actual_payee_name, 'bank_name', it.actual_bank_name,
              'account_number', it.actual_bank_account, 'holder', it.actual_account_name) end);
          if v_pay is not null and (it.refunded_at is not null or (v_returned and b.refunded_at is not null)) then
            v_amount := (select amount from account_payment where id = v_pay);
            perform amico_legacy.pay(v_move, null, it.id, -v_amount, amico_legacy.jkt_date(coalesce(it.refunded_at, b.refunded_at)),
              'REFUND:' || b.batch_number || ':' || it.item_no, case when v_night then v_ops else v_bank end, 'payment_request_items', it.id, v_pay);
            if v_night then
              perform amico_legacy.transfer('TRF-BALIK:' || b.batch_number || ':' || it.item_no, amico_legacy.jkt_date(coalesce(it.refunded_at, b.refunded_at)),
                v_ops, v_bank, v_amount, v_move, 'Refund dikembalikan ke rekening', b.id);
            end if;
            update account_move_line set cancelled_at = coalesce(it.refunded_at, b.refunded_at), cancel_reason = coalesce(it.refund_note, 'Refund')
            where move_id = v_move and legacy_item_id = it.id;
          end if;
        end loop;
      end if;
    end if;
  end loop;
  update account_move m set state = 'cancelled', cancelled_at = coalesce(m.cancelled_at, now()), cancel_reason = coalesce(m.cancel_reason, 'Semua item di-refund / dikembalikan')
  where m.move_type = 'in_invoice' and m.state = 'posted'
    and not exists (select 1 from account_move_line ml where ml.move_id = m.id and ml.cancelled_at is null);
  analyze account_move, account_move_line, account_payment, account_payment_line;

  -- ---------------------------------------------------------------- invoice customer
  for b in
    select cb.*, c.id as partner_id, c.pph_pct, ca.id as bank_id
    from amico_legacy.customer_invoice_batches cb
    join res_partner c on c.legacy_id = cb.customer_id
    left join res_bank_account ca on ca.legacy_id = cb.company_account_id
    order by cb.created_at, cb.invoice_number
  loop
    v_state := case when b.cancelled_at is not null then 'cancelled' else 'posted' end;
    v_deduct := case when b.invoice_type = 'DP_70' then false when coalesce(b.ppn_amount, 0) > 0 or coalesce(b.pph23_amount, 0) > 0 then true else b.pph_pct > 0 end;
    insert into account_move (number, move_type, phase, partner_id, move_date, bank_account_id, state, tax_basis, ppn_amount, pph23_amount,
                              bill_to_name, bill_to_address, bill_to_npwp, cancel_reason, legacy_source, legacy_id, legacy_number, posted_at, cancelled_at, created_at)
    values (b.invoice_number, 'out_invoice', case b.invoice_type when 'SETTLEMENT_30' then 'SETTLEMENT' when 'FULL' then 'FULL' else 'DP' end,
            b.partner_id, b.invoice_date, coalesce(b.bank_id, v_bank), v_state, coalesce(b.subtotal, 0), coalesce(b.ppn_amount, 0), coalesce(b.pph23_amount, 0),
            b.bill_to_name, b.bill_to_address, b.bill_to_npwp, b.cancel_reason, 'customer_invoice_batches', b.id, b.invoice_number,
            coalesce(b.created_at, b.invoice_date::timestamptz), b.cancelled_at, coalesce(b.created_at, now()))
    returning id into v_move;
    for it in
      select i.*, j.id as job_id_new from amico_legacy.customer_invoice_items i join job j on j.legacy_id = i.job_id
      where i.batch_id = b.id and (v_state = 'cancelled' or i.cancelled_at is null) order by i.item_no
    loop
      v_amount := case b.invoice_type
        when 'DP_70' then round(it.selling_amount * 0.7)
        when 'SETTLEMENT_30' then round(it.selling_amount * (case when v_deduct then 0.991 else 1 end)) - round(it.selling_amount * 0.7)
        else round(it.selling_amount * (case when v_deduct then 0.991 else 1 end)) end;
      perform amico_legacy.add_lines(v_move, it.job_id_new, 'SALE', 'TRUCKING', v_amount, v_state = 'posted', 'invoice-item:' || it.id,
        null, null, null, null, it.id);
    end loop;
    if not exists (select 1 from account_move_line where move_id = v_move) then delete from account_move where id = v_move; end if;
  end loop;
  analyze account_move, account_move_line;

  -- pembayaran customer (data lama hanya punya status lunas per job)
  for st in
    select s.*, j.id as job_id_new, j.job_number, j.customer_scheme
    from amico_legacy.finance_workflow_status s join job j on j.legacy_id = s.job_id
    where s.workflow_bucket = 'CUSTOMER_INVOICE' and s.workflow_action in ('DP_PAID', 'SETTLEMENT_PAID') and s.amount > 0
    order by s.processed_at
  loop
    v_phase := case when st.workflow_action = 'DP_PAID' then 'DP' when st.customer_scheme = 'FULL' then 'FULL' else 'SETTLEMENT' end;
    v_left := st.amount;
    for t in
      select m.id, m.number, m.bank_account_id,
             sum(ml.amount) - coalesce(sum((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id)), 0) as open
      from account_move m join account_move_line ml on ml.move_id = m.id
      where m.move_type = 'out_invoice' and m.state = 'posted' and m.phase = v_phase and ml.job_id = st.job_id_new and ml.cancelled_at is null
      group by m.id, m.number, m.bank_account_id, m.move_date order by m.move_date, m.number
    loop
      exit when v_left <= 0;
      continue when t.open <= 0;
      perform amico_legacy.pay(t.id, st.job_id_new, null, least(v_left, t.open), amico_legacy.jkt_date(st.processed_at),
        'PAY:' || t.number || ':' || st.job_number, t.bank_account_id, 'finance_workflow_status', st.id);
      v_left := v_left - least(v_left, t.open);
    end loop;
  end loop;

  -- saldo awal: status lama yang tidak punya dokumen
  for st in
    with legacy as (
      select j.id as job_id, j.job_number, j.customer_id, s.workflow_bucket,
             case when s.workflow_action like 'DP_%' then 'DP'
                  when (case s.workflow_bucket when 'CUSTOMER_INVOICE' then j.customer_scheme else j.vendor_scheme end) = 'FULL' then 'FULL'
                  else 'SETTLEMENT' end as phase,
             max(s.amount) filter (where s.workflow_action like '%_PAID') as paid_amount,
             max(s.amount) filter (where s.workflow_action like '%_REQUESTED') as requested_amount,
             max(s.processed_at) as processed_at
      from amico_legacy.finance_workflow_status s join job j on j.legacy_id = s.job_id
      group by j.id, j.job_number, j.customer_id, s.workflow_bucket,
               case when s.workflow_action like 'DP_%' then 'DP'
                  when (case s.workflow_bucket when 'CUSTOMER_INVOICE' then j.customer_scheme else j.vendor_scheme end) = 'FULL' then 'FULL'
                  else 'SETTLEMENT' end
    ),
    fin as (
      select ml.job_id, case m.move_type when 'out_invoice' then 'CUSTOMER_INVOICE' else 'VENDOR_BILL' end as bucket, m.phase,
             sum(ml.amount) as billed, sum(coalesce((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id), 0)) as paid
      from account_move m join account_move_line ml on ml.move_id = m.id
      where m.state = 'posted' and m.phase <> 'OTHER' and ml.cancelled_at is null
      group by ml.job_id, m.move_type, m.phase
    )
    select l.*, coalesce(f.billed, 0) as fin_billed, coalesce(f.paid, 0) as fin_paid
    from legacy l left join fin f on f.job_id = l.job_id and f.bucket = l.workflow_bucket and f.phase = l.phase
    where coalesce(l.paid_amount, 0) - coalesce(f.paid, 0) > 1
       or (l.workflow_bucket = 'CUSTOMER_INVOICE' and coalesce(l.requested_amount, 0) - coalesce(f.billed, 0) > 1)
  loop
    v_amount := greatest(coalesce(st.paid_amount, 0) - st.fin_paid,
                         case when st.workflow_bucket = 'CUSTOMER_INVOICE' then coalesce(st.requested_amount, 0) - st.fin_billed else 0 end);
    insert into account_move (number, move_type, phase, partner_id, move_date, state, approval_state, bank_account_id, note, legacy_source, posted_at)
    values ('SALDO-AWAL:' || st.job_number || ':' || st.workflow_bucket || ':' || st.phase,
            case st.workflow_bucket when 'CUSTOMER_INVOICE' then 'out_invoice' else 'in_invoice' end, st.phase,
            case st.workflow_bucket when 'CUSTOMER_INVOICE' then st.customer_id end, amico_legacy.jkt_date(st.processed_at), 'posted',
            case st.workflow_bucket when 'CUSTOMER_INVOICE' then 'NOT_REQUIRED' else 'APPROVED' end, v_bank,
            'Saldo awal: status di ERP AMICO lama tanpa dokumen', 'finance_workflow_status', st.processed_at)
    returning id into v_move;
    perform amico_legacy.add_lines(v_move, st.job_id, case st.workflow_bucket when 'CUSTOMER_INVOICE' then 'SALE' else 'PURCHASE' end,
      'TRUCKING', v_amount, true, 'saldo-awal:' || st.workflow_bucket || ':' || st.phase);
    if coalesce(st.paid_amount, 0) - st.fin_paid > 1 then
      perform amico_legacy.pay(v_move, st.job_id, null, coalesce(st.paid_amount, 0) - st.fin_paid, amico_legacy.jkt_date(st.processed_at),
        'PAY:SALDO-AWAL:' || st.job_number || ':' || st.workflow_bucket || ':' || st.phase, v_bank, 'finance_workflow_status', null);
    end if;
  end loop;

  -- nomor job baru melanjutkan nomor lama per bulan (AMC/YYMM/NNNN)
  insert into ir_sequence (name, next_number)
  select 'JOB/' || m[1], max(m[2]::integer) + 1
  from (select regexp_match(job_number, '^AMC/(\d{4})/(\d+)$') as m from job) x
  where m is not null group by m[1]
  on conflict (name) do update set next_number = greatest(ir_sequence.next_number, excluded.next_number);

  analyze;
  return jsonb_build_object(
    'partner', (select count(*) from res_partner), 'rekening_penerima', (select count(*) from res_partner_bank),
    'kendaraan', (select count(*) from vehicle), 'price_book', (select count(*) from pricelist_item),
    'job', (select count(*) from job), 'job_dilewati', v_skipped,
    'dokumen', (select count(*) from account_move), 'pembayaran', (select count(*) from account_payment),
    'transfer_internal', (select count(*) from internal_transfer),
    'saldo_awal', (select count(*) from account_move where legacy_source = 'finance_workflow_status'));
end $$;

-- Rekonsiliasi: angka sistem baru vs finance_workflow_status lama per job x bucket x fase
create or replace view amico_legacy.v_rekon as
with baru as (
  select ml.job_id, case m.move_type when 'out_invoice' then 'CUSTOMER_INVOICE' else 'VENDOR_BILL' end as bucket,
         case when m.phase = 'DP' then 'DP' else 'SETTLEMENT' end as fase,
         sum(ml.amount) as diajukan,
         sum(coalesce((select sum(pl.amount) from account_payment_line pl where pl.move_line_id = ml.id), 0)) as dibayar
  from account_move m join account_move_line ml on ml.move_id = m.id
  where m.state = 'posted' and ml.cancelled_at is null
  group by ml.job_id, m.move_type, case when m.phase = 'DP' then 'DP' else 'SETTLEMENT' end
),
lama as (
  select j.id as job_id, s.workflow_bucket as bucket, case when s.workflow_action like 'DP_%' then 'DP' else 'SETTLEMENT' end as fase,
         coalesce(max(s.amount) filter (where s.workflow_action like '%_REQUESTED'), 0) as diajukan,
         coalesce(max(s.amount) filter (where s.workflow_action like '%_PAID'), 0) as dibayar
  from amico_legacy.finance_workflow_status s join job j on j.legacy_id = s.job_id
  group by j.id, s.workflow_bucket, case when s.workflow_action like 'DP_%' then 'DP' else 'SETTLEMENT' end
),
k as (select job_id, bucket, fase from baru union select job_id, bucket, fase from lama)
select j.job_number, c.name as customer, k.bucket, k.fase,
       coalesce(l.diajukan, 0) as lama_diajukan, coalesce(b.diajukan, 0) as baru_diajukan,
       coalesce(l.dibayar, 0) as lama_dibayar, coalesce(b.dibayar, 0) as baru_dibayar,
       coalesce(b.dibayar, 0) - coalesce(l.dibayar, 0) as selisih_dibayar
from k join job j on j.id = k.job_id join res_partner c on c.id = j.customer_id
left join baru b on b.job_id = k.job_id and b.bucket = k.bucket and b.fase = k.fase
left join lama l on l.job_id = k.job_id and l.bucket = k.bucket and l.fase = k.fase;
