import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile, Sale } from "../types/database";

interface Props {
  profile: Profile;
}

interface SaleWithAgent extends Sale {
  agent_nom?: string;
}

export default function Validation({ profile }: Props) {
  const [sales, setSales] = useState<SaleWithAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<number | null>(null);

  // Seul l'admin accède à cette page
  if (profile.role !== "admin") {
    return (
      <div className="p-8 text-slate-500 text-sm">
        Accès réservé à l'administrateur.
      </div>
    );
  }

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("sales")
      .select("*, profiles(nom)")
      .eq("statut", "saisie")
      .order("cree_le", { ascending: true });

    if (data) {
      setSales(
        data.map((s: Sale & { profiles?: { nom: string } }) => ({
          ...s,
          agent_nom: s.profiles?.nom ?? "—",
        }))
      );
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function updateStatut(id: number, statut: "en_attente_oci" | "rejetee") {
    setProcessing(id);
    await supabase
      .from("sales")
      .update({
        statut,
        valide_par: profile.id,
        valide_le: new Date().toISOString(),
      })
      .eq("id", id);
    await load();
    setProcessing(null);
  }

  if (loading) return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Validation des ventes</h1>
      <p className="text-sm text-slate-500 mb-6">
        {sales.length} vente{sales.length > 1 ? "s" : ""} en attente de validation.
      </p>

      {sales.length === 0 ? (
        <p className="text-sm text-slate-500">Aucune vente à valider pour le moment.</p>
      ) : (
        <div className="space-y-3">
          {sales.map(s => (
            <div
              key={s.id}
              className="bg-white border border-slate-200 rounded-lg p-4 flex items-start justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-slate-900">{s.offre}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                    {s.statut}
                  </span>
                </div>
                <div className="text-xs text-slate-500 space-y-0.5">
                  <div>{s.agent_nom} · {s.agence} · {s.date_vente}</div>
                  {s.client && <div>Client : {s.client}</div>}
                  <div className="font-medium text-slate-700">
                    {s.ca_ttc.toLocaleString("fr-FR")} F TTC
                    {s.n_facture && ` · ${s.n_facture}`}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => updateStatut(s.id, "rejetee")}
                  disabled={processing === s.id}
                  className="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50"
                >
                  Rejeter
                </button>
                <button
                  onClick={() => updateStatut(s.id, "en_attente_oci")}
                  disabled={processing === s.id}
                  className="px-3 py-1.5 text-xs bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
                >
                  {processing === s.id ? "..." : "Valider"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
