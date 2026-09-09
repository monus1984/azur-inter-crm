import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

interface KpiMois {
  ca: number;
  commission: number;
  nb_ventes: number;
  objectif_oci: number;
  points: number;
  quota_points: number;
}

interface LigneMois {
  mois: string;
  ca: number;
  commission: number;
  nb: number;
}

function moisLabel(iso: string): string {
  const [y, m] = iso.split("-");
  return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString("fr-FR", {
    month: "short",
    year: "2-digit",
  });
}

function pct(val: number, total: number): number {
  return total > 0 ? Math.round((val / total) * 100) : 0;
}

export default function Dashboard({ profile }: Props) {
  const [kpi, setKpi] = useState<KpiMois | null>(null);
  const [historique, setHistorique] = useState<LigneMois[]>([]);
  const [loading, setLoading] = useState(true);

  const moisCourant = new Date();
  const debutMois = new Date(moisCourant.getFullYear(), moisCourant.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const finMois = new Date(moisCourant.getFullYear(), moisCourant.getMonth() + 1, 1)
    .toISOString()
    .slice(0, 10);
  const moisCourantLabel = moisCourant.toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
  });

  const source = profile.role === "superviseur" ? "sales_superviseur" : "sales";

  useEffect(() => {
    async function charger() {
      setLoading(true);

      // Ventes du mois courant
      const { data: ventesMois } = await supabase
        .from(source)
        .select("ca_ttc, commission_oci, points")
        .eq("est_avoir", false)
        .in("statut", ["validee", "en_attente_oci"])
        .gte("date_vente", debutMois)
        .lt("date_vente", finMois);

      // Objectif OCI du mois
      const { data: objectifs } = await supabase
        .from("objectifs")
        .select("montant")
        .eq("mois", debutMois)
        .eq("profile_id", profile.role === "commercial" ? profile.id : null);

      // Quota points du mois (si commercial)
      const { data: quotaData } = await supabase
        .from("objectifs_points")
        .select("quota_points")
        .eq("mois", debutMois)
        .eq("profile_id", profile.id)
        .maybeSingle();

      const ventes = ventesMois ?? [];
      const ca = ventes.reduce((s, v) => s + (v.ca_ttc || 0), 0);
      const commission = ventes.reduce((s, v) => s + (v.commission_oci || 0), 0);
      const points = ventes.reduce((s, v) => s + (v.points || 0), 0);
      const objectif_oci = (objectifs ?? []).reduce((s, o) => s + (o.montant || 0), 0);

      setKpi({
        ca,
        commission,
        nb_ventes: ventes.length,
        objectif_oci,
        points,
        quota_points: quotaData?.quota_points ?? 100,
      });

      // Historique 6 derniers mois
      const { data: hist } = await supabase
        .from(source)
        .select("date_vente, ca_ttc, commission_oci")
        .eq("est_avoir", false)
        .in("statut", ["validee", "en_attente_oci"])
        .gte("date_vente", new Date(moisCourant.getFullYear(), moisCourant.getMonth() - 5, 1)
          .toISOString().slice(0, 10))
        .lt("date_vente", finMois);

      const byMois: Record<string, LigneMois> = {};
      (hist ?? []).forEach((v) => {
        const m = (v.date_vente as string).slice(0, 7);
        if (!byMois[m]) byMois[m] = { mois: m, ca: 0, commission: 0, nb: 0 };
        byMois[m].ca += v.ca_ttc || 0;
        byMois[m].commission += v.commission_oci || 0;
        byMois[m].nb += 1;
      });

      setHistorique(Object.values(byMois).sort((a, b) => a.mois.localeCompare(b.mois)));
      setLoading(false);
    }
    charger();
  }, [profile.id, profile.role]);

  if (loading) return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;

  const taux_oci = pct(kpi?.ca ?? 0, kpi?.objectif_oci ?? 0);
  const taux_points = kpi ? pct(kpi.points, kpi.quota_points) : 0;

  // Calcule le max CA pour les barres de l'historique
  const maxCa = Math.max(...historique.map((h) => h.ca), 1);

  return (
    <div className="p-6 max-w-4xl">
      {/* En-tête */}
      <div className="mb-8">
        <p className="text-xs text-slate-400 uppercase tracking-wide mb-1 capitalize">
          {moisCourantLabel}
        </p>
        <h1 className="text-2xl font-semibold text-slate-900">
          {profile.role === "commercial"
            ? `Bonjour, ${profile.nom.split(" ")[0]}`
            : profile.role === "superviseur"
            ? "Performance équipe"
            : "Vue d'ensemble"}
        </h1>
      </div>

      {/* KPIs principaux */}
      <div className="grid grid-cols-2 gap-3 mb-8 sm:grid-cols-4">
        <div className="bg-slate-900 text-white rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">CA ce mois</div>
          <div className="text-xl font-semibold">
            {(kpi?.ca ?? 0).toLocaleString("fr-FR")}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">FCFA</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-1">Commission OCI</div>
          <div className="text-xl font-semibold text-slate-900">
            {(kpi?.commission ?? 0).toLocaleString("fr-FR")}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">FCFA HT</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-1">Ventes validées</div>
          <div className="text-xl font-semibold text-slate-900">{kpi?.nb_ventes ?? 0}</div>
          <div className="text-xs text-slate-400 mt-0.5">ce mois</div>
        </div>

        {profile.role === "commercial" ? (
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-2">Quota Azur</div>
            <div className="flex items-end gap-1">
              <span className="text-xl font-semibold text-slate-900">
                {Math.round(kpi?.points ?? 0)}
              </span>
              <span className="text-xs text-slate-400 mb-0.5">/ {kpi?.quota_points} pts</span>
            </div>
            <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${taux_points >= 100 ? "bg-green-500" : "bg-amber-400"}`}
                style={{ width: `${Math.min(taux_points, 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-2">Objectif OCI</div>
            <div className="text-xl font-semibold text-slate-900">{taux_oci}%</div>
            <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${taux_oci >= 100 ? "bg-green-500" : taux_oci >= 70 ? "bg-amber-400" : "bg-red-400"}`}
                style={{ width: `${Math.min(taux_oci, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Graphique historique 6 mois */}
      {historique.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-medium text-slate-900 mb-4">Évolution sur 6 mois</h2>
          <div className="flex items-end gap-2 h-28">
            {historique.map((h) => (
              <div key={h.mois} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex flex-col justify-end" style={{ height: "88px" }}>
                  {/* Barre CA */}
                  <div
                    className="w-full bg-slate-900 rounded-t"
                    style={{ height: `${Math.round((h.ca / maxCa) * 80)}px` }}
                    title={`CA : ${h.ca.toLocaleString("fr-FR")} F`}
                  />
                </div>
                <span className="text-xs text-slate-400">{moisLabel(h.mois)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex gap-6 text-xs text-slate-500">
            <span>
              Meilleur mois :{" "}
              <span className="text-slate-900 font-medium">
                {Math.max(...historique.map((h) => h.ca)).toLocaleString("fr-FR")} F
              </span>
            </span>
            <span>
              Total 6 mois :{" "}
              <span className="text-slate-900 font-medium">
                {historique.reduce((s, h) => s + h.ca, 0).toLocaleString("fr-FR")} F
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Tableau récapitulatif */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h2 className="text-sm font-medium text-slate-900">Détail par mois</h2>
        </div>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
              <th className="px-5 py-2 font-medium">Mois</th>
              <th className="px-5 py-2 font-medium text-right">Ventes</th>
              <th className="px-5 py-2 font-medium text-right">CA TTC</th>
              <th className="px-5 py-2 font-medium text-right">Commission OCI</th>
            </tr>
          </thead>
          <tbody>
            {[...historique].reverse().map((h, i) => (
              <tr
                key={h.mois}
                className={`border-b border-slate-50 ${i === 0 ? "bg-slate-50" : ""}`}
              >
                <td className="px-5 py-2.5 text-slate-700 capitalize">
                  {new Date(h.mois + "-01").toLocaleDateString("fr-FR", {
                    month: "long",
                    year: "numeric",
                  })}
                  {i === 0 && (
                    <span className="ml-2 text-xs text-slate-400">(en cours)</span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-slate-700 text-right">{h.nb}</td>
                <td className="px-5 py-2.5 text-slate-900 text-right font-medium">
                  {h.ca.toLocaleString("fr-FR")} F
                </td>
                <td className="px-5 py-2.5 text-slate-700 text-right">
                  {h.commission.toLocaleString("fr-FR")} F
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
