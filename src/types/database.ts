// Types alignés sur schema_lot1.sql.
// Toute modification du schéma doit se refléter ici.

export type RoleUtilisateur = "admin" | "dg" | "commercial" | "oci" | "superviseur";

export type UniversOffre = "INTERNET" | "MOBILE" | "FIXE" | "ICT" | "AUTRES";

export type StatutVente =
  | "saisie"
  | "incomplete"
  | "en_attente_oci"
  | "validee"
  | "annulee"
  | "non_trouvee"
  | "rejetee";

export interface Profile {
  id: string;
  nom: string;
  role: RoleUtilisateur;
  login_oci: string | null;
  email_pro: string | null;
  actif: boolean;
  agence_courante?: string;
}

export interface Sale {
  id: number;
  profile_id: string | null;
  date_vente: string | null;
  agence: string;
  univers: UniversOffre;
  offre: string;
  client: string | null;
  quantite: number;
  prix_unitaire: number;
  ca_ttc: number;
  commission_oci: number;
  points: number;
  prime: number;
  n_facture: string | null;
  statut: StatutVente;
  est_avoir: boolean;
  cree_le: string;
}

export interface MaPerformance {
  profile_id: string;
  mois: string;
  univers: UniversOffre;
  nombre_ventes: number;
  ca_ttc: number;
  points: number;
  prime_due: number;
  commission_oci: number;
}
