import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { parseTexteFactures, type LigneExtraiteOCI } from "../lib/parseFacturesOCI";
import type { Profile, UniversOffre } from "../types/database";

interface Props {
  profile: Profile;
}

interface LigneRevue extends LigneExtraiteOCI {
  selected: boolean;
  profileId: string | null; // résolu depuis agentNom via la table profiles
}

function deviserUnivers(offre: string): UniversOffre {
  const l = offre.toLowerCase();
  if (l.includes("mix") || l.includes("community") || l.includes("sms")) return "MOBILE";
  if (l.includes("topup") || l.includes("flybox") || l.includes("easybox") || l.includes("fibre")) return "INTERNET";
  if (l.includes("office") || l.includes("ict")) return "ICT";
  return "AUTRES";
}

export default function ImportPDF({ profile }: Props) {
  const [texteCollee, setTexteCollee] = useState("");
  const [lignes, setLignes] = useState<LigneRevue[]>([]);
  const [profilesByNom, setProfilesByNom] = useState<Map<string, string>>(new Map());
  const [step, setStep] = useState<"saisie" | "review" | "done">("saisie");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importCount, setImportCount] = useState(0);

  // Charge la table des profils une fois, pour résoudre nom -> profile_id
  // lors de l'extraction. Nécessaire pour attribuer chaque ligne au bon
  // commercial plutôt qu'à l'importateur.
  useEffect(() => {
    supabase.from("profiles").select("id, nom").then(({ data }) => {
      if (data) {
        const map = new Map<string, string>();
        data.forEach((p: { id: string; nom: string }) => map.set(p.nom, p.id));
        setProfilesByNom(map);
      }
    });
  }, []);

  function handleExtraire() {
    setError(null);
    if (texteCollee.trim().length < 50) {
      setError("Le texte semble trop court. Collez le contenu complet copié depuis Word.");
      return;
    }

    const extraites = parseTexteFactures(texteCollee);

    if (extraites.length === 0) {
      setError(
        "Aucune facture détectée. Vérifiez que le texte contient bien des lignes " +
        "\"N°recu-facture:OCI-...\" — c'est le repère utilisé pour découper les reçus."
      );
      return;
    }

    const revues: LigneRevue[] = extraites.map(l => ({
      ...l,
      selected: l.confiance !== 'faible', // pré-coché sauf si peu fiable
      profileId: l.agentNom ? profilesByNom.get(l.agentNom) ?? null : null,
    }));

    setLignes(revues);
    setStep("review");
  }

  function toggleLigne(i: number) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, selected: !l.selected } : l));
  }

  function updateLigne(i: number, field: keyof LigneRevue, value: string | number | boolean) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, [field]: value } : l));
  }

  async function handleImport() {
    const selection = lignes.filter(l => l.selected);
    if (selection.length === 0) { setError("Sélectionnez au moins une ligne."); return; }

    const sansAgent = selection.filter(l => !l.profileId);
    if (sansAgent.length > 0) {
      setError(
        `${sansAgent.length} ligne(s) sélectionnée(s) n'ont pas d'agent identifié. ` +
        `Désélectionnez-les ou complétez le nom avant d'importer.`
      );
      return;
    }
    if (selection.some(l => !l.date || l.montant === null)) {
      setError("Certaines lignes sélectionnées n'ont pas de date ou de montant valide.");
      return;
    }

    setLoading(true);
    setError(null);

    const { error: err } = await supabase.from("sales").insert(
      selection.map(l => ({
        profile_id: l.profileId,
        date_vente: l.date,
        agence: l.agence || "—",
        univers: deviserUnivers(l.offre),
        offre: l.offre,
        client: null,
        quantite: 1,
        prix_unitaire: l.montant,
        ca_ttc: l.montant,
        commission_oci: 0,
        points: 0,
        prime: 0,
        n_facture: l.nFacture,
        statut: "saisie",
        est_avoir: l.estAvoir,
        cree_par: profile.id,
      }))
    );

    if (err) {
      setError("Erreur lors de l'import : " + err.message);
    } else {
      setImportCount(selection.length);
      setStep("done");
    }
    setLoading(false);
  }

  const confianceBadge = (c: LigneExtraiteOCI['confiance']) => {
    const styles = {
      haute: "bg-green-100 text-green-700",
      moyenne: "bg-amber-100 text-amber-700",
      faible: "bg-red-100 text-red-700",
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[c]}`}>{c}</span>;
  };

  if (step === "done") {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">Import terminé</h1>
        <p className="text-sm text-slate-600 mb-4">
          {importCount} vente{importCount > 1 ? "s" : ""} enregistrée{importCount > 1 ? "s" : ""}
          {" "}avec le statut "saisie", en attente de validation.
        </p>
        <button
          onClick={() => { setStep("saisie"); setTexteCollee(""); setLignes([]); }}
          className="text-sm text-slate-600 underline"
        >
          Importer un autre lot
        </button>
      </div>
    );
  }

  if (step === "review") {
    const nbSansAgent = lignes.filter(l => l.selected && !l.profileId).length;
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Vérification avant import</h1>
        <p className="text-sm text-slate-500 mb-4">
          {lignes.length} facture{lignes.length > 1 ? "s" : ""} détectée{lignes.length > 1 ? "s" : ""}.
          Corrigez les champs si besoin avant d'importer.
        </p>

        {nbSansAgent > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-2 text-sm text-amber-800 mb-4">
            {nbSansAgent} ligne(s) sélectionnée(s) n'ont pas d'agent reconnu automatiquement.
          </div>
        )}

        <div className="space-y-2 mb-6 max-h-[60vh] overflow-y-auto">
          {lignes.map((l, i) => (
            <div
              key={i}
              className={`border rounded-lg p-3 text-sm ${l.selected ? "border-slate-300" : "border-slate-100 opacity-50"}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={l.selected}
                  onChange={() => toggleLigne(i)}
                  className="mt-1"
                />
                <div className="flex-1 grid grid-cols-6 gap-2 items-center">
                  <span className="col-span-1 text-xs text-slate-500 truncate" title={l.nFacture}>
                    {l.nFacture}
                  </span>
                  <input
                    type="date"
                    value={l.date ?? ""}
                    onChange={e => updateLigne(i, "date", e.target.value)}
                    className="col-span-1 border border-slate-200 rounded px-1 py-1 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Agent non reconnu"
                    value={l.agentNom ?? ""}
                    onChange={e => {
                      const nom = e.target.value;
                      updateLigne(i, "agentNom", nom);
                      updateLigne(i, "profileId", profilesByNom.get(nom) ?? "");
                    }}
                    className={`col-span-1 border rounded px-1 py-1 text-xs ${!l.profileId ? "border-red-300 bg-red-50" : "border-slate-200"}`}
                  />
                  <input
                    type="text"
                    value={l.offre}
                    onChange={e => updateLigne(i, "offre", e.target.value)}
                    className="col-span-1 border border-slate-200 rounded px-1 py-1 text-xs"
                  />
                  <input
                    type="number"
                    value={l.montant ?? ""}
                    onChange={e => updateLigne(i, "montant", parseFloat(e.target.value))}
                    className="col-span-1 border border-slate-200 rounded px-1 py-1 text-xs text-right"
                  />
                  <div className="col-span-1 flex justify-end">
                    {confianceBadge(l.confiance)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => setStep("saisie")}
            className="px-4 py-2 text-sm border border-slate-300 rounded-md"
          >
            Retour
          </button>
          <button
            onClick={handleImport}
            disabled={loading}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Import..." : `Importer ${lignes.filter(l => l.selected).length} ligne(s)`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Import de reçus OCI</h1>
      <p className="text-sm text-slate-500 mb-4">
        Copiez le texte des reçus depuis Word (ou l'export équivalent) et collez-le
        ci-dessous. Chaque reçu doit contenir une ligne "N°recu-facture:OCI-...".
      </p>

      <textarea
        value={texteCollee}
        onChange={e => setTexteCollee(e.target.value)}
        placeholder="Collez ici le texte copié depuis Word..."
        rows={14}
        className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
      />

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

      <button
        onClick={handleExtraire}
        className="mt-4 px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800"
      >
        Extraire les factures
      </button>
    </div>
  );
}
