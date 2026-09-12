import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile, Sale } from "../types/database";

interface Props {
  profile: Profile;
}

interface SaleWithAgent extends Sale {
  agent_nom?: string;
}

// Statuts en attente de traitement par l'admin
const STATUTS_A_VALIDER = ["en_attente_oci"] as const;
const STATUTS_HISTORIQUE = ["validee", "rejetee", "annulee"] as const;

type Vue = "a_valider" | "historique";

export default function Validation({ profile }: Props) {
  const [sales, setSales] = useState<SaleWithAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<number | null>(null);
  const [vue, setVue] = useState<Vue>("a_valider");
  const [stats, setStats] = useState({ en_attente: 0, validees_mois: 0 });

  if (profile.role !== "admin") {
    return (
      <div className="p-8 text-slate-500 text-sm">
        Accès réservé à l'administrateur.
      </div>
    );
  }

  async function load() {
    setLoading(true);

    // Stats globales
    const { data: comptage } = await supabase
      .from("sales")
      .select("statut")
      .in("statut", ["en_attente_oci", "validee"]);

    const debutMois = new Date();
    debutMois.setDate(1);
    const debutMoisIso = debutMois.toISOString().slice(0, 10);

    const enAttente = (comptage ?? []).filter(s => s.statut === "en_attente_oci").length;
    const validesMois = (comptage ?? []).filter(s => s.statut === "validee").length;
    setStats({ en_attente: enAttente, validees_mois: validesMois });

    // Ventes selon la vue
    const statutsFiltre = vue === "a_valider"
      ? STATUTS_A_VALIDER
      : STATUTS_HISTORIQUE;

    const { data: salesData, error } = await supabase
      .from("sales")
      .select("*")
      .in("statut", [...statutsFiltre])
      .order("cree_le", { ascending: vue === "a_valider" })
      .limit(200);

    if (error) {
      console.error("Erreur chargement:", error.message);
      setSales([]);
      setLoading(false);
      return;
    }

    if (!salesData || salesData.length === 0) {
      setSales([]);
      setLoading(false);
      return;
    }

    const profileIds = [...new Set(salesData.map(s => s.profile_id).filter(Boolean))];
    const { data: profilesData } = await supabase
      .from("profiles")
      .select("id, nom")
      .in("id", profileIds);

    const nomById = new Map((profilesData ?? []).map(p => [p.id, p.nom]));

    setSales(
      salesData.map((s: Sale) => ({
        ...s,
        agent_nom: nomById.get(s.profile_id ?? "") ?? "—",
      }))
    );
    setLoading(false);
  }

  useEffect(() => { load(); }, [vue]);

  async function valider(id: number) {
    setProcessing(id);
    await supabase
      .from("sales")
      .update({
        statut: "validee",
        valide_par: profile.id,
        valide_le: new Date().toISOString(),
      })
      .eq("id", id);
    setSales(prev => prev.filter(s => s.id !== id));
    setStats(prev => ({ ...prev, en_attente: prev.en_attente - 1, validees_mois: prev.validees_mois + 1 }));
    setProcessing(null);
  }

  async function rejeter(id: number) {
    setProcessing(id);
    await supabase
      .from("sales")
      .update({
        statut: "rejetee",
        valide_par: profile.id,
        valide_le: new Date().toISOString(),
      })
      .eq("id", id);
    setSales(prev => prev.filter(s => s.id !== id));
    setStats(prev => ({ ...prev, en_attente: prev.en_attente - 1 }));
    setProcessing(null);
  }

  async function toutValider() {
    if (!confirm(`Valider toutes les ${sales.length} ventes en attente ?`)) return;
    setProcessing(-1);
    await supabase
      .from("sales")
      .update({
        statut: "validee",
        valide_par: profile.id,
        valide_le: new Date().toISOString(),
      })
      .in("statut", ["en_attente_oci"]);
    await load();
    setProcessing(null);
  }

  const statutBadge = (statut: string) => {
    const styles: Record<string, string> = {
      en_attente_oci: "bg-amber-100 text-amber-700",
      validee: "bg-green-100 text-green-700",
      rejetee: "bg-red-100 text-red-700",
      annulee: "bg-slate-100 text-slate-500",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full ${styles[statut] ?? "bg-slate-100 text-slate-600"}`}>
        {statut.replace("_", " ")}
      </span>
    );
  };

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Validation des ventes</h1>

      {/* Stats */}
      <div className="flex gap-3 mb-6">
        <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3">
          <div className="text-xs text-amber-600 mb-0.5">En attente OCI</div>
          <div className="text-lg font-semibold text-amber-700">{stats.en_attente}</div>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-lg px-4 py-3">
          <div className="text-xs text-green-600 mb-0.5">Validées (total)</div>
          <div className="text-lg font-semibold text-green-700">{stats.validees_mois}</div>
        </div>
      </div>

      {/* Onglets */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setVue("a_valider")}
          className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
            vue === "a_valider" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          À valider ({stats.en_attente})
        </button>
        <button
          onClick={() => setVue("historique")}
          className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
            vue === "historique" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          Historique
        </button>
        {vue === "a_valider" && sales.length > 1 && (
          <button
            onClick={toutValider}
            disabled={processing === -1}
            className="ml-auto px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            {processing === -1 ? "En cours..." : `Tout valider (${sales.length})`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-slate-400">Chargement...</div>
      ) : sales.length === 0 ? (
        <div className="text-sm text-slate-500">
          {vue === "a_valider"
            ? "Aucune vente en attente de validation."
            : "Aucun historique à afficher."}
        </div>
      ) : (
        <div className="space-y-2">
          {sales.map(s => (
            <div
              key={s.id}
              className="bg-white border border-slate-200 rounded-lg p-4 flex items-start justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-sm font-medium text-slate-900">{s.offre}</span>
                  {statutBadge(s.statut)}
                </div>
                <div className="text-xs text-slate-500 space-y-0.5">
                  <div>
                    {s.agent_nom} · {s.agence} · {s.date_vente ?? "—"}
                  </div>
                  {s.client && <div>Client : {s.client}</div>}
                  <div className="font-medium text-slate-700">
                    {s.ca_ttc.toLocaleString("fr-FR")} F TTC
                    {s.n_facture && ` · ${s.n_facture}`}
                    {s.n_journal && ` · J.${s.n_journal}`}
                  </div>
                </div>
              </div>

              {vue === "a_valider" && (
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => rejeter(s.id)}
                    disabled={processing === s.id}
                    className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50"
                  >
                    Rejeter
                  </button>
                  <button
                    onClick={() => valider(s.id)}
                    disabled={processing === s.id}
                    className="px-3 py-1.5 text-xs bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
                  >
                    {processing === s.id ? "..." : "Valider"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
