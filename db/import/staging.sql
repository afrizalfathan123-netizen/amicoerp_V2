-- Skema penampung data ERP AMICO lama (Supabase). Diisi oleh scripts/import-amico.js, dibaca oleh amico_import.sql.
-- Hanya kolom yang dipakai. Dibuat ulang setiap impor.
drop schema if exists amico_legacy cascade;
create schema amico_legacy;

create table amico_legacy.customers (
  id uuid primary key, customer_code text, name text, address text, is_active boolean, deduct_tax boolean,
  payment_terms_days integer, invoice_bill_name text, invoice_bill_address text, invoice_bill_npwp text
);
create table amico_legacy.locations (id uuid primary key, location_code text, name text, province text, is_active boolean);
create table amico_legacy.vehicles (id uuid primary key, truck_type text, plate_number text, unit_owner text, vendor_type text, pic_trip text, is_active boolean);
create table amico_legacy.transfer_payees (id uuid primary key, payee_name text, account_name text, bank_name text, bank_account text);
create table amico_legacy.company_accounts (
  id uuid primary key, label text, bank_name text, account_number text, account_name text, for_tax_invoice boolean, is_active boolean
);
create table amico_legacy.selling_rates (
  id uuid primary key, customer_id uuid, origin_location_id uuid, destination_location_id uuid, truck_type text, trip_type text,
  selling_price numeric, effective_from date, effective_to date, is_active boolean
);
create table amico_legacy.cost_rates (
  id uuid primary key, vehicle_id uuid, unit_owner text, origin_location_id uuid, destination_location_id uuid, truck_type text, trip_type text,
  cost_price numeric, effective_from date, effective_to date, is_active boolean
);
create table amico_legacy.jobs (
  id uuid primary key, job_number text, operational_date date, gate_out_at timestamptz, gate_in_at timestamptz, customer_id uuid,
  pol_location_id uuid, pod_location_id uuid, vehicle_id uuid, task_code text,
  driver_1_name text, driver_1_phone text, driver_2_name text, driver_2_phone text,
  payment_receiver_name text, payment_bank_name text, payment_bank_account text, payment_account_name text,
  sj_resi_received_at timestamptz, sj_received_at timestamptz, sj_resi_number text, sj_delivered_at timestamptz, sj_delivered_resi_number text,
  deleted_at timestamptz, trip_type text, cost_amount numeric, selling_amount numeric, cost_items jsonb, selling_items jsonb,
  service_type text, delivery_scope text, rit_number integer, legacy_sj_number text, finance_dp_note text, finance_settlement_note text
);
create table amico_legacy.payment_request_batches (
  id uuid primary key, batch_number text, request_type text, status text, payment_channel text, reconciliation_status text, note text,
  created_at timestamptz, paid_at timestamptz, cancelled_at timestamptz, refunded_at timestamptz, approved_at timestamptz,
  disbursed_at timestamptz, reconciled_at timestamptz, rejection_reason text, cancel_reason text,
  operational_payee_name text, operational_account_name text, operational_bank_name text, operational_bank_account text
);
create table amico_legacy.payment_request_items (
  id uuid primary key, batch_id uuid, job_id uuid, request_type text, item_no integer, job_number text, cost_type text, payee_type text,
  vendor_name text, bank_name text, bank_account text, account_name text,
  actual_payee_name text, actual_bank_name text, actual_bank_account text, actual_account_name text,
  cost_amount numeric, request_amount numeric, cancelled_at timestamptz, disbursed_at timestamptz, refunded_at timestamptz, refund_note text
);
create table amico_legacy.customer_invoice_batches (
  id uuid primary key, invoice_number text, invoice_date date, invoice_type text, customer_id uuid, subtotal numeric, ppn_amount numeric,
  pph23_amount numeric, company_account_id uuid, bill_to_name text, bill_to_address text, bill_to_npwp text,
  created_at timestamptz, cancelled_at timestamptz, cancel_reason text
);
create table amico_legacy.customer_invoice_items (
  id uuid primary key, batch_id uuid, job_id uuid, invoice_type text, item_no integer, job_number text, selling_amount numeric, cancelled_at timestamptz
);
create table amico_legacy.finance_workflow_status (
  id uuid primary key, job_id uuid, workflow_bucket text, workflow_action text, amount numeric, processed_at timestamptz
);
create index on amico_legacy.payment_request_items (batch_id);
create index on amico_legacy.customer_invoice_items (batch_id);
create index on amico_legacy.finance_workflow_status (job_id);
