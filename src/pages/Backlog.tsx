import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { deviserUnivers } from "../lib/univers";
import type { Profile, Sale } from "../types/database";

interface Props {
  profile: Profile;
}

interface LigneBacklog extends Sale {
  agentNom?: string;
  modifiePar?: string;
}

const AGENCES = [
  "Angré 7ème Tranche", "Angré Djibi", "SmartStore",
  "Plateau Nord / Pyramide", "Adjamé Mosquée", "Adjamé 220 Logts", "Bassam",
];

export default function Backlog({ profile }: Props) {
  const [lignes, setLignes] = useState<LigneBacklog[]>([]);
  const [profils, setProfils] = useState<{ id: string; nom: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [vue, setVue] = useState<"a_traiter" | "historique">("a_traiter");

  const estAdmin = profile.role === "admin";
  const estSuperviseur = profile.role === "superviseur";

  async function charger() {
    setLoading(true);

    // Admin lit la table sales directement (accès complet). Le superviseur
    // lit sales_superviseur, qui exclut la colonne prime — technique, pas
    // seulement une convention d'interface.
    const table = estAdmin ? "sales" : "sales_superviseur";
    const statutFiltre = vue === "a_traiter" ? "incomplete" : "saisie";

    const { data: salesData } = await supabase
      .from(table)
      .select("*")
      .eq("statut", statutFiltre)
      .order("cree_le", { ascending: true });

    const { data: profilsData } = await supabase.from("profiles").select("id, nom");
    setProfils(profilsData ?? []);

    const nomById = new Map((profilsData ?? []).map(p => [p.id, p.nom]));
    setLignes(
      (salesData ?? []).map((s: Sale & { modifie_par?: string }) => ({
        ...s,
        agentNom: s.profile_id ? nomById.get(s.profile_id) : undefined,
        modifiePar: s.modifie_par ? nomById.get(s.modifie_par) : undefined,
      }))
    );
    setLoading(false);
  }

  useEffect(() => { charger(); }, [vue]);

  function updateChamp(id: number, field: keyof LigneBacklog, value: string | number) {
    setLignes(prev => prev.map(l => l.id === id ? { ...l, [field]: value } : l));
  }

  async function completer(ligne: LigneBacklog) {
    if (!ligne.profile_id || !ligne.date_vente || !ligne.ca_ttc) {
      alert("Agent, date et montant sont requis avant de compléter cette ligne.");
      return;
    }
    setSaving(ligne.id);

    const { error } = await supabase
      .from("sales")
      .update({
        profile_id: ligne.profile_id,
        date_vente: ligne.date_vente,
        agence: ligne.agence,
        offre: ligne.offre,
        univers: deviserUnivers(ligne.offre),
        ca_ttc: ligne.ca_ttc,
        prix_unitaire: ligne.ca_ttc,
        n_facture: ligne.n_facture,
        statut: "saisie",
      })
      .eq("id", ligne.id);

    if (error) {
      alert("Erreur : " + error.message);
    } else {
      setLignes(prev => prev.filter(l => l.id !== ligne.id));
    }
    setSaving(null);
  }

  if (loading) return <div className="p-8 text-slate-500 text-sm">Chargement...</div>;

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Backlog d'import</h1>
      <p className="text-sm text-slate-500 mb-4">
        {estSuperviseur
          ? "Complétez les lignes importées avec des informations manquantes."
          : "Lignes importées automatiquement, incomplètes ou déjà complétées par le superviseur."}
      </p>

      {estAdmin && (
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setVue("a_traiter")}
            className={`px-3 py-1.5 text-xs rounded-md font-medium ${vue === "a_traiter" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
          >
            À compléter
          </button>
          <button
            onClick={() => setVue("historique")}
            className={`px-3 py-1.5 text-xs rounded-md font-medium ${vue === "historique" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}
          >
            Complétées récemment
          </button>
        </div>
      )}

      {lignes.length === 0 ? (
        <p className="text-sm text-slate-500">Rien à afficher ici pour le moment.</p>
      ) : (
        <div className="space-y-3">
          {lignes.map(l => (
            <div key={l.id} className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="grid grid-cols-6 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Facture</label>
                  <div className="text-xs text-slate-700">{l.n_facture || "—"}</div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Agent</label>
                  {vue === "a_traiter" ? (
                    <select
                      value={l.profile_id ?? ""}
                      onChange={e => updateChamp(l.id, "profile_id", e.target.value)}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                    >
                      <option value="">— choisir —</option>
                      {profils.map(p => <option key={p.id} value={p.id}>{p.nom}</option>)}
                    </select>
                  ) : (
                    <div className="text-xs text-slate-700">{l.agentNom || "—"}</div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Date</label>
                  {vue === "a_traiter" ? (
                    <input
                      type="date"
                      value={l.date_vente ?? ""}
                      onChange={e => updateChamp(l.id, "date_vente", e.target.value)}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                    />
                  ) : (
                    <div className="text-xs text-slate-700">{l.date_vente}</div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Agence</label>
                  {vue === "a_traiter" ? (
                    <select
                      value={l.agence}
                      onChange={e => updateChamp(l.id, "agence", e.target.value)}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                    >
                      {AGENCES.map(a => <option key={a}>{a}</option>)}
                    </select>
                  ) : (
                    <div className="text-xs text-slate-700">{l.agence}</div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Offre</label>
                  {vue === "a_traiter" ? (
                    <input
                      type="text"
                      value={l.offre}
                      onChange={e => updateChamp(l.id, "offre", e.target.value)}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                    />
                  ) : (
                    <div className="text-xs text-slate-700">{l.offre}</div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Montant TTC</label>
                  {vue === "a_traiter" ? (
                    <input
                      type="number"
                      value={l.ca_ttc || ""}
                      onChange={e => updateChamp(l.id, "ca_ttc", parseFloat(e.target.value))}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs text-right"
                    />
                  ) : (
                    <div className="text-xs text-slate-700 text-right">
                      {l.ca_ttc.toLocaleString("fr-FR")} F
                    </div>
                  )}
                </div>
              </div>

              {vue === "a_traiter" && (
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => completer(l)}
                    disabled={saving === l.id}
                    className="px-3 py-1.5 text-xs bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
                  >
                    {saving === l.id ? "..." : "Compléter et envoyer en validation"}
                  </button>
                </div>
              )}

              {vue === "historique" && l.modifiePar && (
                <div className="mt-2 text-xs text-slate-400">
                  Complétée par {l.modifiePar}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
