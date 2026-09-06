import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

interface LignePaie {
  id: number;
  profile_id: string;
  nom: string;
  mois: string;
  niveau_applique: string;
  salaire_verse: number;
  points_realises: number | null;
  quota_points: number | null;
  quota_atteint: boolean | null;
  note: string | null;
}

function derniersMois(n: number): { debut: string; libelle: string }[] {
  const mois = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const debut = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    mois.push({ debut: iso(debut), libelle: debut.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }) });
  }
  return mois;
}

export default function Paie({ profile }: Props) {
  const [lignes, setLignes] = useState<LignePaie[]>([]);
  const [loading, setLoading] = useState(true);
  const optionsMois = derniersMois(12);
  const [moisChoisi, setMoisChoisi] = useState(0);
  const [editId, setEditId] = useState<number | null>(null);
  const [montantEdit, setMontantEdit] = useState("");
  const [noteEdit, setNoteEdit] = useState("");

  // Garde-fou côté client — la vraie protection est le RLS, mais on évite
  // d'afficher un écran vide sans explication.
  if (profile.role !== "admin") {
    return (
      <div className="p-8 text-slate-500 text-sm">
        Accès réservé à l'administrateur.
      </div>
    );
  }

  async function charger() {
    setLoading(true);
    const mois = optionsMois[moisChoisi].debut;
    const { data } = await supabase
      .from("remuneration")
      .select("id, profile_id, mois, niveau_applique, salaire_verse, points_realises, quota_points, quota_atteint, note")
      .eq("mois", mois);

    const { data: profils } = await supabase.from("profiles").select("id, nom");
    const nomById = new Map((profils ?? []).map((p: { id: string; nom: string }) => [p.id, p.nom]));

    setLignes(
      (data ?? [])
        .map((r) => ({ ...r, nom: nomById.get(r.profile_id) ?? "—" }))
        .sort((a, b) => a.nom.localeCompare(b.nom))
    );
    setLoading(false);
  }

  useEffect(() => {
    charger();
  }, [moisChoisi]);

  function ouvrirEdition(l: LignePaie) {
    setEditId(l.id);
    setMontantEdit(String(l.salaire_verse));
    setNoteEdit(l.note ?? "");
  }

  async function enregistrer(id: number) {
    const montant = parseFloat(montantEdit);
    if (isNaN(montant) || montant < 0) return;

    await supabase
      .from("remuneration")
      .update({ salaire_verse: montant, note: noteEdit || null })
      .eq("id", id);

    setEditId(null);
    charger();
  }

  const total = lignes.reduce((s, l) => s + l.salaire_verse, 0);

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Paie</h1>
      <div className="flex items-center gap-3 mb-6">
        <select
          value={moisChoisi}
          onChange={(e) => setMoisChoisi(parseInt(e.target.value))}
          className="text-sm border border-slate-300 rounded-md px-2 py-1 capitalize"
        >
          {optionsMois.map((m, i) => (
            <option key={m.debut} value={i} className="capitalize">{m.libelle}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Chargement...</p>
      ) : lignes.length === 0 ? (
        <p className="text-sm text-slate-500">
          Aucune ligne de paie pour ce mois. Exécutez le script de préremplissage si ce mois n'a jamais été calculé.
        </p>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 inline-block">
            <div className="text-xs text-slate-500 mb-1">Masse salariale du mois</div>
            <div className="text-lg font-semibold text-slate-900">{total.toLocaleString("fr-FR")} F</div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2 pr-4 font-medium">Commercial</th>
                  <th className="py-2 pr-4 font-medium">Niveau appliqué</th>
                  <th className="py-2 pr-4 font-medium">Points / Quota</th>
                  <th className="py-2 pr-4 font-medium">Quota</th>
                  <th className="py-2 pr-4 font-medium">Salaire</th>
                  <th className="py-2 pr-4 font-medium">Note</th>
                  <th className="py-2 pr-4 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 text-slate-900 font-medium">{l.nom}</td>
                    <td className="py-2 pr-4">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">
                        {l.niveau_applique}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      {l.points_realises?.toFixed(0) ?? "—"} / {l.quota_points?.toFixed(0) ?? "100"}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${l.quota_atteint ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {l.quota_atteint ? "Atteint" : "Non atteint"}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      {editId === l.id ? (
                        <input
                          type="number"
                          value={montantEdit}
                          onChange={(e) => setMontantEdit(e.target.value)}
                          className="w-24 border border-slate-300 rounded px-2 py-1 text-xs"
                        />
                      ) : (
                        <span className="text-slate-900 font-medium">{l.salaire_verse.toLocaleString("fr-FR")} F</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editId === l.id ? (
                        <input
                          type="text"
                          value={noteEdit}
                          onChange={(e) => setNoteEdit(e.target.value)}
                          placeholder="ex: prorata CDD"
                          className="w-32 border border-slate-300 rounded px-2 py-1 text-xs"
                        />
                      ) : (
                        <span className="text-xs text-slate-400">{l.note ?? "—"}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editId === l.id ? (
                        <div className="flex gap-2">
                          <button onClick={() => enregistrer(l.id)} className="text-xs text-slate-900 underline">Enregistrer</button>
                          <button onClick={() => setEditId(null)} className="text-xs text-slate-400">Annuler</button>
                        </div>
                      ) : (
                        <button onClick={() => ouvrirEdition(l)} className="text-xs text-slate-500 underline">Corriger</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="text-xs text-slate-400 mt-6">
        Le montant par défaut suit la règle contractuelle (Junior : 150 000 F fixe. Senior : 250 000 F si
        quota atteint, 150 000 F sinon). Correction manuelle possible pour les cas particuliers (prorata
        CDD, ajustement). Page réservée à l'administrateur — invisible au commercial concerné, au
        superviseur et à OCI.
      </p>
    </div>
  );
}
