import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

interface LigneEquipe {
  profile_id: string;
  nom: string;
  agence: string;
  ca_ttc: number;
  commission_oci: number;
  points: number;
  nb_ventes: number;
  objectif_mensuel: number;
  taux_atteinte: number;
}

// Génère les 12 derniers mois pour le sélecteur, du plus récent au plus ancien.
function derniersMois(n: number): { debut: string; fin: string; libelle: string }[] {
  const mois = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const debut = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const fin = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    mois.push({
      debut: iso(debut),
      fin: iso(fin),
      libelle: debut.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }),
    });
  }
  return mois;
}

export default function Equipe({ profile }: Props) {
  const [lignes, setLignes] = useState<LigneEquipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const optionsMois = derniersMois(12);
  const [moisChoisi, setMoisChoisi] = useState(0); // index dans optionsMois, 0 = mois courant
  const { debut, fin } = optionsMois[moisChoisi];

  useEffect(() => {
    async function charger() {
      setLoading(true);
      setError(null);

      // Le superviseur n'a pas accès à la table sales directement — il passe
      // par sales_superviseur, qui exclut la colonne prime. Admin et DG
      // lisent la table complète.
      const source = profile.role === "superviseur" ? "sales_superviseur" : "sales";

      const [{ data: ventes, error: errVentes }, { data: profils }, { data: objectifs }] = await Promise.all([
        supabase
          .from(source)
          .select("profile_id, ca_ttc, commission_oci, points")
          .eq("est_avoir", false)
          .in("statut", ["validee", "en_attente_oci"])
          .gte("date_vente", debut)
          .lt("date_vente", fin),
        supabase.from("profiles").select("id, nom, actif").eq("actif", true),
        supabase
          .from("objectifs")
          .select("profile_id, univers, montant")
          .eq("mois", debut),
      ]);

      if (errVentes) {
        setError(errVentes.message);
        setLoading(false);
        return;
      }

      // Agence courante : nécessite la vue dédiée du Lot 2 (agence_courante_view).
      // À défaut on affiche "—" plutôt que de bloquer l'affichage.
      const { data: agences } = await supabase
        .from("agence_courante_view")
        .select("id, agence_courante");

      const agenceById = new Map((agences ?? []).map((a: { id: string; agence_courante: string | null }) => [a.id, a.agence_courante]));
      const objectifById = new Map<string, number>();
      (objectifs ?? []).forEach((o: { profile_id: string | null; montant: number }) => {
        if (!o.profile_id) return; // objectif collectif, pas individuel
        objectifById.set(o.profile_id, (objectifById.get(o.profile_id) ?? 0) + o.montant);
      });

      const stats = new Map<string, { ca: number; comm: number; points: number; nb: number }>();
      (ventes ?? []).forEach((v: { profile_id: string | null; ca_ttc: number; commission_oci: number; points: number }) => {
        if (!v.profile_id) return;
        const s = stats.get(v.profile_id) ?? { ca: 0, comm: 0, points: 0, nb: 0 };
        s.ca += v.ca_ttc || 0;
        s.comm += v.commission_oci || 0;
        s.points += v.points || 0;
        s.nb += 1;
        stats.set(v.profile_id, s);
      });

      const result: LigneEquipe[] = (profils ?? [])
        .filter((p: { id: string; nom: string }) => stats.has(p.id) || objectifById.has(p.id))
        .map((p: { id: string; nom: string }) => {
          const s = stats.get(p.id) ?? { ca: 0, comm: 0, points: 0, nb: 0 };
          const objectif = objectifById.get(p.id) ?? 0;
          return {
            profile_id: p.id,
            nom: p.nom,
            agence: agenceById.get(p.id) ?? "—",
            ca_ttc: s.ca,
            commission_oci: s.comm,
            points: s.points,
            nb_ventes: s.nb,
            objectif_mensuel: objectif,
            taux_atteinte: objectif > 0 ? (s.ca / objectif) * 100 : 0,
          };
        })
        .sort((a, b) => b.ca_ttc - a.ca_ttc);

      setLignes(result);
      setLoading(false);
    }

    charger();
  }, [profile.role, debut, fin]);

  const totaux = lignes.reduce(
    (acc, l) => ({
      ca: acc.ca + l.ca_ttc,
      comm: acc.comm + l.commission_oci,
      objectif: acc.objectif + l.objectif_mensuel,
    }),
    { ca: 0, comm: 0, objectif: 0 }
  );

  if (loading) return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;
  if (error) return <div className="p-8 text-red-600 text-sm">Erreur : {error}</div>;

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Équipe</h1>
      <div className="flex items-center gap-3 mb-6">
        <select
          value={moisChoisi}
          onChange={(e) => setMoisChoisi(parseInt(e.target.value))}
          className="text-sm border border-slate-300 rounded-md px-2 py-1 capitalize"
        >
          {optionsMois.map((m, i) => (
            <option key={m.debut} value={i} className="capitalize">
              {m.libelle}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-400">
          Ventes validées et en attente OCI (hors avoirs)
        </span>
      </div>

      {/* Résumé équipe */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-1">CA équipe</div>
          <div className="text-lg font-semibold text-slate-900">
            {totaux.ca.toLocaleString("fr-FR")} F
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-1">Commission OCI équipe</div>
          <div className="text-lg font-semibold text-slate-900">
            {totaux.comm.toLocaleString("fr-FR")} F
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-1">Taux d'atteinte équipe</div>
          <div className="text-lg font-semibold text-slate-900">
            {totaux.objectif > 0 ? ((totaux.ca / totaux.objectif) * 100).toFixed(0) : "—"}%
          </div>
        </div>
      </div>

      {lignes.length === 0 ? (
        <p className="text-sm text-slate-500">Aucune vente validée ce mois-ci pour le moment.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-4 font-medium">Commercial</th>
                <th className="py-2 pr-4 font-medium">Agence</th>
                <th className="py-2 pr-4 font-medium">Ventes</th>
                <th className="py-2 pr-4 font-medium">CA TTC</th>
                <th className="py-2 pr-4 font-medium">Commission OCI</th>
                <th className="py-2 pr-4 font-medium">Points</th>
                <th className="py-2 pr-4 font-medium">Objectif</th>
                <th className="py-2 pr-4 font-medium">Atteinte</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => (
                <tr key={l.profile_id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 text-slate-900 font-medium">{l.nom}</td>
                  <td className="py-2 pr-4 text-slate-600">{l.agence}</td>
                  <td className="py-2 pr-4 text-slate-700">{l.nb_ventes}</td>
                  <td className="py-2 pr-4 text-slate-700">{l.ca_ttc.toLocaleString("fr-FR")} F</td>
                  <td className="py-2 pr-4 text-slate-700">{l.commission_oci.toLocaleString("fr-FR")} F</td>
                  <td className="py-2 pr-4 text-slate-700">{l.points.toFixed(0)}</td>
                  <td className="py-2 pr-4 text-slate-500">
                    {l.objectif_mensuel > 0 ? l.objectif_mensuel.toLocaleString("fr-FR") + " F" : "—"}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        l.taux_atteinte >= 100
                          ? "bg-green-100 text-green-700"
                          : l.taux_atteinte >= 70
                          ? "bg-amber-100 text-amber-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {l.objectif_mensuel > 0 ? l.taux_atteinte.toFixed(0) + "%" : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-400 mt-6">
        Ne sont affichés que le CA, la commission OCI et les points de barème — jamais la prime
        individuelle ni un salaire.
      </p>
    </div>
  );
}
