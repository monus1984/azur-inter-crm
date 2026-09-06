import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile, Sale } from "../types/database";

interface Props {
  profile: Profile;
}

export default function Ventes({ profile }: Props) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [aSupprimer, setASupprimer] = useState<Sale | null>(null);
  const [suppression, setSuppression] = useState(false);

  const source = profile.role === "superviseur" ? "sales_superviseur" : "sales";

  async function charger() {
    setLoading(true);
    const { data } = await supabase
      .from(source)
      .select("*")
      .order("date_vente", { ascending: false })
      .limit(200);
    setSales((data ?? []) as Sale[]);
    setLoading(false);
  }

  useEffect(() => {
    charger();
  }, [profile.role]);

  async function confirmerSuppression() {
    if (!aSupprimer) return;
    setSuppression(true);
    // La suppression reste tracée dans audit_logs par le trigger existant
    // (trace_sales) — rien n'est perdu sans laisser d'historique.
    const { error } = await supabase.from("sales").delete().eq("id", aSupprimer.id);
    if (error) {
      alert("Erreur lors de la suppression : " + error.message);
    } else {
      setSales((prev) => prev.filter((s) => s.id !== aSupprimer.id));
    }
    setASupprimer(null);
    setSuppression(false);
  }

  if (loading) {
    return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-6">Ventes</h1>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Agence</th>
              <th className="py-2 pr-4 font-medium">Offre</th>
              <th className="py-2 pr-4 font-medium">CA TTC</th>
              <th className="py-2 pr-4 font-medium">Statut</th>
              {profile.role === "admin" && <th className="py-2 pr-4 font-medium"></th>}
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-700">{s.date_vente ?? "—"}</td>
                <td className="py-2 pr-4 text-slate-700">{s.agence}</td>
                <td className="py-2 pr-4 text-slate-700">{s.offre}</td>
                <td className="py-2 pr-4 text-slate-700">
                  {s.ca_ttc.toLocaleString("fr-FR")} F
                </td>
                <td className="py-2 pr-4">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {s.statut}
                  </span>
                </td>
                {profile.role === "admin" && (
                  <td className="py-2 pr-4">
                    <button
                      onClick={() => setASupprimer(s)}
                      className="text-xs text-red-500 hover:text-red-700 hover:underline"
                    >
                      Supprimer
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Confirmation obligatoire avant toute suppression — action irréversible */}
      {aSupprimer && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-sm w-full">
            <h2 className="text-sm font-semibold text-slate-900 mb-2">Supprimer cette vente ?</h2>
            <p className="text-xs text-slate-600 mb-4">
              {aSupprimer.offre} — {aSupprimer.ca_ttc.toLocaleString("fr-FR")} F —{" "}
              {aSupprimer.date_vente ?? "date inconnue"}
              <br />
              Cette action est définitive. L'opération reste tracée dans le journal d'audit.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setASupprimer(null)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md"
              >
                Annuler
              </button>
              <button
                onClick={confirmerSuppression}
                disabled={suppression}
                className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
              >
                {suppression ? "Suppression..." : "Supprimer définitivement"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
