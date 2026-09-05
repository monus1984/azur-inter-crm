import { useState, useRef } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

interface LigneExtraite {
  offre: string;
  client: string;
  ca_ttc: number;
  n_facture: string;
  selected: boolean;
}

// Extraction basique depuis le texte du PDF.
// Le parsing réel via Claude API peut être ajouté ici (Lot 2+).
function extraireLignes(text: string, nFacture: string): LigneExtraite[] {
  const lignes: LigneExtraite[] = [];
  const lines = text.split("\n").filter(l => l.trim());

  // Pattern simple : cherche des montants en F CFA ou des lignes avec prix
  const montantPattern = /(\d[\d\s]{2,})\s*(F|CFA|FCFA)?/;

  lines.forEach(line => {
    const match = line.match(montantPattern);
    if (match) {
      const montant = parseInt(match[1].replace(/\s/g, ""));
      if (montant >= 1000 && montant <= 10000000) {
        lignes.push({
          offre: line.slice(0, 60).trim(),
          client: "",
          ca_ttc: montant,
          n_facture: nFacture,
          selected: true,
        });
      }
    }
  });

  return lignes.slice(0, 20); // max 20 lignes par PDF
}

export default function ImportPDF({ profile }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [nFacture, setNFacture] = useState("");
  const [agence, setAgence] = useState("");
  const [lignes, setLignes] = useState<LigneExtraite[]>([]);
  const [step, setStep] = useState<"upload" | "review" | "done">("upload");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    if (!nFacture) { setError("Saisissez d'abord le numéro de facture."); return; }
    setError(null);
    setLoading(true);

    try {
      // Upload vers Supabase Storage pour archivage
      const path = `factures/${profile.id}/${nFacture}_${Date.now()}.pdf`;
      await supabase.storage.from("documents").upload(path, file, {
        contentType: "application/pdf",
        upsert: false,
      });

      // Lecture du texte (basique via FileReader)
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(file, "latin1");
      });

      const extraites = extraireLignes(text, nFacture);

      if (extraites.length === 0) {
        setError(
          "Aucune ligne détectée automatiquement. Le PDF est peut-être scanné (image). " +
          "Essayez la saisie manuelle ou contactez l'admin."
        );
      } else {
        setLignes(extraites);
        setStep("review");
      }
    } catch (e) {
      setError("Erreur lors de la lecture du fichier.");
      console.error(e);
    }
    setLoading(false);
  }

  async function handleImport() {
    const selected = lignes.filter(l => l.selected);
    if (selected.length === 0) { setError("Sélectionnez au moins une ligne."); return; }

    setLoading(true);
    const { error: err } = await supabase.from("sales").insert(
      selected.map(l => ({
        profile_id: profile.id,
        date_vente: new Date().toISOString().slice(0, 10),
        agence: agence || "—",
        univers: "AUTRES",
        offre: l.offre,
        client: l.client || null,
        quantite: 1,
        prix_unitaire: l.ca_ttc,
        ca_ttc: l.ca_ttc,
        commission_oci: 0,
        points: 0,
        prime: 0,
        n_facture: l.n_facture || null,
        statut: "saisie",
        est_avoir: false,
        cree_par: profile.id,
      }))
    );

    if (err) {
      setError("Erreur lors de l'import : " + err.message);
    } else {
      setStep("done");
    }
    setLoading(false);
  }

  function toggleLigne(i: number) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, selected: !l.selected } : l));
  }

  function updateLigne(i: number, field: keyof LigneExtraite, value: string | number) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, [field]: value } : l));
  }

  if (step === "done") {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">Import terminé</h1>
        <p className="text-sm text-slate-600 mb-4">
          Les ventes ont été enregistrées avec le statut "saisie" et sont en attente de validation.
        </p>
        <button
          onClick={() => { setStep("upload"); setLignes([]); setNFacture(""); }}
          className="text-sm text-slate-600 underline"
        >
          Importer une autre facture
        </button>
      </div>
    );
  }

  if (step === "review") {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Vérification avant import</h1>
        <p className="text-sm text-slate-500 mb-6">
          {lignes.length} ligne{lignes.length > 1 ? "s" : ""} détectée{lignes.length > 1 ? "s" : ""}.
          Cochez celles à importer et corrigez si nécessaire.
        </p>

        <div className="space-y-3 mb-6">
          {lignes.map((l, i) => (
            <div
              key={i}
              className={`border rounded-lg p-3 ${l.selected ? "border-slate-300" : "border-slate-100 opacity-50"}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={l.selected}
                  onChange={() => toggleLigne(i)}
                  className="mt-1"
                />
                <div className="flex-1 space-y-2">
                  <input
                    type="text"
                    value={l.offre}
                    onChange={e => updateLigne(i, "offre", e.target.value)}
                    className="w-full text-sm border-b border-slate-200 focus:outline-none"
                  />
                  <div className="flex gap-3">
                    <input
                      type="text"
                      placeholder="Client"
                      value={l.client}
                      onChange={e => updateLigne(i, "client", e.target.value)}
                      className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
                    />
                    <input
                      type="number"
                      value={l.ca_ttc}
                      onChange={e => updateLigne(i, "ca_ttc", parseFloat(e.target.value))}
                      className="w-32 text-xs border border-slate-200 rounded px-2 py-1 text-right"
                    />
                    <span className="text-xs text-slate-500 self-center">F TTC</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => setStep("upload")}
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
    <div className="p-8 max-w-lg">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Import PDF</h1>
      <p className="text-sm text-slate-500 mb-6">
        Chargez une facture OCI pour en extraire les lignes automatiquement.
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            N° de facture <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            placeholder="OCI-ANG.009.xxxxx"
            value={nFacture}
            onChange={e => setNFacture(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Agence</label>
          <input
            type="text"
            placeholder="ex : Angré 7ème Tranche"
            value={agence}
            onChange={e => setAgence(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Fichier PDF</label>
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center cursor-pointer hover:border-slate-400 transition-colors"
          >
            <p className="text-sm text-slate-500">
              {loading ? "Lecture en cours..." : "Cliquez pour sélectionner un PDF"}
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
