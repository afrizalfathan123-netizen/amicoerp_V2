-- ============================================================================
-- 005: salinan angka JOB REGISTRATION (Excel) per job, untuk dibandingkan dengan ERP di halaman Selisih.
-- Diisi saat impor JOB REG atau saat file JOB REG diunggah di halaman Selisih (diganti seluruhnya tiap kali).
-- data: angka FINANCE (cost, calo, selling, sat, vb70, vb30, rp70, rp30) + UTANG PIUTANG (u100, u100t, u70, u70t,
--       u30, u30t, p100b, p100g, p100t, p70b, p70g, p70t, p30b, p30g, p30t), dalam rupiah.
-- ============================================================================
create table jobreg_snapshot (
  job_id integer primary key references job(id) on delete cascade,
  data jsonb not null
);
