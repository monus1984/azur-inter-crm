-- =============================================================================
-- NIVEAU COMMERCIAL, POINTS RÉELS, PRIME AZUR, QUOTA INTERNE
--
-- Sources : Mouture_Contrat_Commerciaux_Junior.docx et
-- Mouture_Contrat_Commerciaux_Senior.docx (06/09/2026).
--
-- Découverte majeure : l'objectif interne Azur Inter n'est PAS un montant
-- en francs mais un QUOTA DE POINTS (100 pts/mois), avec un barème de
-- scoring propre (différent de la commission OCI et différent selon le
-- niveau Junior/Senior). La prime versée au commercial est elle aussi
-- distincte de la commission OCI — un barème séparé, identique pour les
-- deux niveaux. Rien de tout cela ne doit être visible par OCI.
-- =============================================================================


-- =============================================================================
-- 1. NIVEAU DU COMMERCIAL (Junior / Senior)
-- =============================================================================

alter table profiles add column if not exists niveau text check (niveau in ('junior', 'senior'));

comment on column profiles.niveau is
  'Junior ou Senior. Détermine le barème de points applicable (Annexe 1
   des contrats) et, pour les Senior, la modulation du salaire fixe selon
   l''atteinte du quota mensuel de 100 points.';

-- Deux niveaux connus avec certitude, cités nommément dans les contrats
-- fournis comme exemples :
update profiles set niveau = 'junior' where nom = 'ANANI LINDA';
update profiles set niveau = 'senior' where nom = 'SENDZE JADE';

-- Le reste du roster reste à confirmer avec Mounir avant tout calcul de
-- paie fiable — voir le point ouvert en fin de fichier.


-- =============================================================================
-- 2. BARÈME DE POINTS ET DE PRIME PAR PALIER TTC (produits à prix fixe)
--
-- Distinct de la table "bareme" (qui gère la commission OCI par mots-clés
-- sur le libellé). Ici le barème contractuel matche par PRIX TTC exact,
-- indépendamment du libellé produit.
-- =============================================================================

create table bareme_points_prime (
  id              bigserial primary key,
  prix_ttc        numeric(12,2) not null,
  points_junior   numeric(6,1) not null,
  points_senior   numeric(6,1) not null,
  prime           numeric(12,2) not null,
  effet_debut     date not null default '2026-04-01',
  note            text
);

insert into bareme_points_prime (prix_ttc, points_junior, points_senior, prime, note) values
  (15000,  4,  3,  4000,  'Fibre 50M'),
  (20000,  7,  6,  6000,  'Fibre 100M'),
  (25000,  15, 12, 15000, 'Fibre 200M / 4G 25K — même palier TTC, priorité Fibre'),
  (35000,  21, 18, 20000, 'Fibre 300M'),
  (65000,  38, 33, 40000, 'Fibre 500M'),
  (100000, 60, 52, 70000, 'TDD/FDD 100K'),
  (10000,  3,  4,  2500,  '4G 10K'),
  (17000,  5,  4,  4000,  '4G 17K'),
  (30000,  9,  7,  8000,  '4G 30K'),
  (49000,  14, 11, 15000, 'Easy Office 49K'),
  (59000,  17, 14, 18000, 'Easy Office 59K');

comment on table bareme_points_prime is
  'Points de scoring interne Azur et prime commerciale, par palier de prix
   TTC exact. Source : Annexes 1 et 2 des contrats CDD, avril 2026. Ne
   couvre que les produits à prix fixe — les offres à tarif variable (SMS,
   API SMS, ICT récurrent, Lignes, Community) sont gérées par formule dans
   calculer_points(), pas par cette table.';


-- =============================================================================
-- 3. FONCTIONS DE CALCUL — POINTS ET PRIME
-- =============================================================================

create or replace function calculer_points(p_offre text, p_ca_ttc numeric, p_niveau text)
returns numeric
language plpgsql
immutable
as $$
declare
  v_offre_norm text := upper(p_offre);
  v_ht numeric := round(p_ca_ttc / 1.18, 2);
  v_ligne bareme_points_prime%rowtype;
begin
  if p_niveau is null then
    return null; -- niveau non renseigné : impossible de scorer, pas de valeur par défaut
  end if;

  -- Offres à tarif variable : points par tranche de HT, taux différent
  -- Junior/Senior (contrats, Annexe 1).
  if v_offre_norm like '%SMS AFFAIRES%' or v_offre_norm like '%API SMS%' then
    return round(v_ht / 100000 * (case when p_niveau = 'junior' then 5 else 4 end), 1);
  end if;

  if v_offre_norm like '%MSSP%' or v_offre_norm like '%EDR%' then
    return round(v_ht / 50000 * (case when p_niveau = 'junior' then 15 else 12 end), 1);
  end if;

  if v_offre_norm like '%BAAS%' or v_offre_norm like '%MOS 365%' or v_offre_norm like '%MOS365%' then
    return round(v_ht / 50000 * (case when p_niveau = 'junior' then 5 else 4 end), 1);
  end if;

  if v_offre_norm like '%LIGNE%MONO%' or v_offre_norm like '%LIGNE%NUM%' or v_offre_norm like '%VOIX FIXE%' then
    return round(v_ht / 50000 * (case when p_niveau = 'junior' then 9 else 7 end), 1);
  end if;

  if v_offre_norm like '%COMMUNITY%' or v_offre_norm like '%START LITE%' then
    -- 1 point / 10 sims, à 500 F/sim => 1 pt / 5000 F de CA, identique
    -- Junior et Senior.
    return round(p_ca_ttc / 5000, 1);
  end if;

  -- Offres à prix fixe : correspondance exacte sur le palier TTC.
  select * into v_ligne from bareme_points_prime where prix_ttc = p_ca_ttc limit 1;
  if found then
    return case when p_niveau = 'junior' then v_ligne.points_junior else v_ligne.points_senior end;
  end if;

  -- Palier non couvert par le barème contractuel connu : pas de points
  -- plutôt qu'une estimation risquée.
  return 0;
end;
$$;

create or replace function calculer_prime(p_offre text, p_ca_ttc numeric, p_est_avoir boolean)
returns numeric
language plpgsql
immutable
as $$
declare
  v_ligne bareme_points_prime%rowtype;
begin
  if p_est_avoir then
    return 0;
  end if;

  select * into v_ligne from bareme_points_prime where prix_ttc = p_ca_ttc limit 1;
  if found then
    return v_ligne.prime;
  end if;

  -- Offres à tarif variable ou palier non couvert par le barème connu :
  -- pas de prime calculée automatiquement — à traiter manuellement en
  -- attendant que le barème des primes par vente (document séparé cité
  -- dans les contrats) soit fourni.
  return 0;
end;
$$;

comment on function calculer_points is
  'Retourne null si le niveau du commercial (Junior/Senior) n''est pas
   renseigné sur son profil — un score de 0 par défaut serait trompeur
   (laisserait croire à un quota non atteint alors que la donnée manque).';


-- =============================================================================
-- 4. QUOTA INTERNE AZUR (100 points/mois) — jamais visible par OCI
--
-- Table séparée de "objectifs" (qui porte l'objectif TRIMESTRIEL OCI, en
-- montant). Celle-ci porte le quota MENSUEL Azur, en points. Les deux
-- coexistent et ne doivent jamais être confondus dans l'interface.
-- =============================================================================

create table objectifs_points (
  id            bigserial primary key,
  profile_id    uuid not null references profiles(id) on delete cascade,
  mois          date not null,
  quota_points  numeric(6,1) not null default 100,
  points_realises numeric(6,1),  -- rempli par recalcul périodique, pas en temps réel
  source        text default 'Contrat CDD, avril 2026',
  cree_le       timestamptz not null default now(),

  unique (profile_id, mois)
);

comment on table objectifs_points is
  'Quota de points internes Azur Inter — jamais exposé à OCI, jamais
   confondu avec la table objectifs (cible trimestrielle OCI en montant).
   Sert notamment à déterminer, pour un Senior, si le salaire du mois
   bascule à 250 000 F (quota atteint) ou 150 000 F (quota non atteint) —
   voir Article 4 du contrat Senior.';

alter table objectifs_points enable row level security;

-- Mêmes politiques que la table sales : admin/dg/superviseur en lecture,
-- jamais oci (aucune politique = accès refusé par défaut avec RLS activé).
create policy objectifs_points_lecture on objectifs_points
  for select using (
    role_courant() in ('admin', 'dg', 'superviseur')
    or profile_id = auth.uid()
  );

create policy objectifs_points_ecriture on objectifs_points
  for all using (est_admin()) with check (est_admin());

-- Quota de 100 pts/mois pour tous les commerciaux actifs, sur tout
-- l'historique déjà en base (même logique que la réplication de
-- l'objectif OCI faite précédemment).
insert into objectifs_points (profile_id, mois, quota_points)
select p.id, mois.premier_du_mois, 100
from profiles p
cross join (
  select generate_series('2025-08-01'::date, '2026-12-01'::date, interval '1 month')::date as premier_du_mois
) mois
where p.role = 'commercial' and p.actif = true
on conflict (profile_id, mois) do nothing;


-- =============================================================================
-- 5. APPLICATION — recalcul des points et primes sur les ventes existantes
--
-- Ne s'applique qu'aux commerciaux dont le niveau est renseigné (Linda et
-- l'ex-Senior Jade Sendze pour l'instant). Les autres restent à 0 jusqu'à
-- confirmation du niveau par Mounir — voir point ouvert.
-- =============================================================================

update sales s
set
  points = coalesce(calculer_points(s.offre, s.ca_ttc, p.niveau), 0),
  prime = calculer_prime(s.offre, s.ca_ttc, s.est_avoir)
from profiles p
where s.profile_id = p.id
  and s.statut not in ('incomplete')
  and p.niveau is not null;

-- Vérification
select p.nom, p.niveau, count(*) as nb_ventes, sum(s.points) as points_totaux, sum(s.prime) as prime_totale
from sales s
join profiles p on p.id = s.profile_id
where p.niveau is not null
group by p.nom, p.niveau;


-- =============================================================================
-- POINT OUVERT — niveau des 14 autres commerciaux du roster
--
-- Seuls ANANI LINDA (junior) et SENDZE JADE (senior, partie) sont connus
-- avec certitude, cités nommément dans les contrats fournis en exemple.
-- Pour les 14 autres (AIDARA SYRA, BANHORO Habibata, BAKAYOKO MAX,
-- BANHORO NANTENIN, BONNY CELESTE, FATIGA MABOUTE, DIAKITE Hadja Sayon,
-- N'DRI JEANNETTE, GUIBILIHONON Dorcasse, AMOA Hervé, ATTAYE Saul,
-- KOUASSI Nadège-Flore, KOTIE Diane, ATTO Kevin, AGBARO Ayeko), le niveau
-- reste null tant que Mounir ne le confirme pas — leurs points et primes
-- resteront à 0 jusque-là, ce qui sous-évaluera visiblement leur
-- performance réelle sur la page Équipe.
-- =============================================================================
