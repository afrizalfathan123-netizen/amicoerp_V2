-- ============================================================================
-- 010: nama kontak (ATTN) customer untuk cetak invoice format AMICO.
-- (008 dicadangkan untuk 008_kas_operasional.sql yang belum digabung.)
-- ============================================================================
alter table res_partner add column attn text;
