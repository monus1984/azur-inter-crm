-- =============================================================================
-- MIGRATION LOT 2
-- À exécuter dans Supabase SQL Editor
-- =============================================================================

-- 1. Bucket Storage pour les factures PDF
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Politique : un commercial peut uploader dans son propre dossier
create policy "upload_factures_commercial"
on storage.objects for insert
with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = 'factures'
  and (storage.foldername(name))[2] = auth.uid()::text
);

-- Admin peut tout lire
create policy "lecture_factures_admin"
on storage.objects for select
using (
  bucket_id = 'documents'
  and (
    (select role from profiles where id = auth.uid()) = 'admin'
    or (storage.foldername(name))[2] = auth.uid()::text
  )
);

-- 2. Colonne agence_courante sur profiles (pour pré-remplir le formulaire)
-- Déduite de la dernière affectation active.
create or replace view agence_courante_view as
select
  p.id,
  p.nom,
  p.role,
  p.login_oci,
  p.email_pro,
  p.actif,
  a.agence as agence_courante
from profiles p
left join affectations a on a.profile_id = p.id and a.fin is null;

-- 3. Index supplémentaire pour la page Validation (tri par date de création)
create index if not exists idx_sales_statut_cree on sales (statut, cree_le);

-- 4. Import batch table (traçabilité des imports PDF)
create table if not exists import_batches (
  id            bigserial primary key,
  profile_id    uuid references profiles(id),
  source        text not null default 'pdf',
  fichier       text,
  n_facture     text,
  lignes_recues integer not null default 0,
  lignes_ok     integer not null default 0,
  lignes_erreur integer not null default 0,
  statut        text not null default 'en_cours',
  message       text,
  cree_le       timestamptz not null default now()
);

alter table import_batches enable row level security;

create policy "import_batches_commercial"
on import_batches for select
using (profile_id = auth.uid() or (select role from profiles where id = auth.uid()) in ('admin','dg'));

create policy "import_batches_insert"
on import_batches for insert
with check (profile_id = auth.uid());
