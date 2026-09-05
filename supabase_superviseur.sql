-- =============================================================================
-- MIGRATION — Rôle superviseur + backlog de complétion
-- À exécuter dans Supabase SQL Editor, après schema_lot1.sql et supabase_lot2.sql
--
-- Contexte : Yves Roland Dery, superviseur des équipes, doit voir les
-- statistiques d'équipe (CA, commission OCI, taux d'atteinte des objectifs)
-- SANS jamais voir les primes individuelles des commerciaux ni un futur
-- salaire. Il ne saisit jamais de vente manuellement, mais complète les
-- lignes importées avec des données manquantes (agent non reconnu, date
-- absente...) avant qu'elles entrent dans le circuit de validation normal.
-- =============================================================================


-- =============================================================================
-- 1. NOUVEAU RÔLE ET NOUVEAU STATUT
-- =============================================================================

alter type role_utilisateur add value if not exists 'superviseur';

-- 'incomplete' : ligne importée automatiquement mais avec un ou plusieurs
-- champs manquants (agent non reconnu, date absente...). Distincte de
-- 'saisie' pour qu'un import massif ne bloque jamais sur ses lignes les
-- moins fiables — elles partent dans un backlog au lieu d'empêcher l'import
-- des lignes propres.
alter type statut_vente add value if not exists 'incomplete';


-- =============================================================================
-- 2. SALES : PROFILE_ID DEVIENT NULLABLE POUR LE BACKLOG
--
-- Une ligne 'incomplete' peut ne pas encore avoir d'agent identifié. Toute
-- ligne dans un autre statut doit obligatoirement avoir un profile_id.
-- =============================================================================

alter table sales alter column profile_id drop not null;
alter table sales alter column date_vente drop not null;

alter table sales add constraint sales_profile_id_requis
  check (profile_id is not null or statut = 'incomplete');

alter table sales add constraint sales_date_vente_requise
  check (date_vente is not null or statut = 'incomplete');


-- =============================================================================
-- 3. CORRECTIF — kpi_oci ne fonctionnait pas pour le rôle 'oci'
--
-- Erreur du Lot 1 : la vue était en security_invoker = true, ce qui la fait
-- s'exécuter avec les droits de l'appelant. Le rôle 'oci' n'a AUCUNE
-- politique de lecture sur "sales", donc la vue renvoyait toujours un
-- ensemble vide pour lui — le portail partenaire n'aurait jamais affiché
-- de données. Le correctif : la vue s'exécute avec les droits de son
-- créateur (contourne le RLS de la table source) et applique elle-même un
-- contrôle de rôle explicite, ce qui permet aussi de masquer des colonnes
-- entières (comme la prime, plus bas) sans jamais exposer la table source.
-- =============================================================================

drop view if exists kpi_oci;

create view kpi_oci
with (security_invoker = false)
as
select
  date_trunc('month', s.date_vente)::date  as mois,
  s.agence,
  s.univers,
  count(*)                                  as nombre_ventes,
  sum(s.quantite)                           as volume,
  sum(s.ca_ttc)                             as ca_ttc,
  round(sum(s.ca_ttc) / 1.18, 2)            as ca_ht
from sales s
where s.statut = 'validee'
  and s.est_avoir = false
  and role_courant() in ('admin', 'dg', 'oci')
group by 1, 2, 3;

comment on view kpi_oci is
  'security_invoker = false (corrige un bug du Lot 1) : la vue tourne avec
   les droits de son créateur, indépendamment du RLS sur sales. Le contrôle
   d''accès est fait explicitement via role_courant() dans le WHERE, pas par
   héritage du RLS de la table source — c''est ce qui permet à ''oci'' de
   lire cette vue sans jamais avoir accès à la table sales elle-même.';


-- =============================================================================
-- 4. VUE POUR LE SUPERVISEUR — sans la colonne prime
--
-- Même logique que kpi_oci : sécurité par vue, jamais par filtrage côté
-- interface. Le superviseur n'a aucune politique de lecture sur la table
-- sales ; il ne peut lire que cette vue, qui omet volontairement la colonne
-- prime. Comme le RLS ne peut pas masquer une colonne (seulement des
-- lignes), c'est la seule façon fiable d'empêcher techniquement l'accès à
-- la prime — pas juste de la cacher dans l'interface.
-- =============================================================================

create view sales_superviseur
with (security_invoker = false)
as
select
  s.id,
  s.profile_id,
  s.date_vente,
  s.agence,
  s.univers,
  s.offre,
  s.client,
  s.quantite,
  s.prix_unitaire,
  s.ca_ttc,
  s.commission_oci,   -- commission OCI = indicateur d'équipe, visible
  s.points,           -- niveau de barème atteint, visible (performance)
  -- s.prime est délibérément absente : jamais visible au superviseur
  s.n_facture,
  s.statut,
  s.statut_doublon,
  s.est_avoir,
  s.cree_par,
  s.cree_le,
  s.modifie_par,
  s.modifie_le
from sales s
where role_courant() in ('admin', 'dg', 'superviseur');

comment on view sales_superviseur is
  'Vue de lecture pour le superviseur : CA, commission OCI et points de
   barème visibles (indicateurs de performance d''équipe), prime
   délibérément exclue. Le superviseur n''a aucun accès direct à la table
   sales — voir la politique RLS plus bas.';


-- =============================================================================
-- 5. TRIGGER — verrouille ce qu'un superviseur peut modifier
--
-- Le superviseur peut compléter une ligne 'incomplete' (agent, date, offre,
-- montant, agence, n° facture) et la faire passer en 'saisie'. Il ne doit
-- jamais pouvoir toucher à la prime, à la commission OCI, ni faire basculer
-- une ligne vers un autre statut que 'saisie'. Une politique RLS ne peut pas
-- restreindre des colonnes individuellement — ce trigger fait ce contrôle
-- au niveau base, indépendamment de ce que l'interface autorise ou non.
-- =============================================================================

create or replace function verrouiller_champs_superviseur()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if role_courant() <> 'superviseur' then
    return new;
  end if;

  if old.statut <> 'incomplete' then
    raise exception 'Un superviseur ne peut compléter qu''une ligne au statut incomplete';
  end if;

  if new.statut not in ('incomplete', 'saisie') then
    raise exception 'Un superviseur ne peut faire passer une ligne qu''au statut saisie';
  end if;

  if new.prime is distinct from old.prime then
    raise exception 'Un superviseur ne peut pas modifier la prime';
  end if;

  if new.commission_oci is distinct from old.commission_oci then
    raise exception 'Un superviseur ne peut pas modifier la commission OCI';
  end if;

  new.modifie_par := auth.uid();
  new.modifie_le := now();
  return new;
end;
$$;

create trigger verrou_superviseur
  before update on sales
  for each row execute function verrouiller_champs_superviseur();


-- =============================================================================
-- 6. POLITIQUES RLS
-- =============================================================================

-- --- sales : le superviseur peut UNIQUEMENT compléter le backlog ------------
-- Aucune politique SELECT sur la table elle-même : toute lecture passe par
-- sales_superviseur, qui masque la prime. C'est ce qui rend la restriction
-- réelle et non contournable depuis l'interface.

create policy sales_backlog_superviseur on sales
  for update using (
    role_courant() = 'superviseur' and statut = 'incomplete'
  )
  with check (
    role_courant() = 'superviseur' and statut in ('incomplete', 'saisie')
  );

-- --- profiles : le superviseur voit la liste des commerciaux ----------------
-- Nécessaire pour lui permettre d'attribuer un agent à une ligne du backlog,
-- et pour afficher les statistiques par personne.

create policy profils_superviseur on profiles
  for select using (role_courant() = 'superviseur');

-- --- objectifs : le superviseur voit les objectifs pour calculer le taux
--     d'atteinte de l'équipe -------------------------------------------------

create policy objectifs_superviseur on objectifs
  for select using (role_courant() = 'superviseur');

-- --- affectations : nécessaire pour connaître l'agence de chaque agent -----

create policy affect_superviseur on affectations
  for select using (role_courant() = 'superviseur');


-- =============================================================================
-- FIN DE LA MIGRATION
--
-- À faire ensuite :
--   1. Créer le compte Supabase Auth pour Yves Roland Dery
--   2. Créer son profil :
--        insert into profiles (id, nom, role)
--        values ('<uuid>', 'Yves Roland Dery', 'superviseur');
--   3. Adapter l'import (ImportPDF) pour insérer les lignes incomplètes avec
--      statut = 'incomplete' au lieu de bloquer l'import
--   4. Créer la page Backlog (admin + superviseur)
--   5. Adapter le Dashboard : le superviseur doit lire sales_superviseur,
--      jamais la table sales directement
-- =============================================================================
