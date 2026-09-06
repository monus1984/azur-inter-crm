-- =============================================================================
-- PAIE — salaire fixe mensuel, strictement cloisonné
--
-- Rappel de la règle (Article 4 des contrats CDD) :
--   Junior  : 150 000 F, fixe, tous les mois
--   Senior  : 250 000 F si quota de 100 points atteint dans le mois,
--             bascule automatique à 150 000 F sinon
--
-- Cloisonnement : admin et DG uniquement. Ni le commercial concerné, ni le
-- superviseur, ni OCI n'ont accès à cette table — décision actée dès le
-- Lot 1 (le commercial ne voit ni son salaire fixe ni la grille collective).
-- =============================================================================

create table remuneration (
  id                bigserial primary key,
  profile_id        uuid not null references profiles(id),
  mois              date not null,
  niveau_applique   text not null check (niveau_applique in ('junior', 'senior')),
  salaire_verse     numeric(12,2) not null,
  quota_points      numeric(6,1),
  points_realises   numeric(6,1),
  quota_atteint     boolean,
  note              text,
  cree_par          uuid references profiles(id),
  cree_le           timestamptz not null default now(),
  modifie_par       uuid references profiles(id),
  modifie_le        timestamptz,

  unique (profile_id, mois)
);

comment on table remuneration is
  'Salaire fixe mensuel. Jamais exposé au commercial concerné (même sa
   propre ligne), ni au superviseur, ni à OCI — seuls admin et DG y ont
   accès. Le montant par défaut suit la règle contractuelle (niveau +
   quota), mais reste éditable pour les cas particuliers (prorata CDD,
   ajustement, litige).';

alter table remuneration enable row level security;

create policy remuneration_lecture_admin_dg on remuneration
  for select using (role_courant() in ('admin', 'dg'));

create policy remuneration_ecriture_admin on remuneration
  for all using (est_admin()) with check (est_admin());

-- Aucune politique pour 'commercial', 'superviseur' ou 'oci' : accès
-- refusé par défaut dès que RLS est activé sur la table, sans exception.


-- =============================================================================
-- FONCTION — calcule le salaire théorique du mois selon la règle
-- contractuelle. Sert à préremplir remuneration, jamais à la place.
-- =============================================================================

create or replace function calculer_salaire_mensuel(p_profile_id uuid, p_mois date)
returns table (niveau_applique text, salaire numeric, quota numeric, points numeric, quota_atteint boolean)
language plpgsql
stable
as $$
declare
  v_niveau text;
  v_quota numeric;
  v_points numeric;
begin
  select p.niveau into v_niveau from profiles p where p.id = p_profile_id;

  select coalesce(op.quota_points, 100) into v_quota
  from objectifs_points op
  where op.profile_id = p_profile_id and op.mois = p_mois;

  select coalesce(sum(s.points), 0) into v_points
  from sales s
  where s.profile_id = p_profile_id
    and date_trunc('month', s.date_vente) = p_mois
    and s.est_avoir = false
    and s.statut not in ('incomplete');

  if v_niveau = 'senior' then
    if v_points >= coalesce(v_quota, 100) then
      return query select 'senior'::text, 250000::numeric, v_quota, v_points, true;
    else
      return query select 'junior'::text, 150000::numeric, v_quota, v_points, false;
    end if;
  else
    return query select 'junior'::text, 150000::numeric, v_quota, v_points, (v_points >= coalesce(v_quota, 100));
  end if;
end;
$$;


-- =============================================================================
-- PRÉREMPLISSAGE — un salaire pour chaque commercial actif, sur tout
-- l'historique disponible (août 2025 à décembre 2026). N'écrase jamais
-- une ligne déjà saisie manuellement (ON CONFLICT DO NOTHING).
-- =============================================================================

insert into remuneration (profile_id, mois, niveau_applique, salaire_verse, quota_points, points_realises, quota_atteint, note)
select
  p.id,
  mois.premier_du_mois,
  calc.niveau_applique,
  calc.salaire,
  calc.quota,
  calc.points,
  calc.quota_atteint,
  'Calcul automatique — à valider'
from profiles p
cross join (
  select generate_series('2025-08-01'::date, '2026-12-01'::date, interval '1 month')::date as premier_du_mois
) mois
cross join lateral calculer_salaire_mensuel(p.id, mois.premier_du_mois) calc
where p.role = 'commercial' and p.actif = true
on conflict (profile_id, mois) do nothing;

-- Vérification
select p.nom, r.mois, r.niveau_applique, r.salaire_verse, r.points_realises, r.quota_atteint
from remuneration r
join profiles p on p.id = r.profile_id
where r.mois = '2026-08-01'
order by p.nom;
