-- =============================================================================
-- CORRECTIF — agence_courante_view (créée au Lot 2, faille de sécurité)
--
-- Cette vue a été créée sans security_invoker explicite ni contrôle de
-- rôle. Par défaut, une vue Postgres sans security_invoker=true s'exécute
-- avec les droits de son créateur, ce qui contourne le RLS des tables
-- sources (profiles, affectations) pour QUICONQUE a un droit SELECT sur la
-- vue elle-même — potentiellement même un rôle qui ne devrait voir aucune
-- donnée nominative (ex: 'oci'). Corrigé selon le même principe que
-- kpi_oci et sales_superviseur : contrôle de rôle explicite dans le WHERE.
-- =============================================================================

drop view if exists agence_courante_view;

create view agence_courante_view
with (security_invoker = false)
as
select
  p.id,
  p.nom,
  p.role,
  p.login_oci,
  p.email_pro,
  p.actif,
  a.agence as agence_courante
from profiles p
left join affectations a on a.profile_id = p.id and a.fin is null
where role_courant() in ('admin', 'dg', 'superviseur', 'commercial');

comment on view agence_courante_view is
  'Corrigée le 06/09/2026 : security_invoker=false + contrôle de rôle
   explicite. Un commercial peut voir son agence et celle de ses
   collègues via cette vue (déjà le cas côté données non sensibles) ; oci
   n''y a jamais accès.';
