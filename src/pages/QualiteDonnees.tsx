import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

interface Resume {
  sans_facture: number;
  sans_agent: number;
  sans_date: number;
  factures_en_doublon: number;
  en_backlog: number;
  transactions_oci_disponibles: number;
  reconciliations_faites: number;
}

interface LigneDoublon {
  id: number;
  n_facture: string;
  offre: string;
  ca_ttc: number;
  date_vente: string | null;
  nb_doublons_lies: number;
}

export default function QualiteDonnees({ profile }: Props) {
  const [resume, setResume] = useState<Resume | null>(null);
  const [doublons, setDoublons] = useState<LigneDoublon[]>([]);
  const [loading, setLoading] = useState(true);
  const [aSupprimer, setASupprimer] = useState<LigneDoublon | null>(null);

  if (profile.role !== "admin" && profile.role !== "dg") {
    return (
      <div className="p-8 text-slate-500 text-sm">
        Accès réservé à l'administrateur et à la direction générale.
      </div>
    );
  }

  async function charger() {
    setLoading(true);
    const [{ data: r }, { data: d }] = await Promise.all([
      supabase.from("qualite_resume").select("*").single(),
      supabase.from("qualite_doublons").select("*").order("n_facture"),
    ]);
    setResume(r as Resume);
    setDoublons((d ?? []) as LigneDoublon[]);
    setLoading(false);
  }

  useEffect(() => {
    charger();
  }, []);

  async function supprimerDoublon() {
    if (!aSupprimer || profile.role !== "admin") return;
    await supabase.from("sales").delete().eq("id", aSupprimer.id);
    setASupprimer(null);
    charger();
  }

  if (loading) return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;
  if (!resume) return <div className="p-8 text-slate-500 text-sm">Aucune donnée.</div>;

  const carte = (label: string, valeur: number, alerte: boolean) => (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${alerte && valeur > 0 ? "text-amber-600" : "text-slate-900"}`}>
        {valeur}
      </div>
    </div>
  );

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Qualité des données</h1>
      <p className="text-sm text-slate-500 mb-6">
        Contrôles sur les données Azur elles-mêmes. La réconciliation OCI (comparaison avec les
        transactions officielles du partenaire) reste séparée — voir en bas de page.
      </p>

      <div className="grid grid-cols-3 gap-4 mb-8">
        {carte("Ventes sans facture", resume.sans_facture, true)}
        {carte("Ventes sans agent", resume.sans_agent, true)}
        {carte("Ventes sans date", resume.sans_date, true)}
        {carte("Factures en doublon", resume.factures_en_doublon, true)}
        {carte("En attente au backlog", resume.en_backlog, false)}
        {carte("Transactions OCI en base", resume.transactions_oci_disponibles, false)}
      </div>

      <h2 className="text-sm font-semibold text-slate-900 mb-3">
        Doublons détectés (même facture, même offre, même montant)
      </h2>

      {doublons.length === 0 ? (
        <p className="text-sm text-slate-500 mb-8">Aucun doublon détecté actuellement.</p>
      ) : (
        <div className="overflow-x-auto mb-8">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-4 font-medium">Facture</th>
                <th className="py-2 pr-4 font-medium">Offre</th>
                <th className="py-2 pr-4 font-medium">Montant</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Occurrences liées</th>
                {profile.role === "admin" && <th className="py-2 pr-4 font-medium"></th>}
              </tr>
            </thead>
            <tbody>
              {doublons.map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 text-slate-700">{d.n_facture}</td>
                  <td className="py-2 pr-4 text-slate-700">{d.offre}</td>
                  <td className="py-2 pr-4 text-slate-700">{d.ca_ttc.toLocaleString("fr-FR")} F</td>
                  <td className="py-2 pr-4 text-slate-700">{d.date_vente ?? "—"}</td>
                  <td className="py-2 pr-4">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      +{d.nb_doublons_lies}
                    </span>
                  </td>
                  {profile.role === "admin" && (
                    <td className="py-2 pr-4">
                      <button
                        onClick={() => setASupprimer(d)}
                        className="text-xs text-red-500 hover:text-red-700 hover:underline"
                      >
                        Supprimer cette ligne
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-slate-200 pt-6">
        <h2 className="text-sm font-semibold text-slate-900 mb-2">Réconciliation OCI</h2>
        {resume.transactions_oci_disponibles === 0 ? (
          <p className="text-sm text-slate-500">
            Aucune transaction OCI importée pour l'instant — la réconciliation n'est pas encore
            possible. Elle nécessite un export officiel du partenaire (relevé de transactions ou
            facture partenaire).
          </p>
        ) : (
          <p className="text-sm text-slate-500">
            {resume.transactions_oci_disponibles} transaction(s) OCI en base,{" "}
            {resume.reconciliations_faites} déjà réconciliée(s).
          </p>
        )}
      </div>

      {aSupprimer && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-sm w-full">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Supprimer cette ligne ?</h2>
            <p className="text-xs text-slate-600 mb-4">
              {aSupprimer.n_facture} — {aSupprimer.offre} — {aSupprimer.ca_ttc.toLocaleString("fr-FR")} F
              <br />
              Vérifiez que c'est bien le doublon à retirer, pas la ligne d'origine. L'opération reste
              tracée dans le journal d'audit.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setASupprimer(null)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md"
              >
                Annuler
              </button>
              <button
                onClick={supprimerDoublon}
                className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
