import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { parseTexteFactures, type LigneExtraiteOCI } from "../lib/parseFacturesOCI";
import { usePersistentState } from "../lib/usePersistentState";
import type { Profile, UniversOffre } from "../types/database";

interface Props {
  profile: Profile;
}

interface LigneRevue extends LigneExtraiteOCI {
  selected: boolean;
  profileId: string | null;
  dejaEnBase: boolean; // facture+offre+montant déjà présents dans "sales"
}

type FiltreAffichage = "toutes" | "a_verifier";

function deviserUnivers(offre: string): UniversOffre {
  const l = offre.toLowerCase();
  if (l.includes("mix") || l.includes("community") || l.includes("sms")) return "MOBILE";
  if (l.includes("topup") || l.includes("flybox") || l.includes("easybox") || l.includes("fibre")) return "INTERNET";
  if (l.includes("office") || l.includes("ict")) return "ICT";
  return "AUTRES";
}

function estAVerifier(l: LigneRevue): boolean {
  return l.confiance === "faible" || !l.profileId || l.dejaEnBase;
}

export default function ImportPDF({ profile }: Props) {
  // Persisté : le texte collé ne doit pas disparaître si l'utilisateur
  // change d'onglet pendant la relecture.
  const [texteCollee, setTexteCollee] = usePersistentState("import_texte", "");
  const [lignes, setLignes] = usePersistentState<LigneRevue[]>("import_lignes", []);
  const [step, setStep] = usePersistentState<"saisie" | "review" | "done">("import_step", "saisie");

  const [profilesByNom, setProfilesByNom] = useState<Map<string, string>>(new Map());
  const [filtre, setFiltre] = useState<FiltreAffichage>("a_verifier");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importCount, setImportCount] = useState(0);

  useEffect(() => {
    supabase.from("profiles").select("id, nom").then(({ data }) => {
      if (data) {
        const map = new Map<string, string>();
        data.forEach((p: { id: string; nom: string }) => map.set(p.nom, p.id));
        setProfilesByNom(map);
      }
    });
  }, []);

  async function handleExtraire() {
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

    setChecking(true);

    // Contrôle de doublon contre la base : une ligne (facture + offre +
    // montant) déjà présente dans "sales" est signalée, décochée par défaut.
    const facturesUniques = [...new Set(extraites.map(l => l.nFacture))];
    const { data: existantes } = await supabase
      .from("sales")
      .select("n_facture, offre, ca_ttc")
      .in("n_facture", facturesUniques);

    const clesExistantes = new Set(
      (existantes ?? []).map(e => `${e.n_facture}|${e.offre}|${e.ca_ttc}`)
    );

    const revues: LigneRevue[] = extraites.map(l => {
      const dejaEnBase = clesExistantes.has(`${l.nFacture}|${l.offre}|${l.montant}`);
      return {
        ...l,
        profileId: l.agentNom ? profilesByNom.get(l.agentNom) ?? null : null,
        dejaEnBase,
        selected: l.confiance !== "faible" && !!l.agentNom && !dejaEnBase,
      };
    });

    setChecking(false);
    setLignes(revues);
    setStep("review");
  }

  function toggleLigne(i: number) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, selected: !l.selected } : l));
  }

  function updateLigne(i: number, field: keyof LigneRevue, value: string | number | boolean) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, [field]: value } : l));
  }

  function toutCocher(valeur: boolean) {
    setLignes(prev => prev.map(l =>
      filtre === "toutes" || estAVerifier(l) ? { ...l, selected: valeur } : l
    ));
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
      setTexteCollee("");
      setLignes([]);
    }
    setLoading(false);
  }

  function nouvelImport() {
    setStep("saisie");
    setTexteCollee("");
    setLignes([]);
  }

  const confianceBadge = (c: LigneExtraiteOCI["confiance"]) => {
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
        <button onClick={nouvelImport} className="text-sm text-slate-600 underline">
          Importer un autre lot
        </button>
      </div>
    );
  }

  if (step === "review") {
    const nbAVerifier = lignes.filter(estAVerifier).length;
    const lignesAffichees = filtre === "toutes" ? lignes : lignes.filter(estAVerifier);
    // Les lignes à vérifier remontent en tête même en vue "toutes".
    const lignesTriees = filtre === "toutes"
      ? [...lignesAffichees].sort((a, b) => Number(estAVerifier(b)) - Number(estAVerifier(a)))
      : lignesAffichees;

    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Vérification avant import</h1>
        <p className="text-sm text-slate-500 mb-4">
          {lignes.length} ligne{lignes.length > 1 ? "s" : ""} détectée{lignes.length > 1 ? "s" : ""},
          {" "}dont {nbAVerifier} à vérifier (agent manquant, confiance faible, ou déjà en base).
        </p>

        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            <button
              onClick={() => setFiltre("a_verifier")}
              className={`px-3 py-1.5 text-xs rounded-md font-medium ${
                filtre === "a_verifier" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              À vérifier ({nbAVerifier})
            </button>
            <button
              onClick={() => setFiltre("toutes")}
              className={`px-3 py-1.5 text-xs rounded-md font-medium ${
                filtre === "toutes" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              Toutes ({lignes.length})
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => toutCocher(true)} className="text-xs text-slate-500 underline">
              Tout cocher
            </button>
            <button onClick={() => toutCocher(false)} className="text-xs text-slate-500 underline">
              Tout décocher
            </button>
          </div>
        </div>

        {lignesTriees.length === 0 && (
          <p className="text-sm text-slate-500 mb-4">Aucune ligne à vérifier — tout est fiable.</p>
        )}

        <div className="space-y-2 mb-6 max-h-[55vh] overflow-y-auto">
          {lignesTriees.map((l) => {
            const i = lignes.indexOf(l);
            return (
              <div
                key={`${l.nFacture}-${l.offre}-${i}`}
                className={`border rounded-lg p-3 text-sm ${l.selected ? "border-slate-300" : "border-slate-100 opacity-60"}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={l.selected}
                    onChange={() => toggleLigne(i)}
                    className="mt-1"
                  />
                  <div className="flex-1 grid grid-cols-7 gap-2 items-center">
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
                    <div className="col-span-1">
                      {l.dejaEnBase && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                          déjà en base
                        </span>
                      )}
                    </div>
                    <div className="col-span-1 flex justify-end">
                      {confianceBadge(l.confiance)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        <div className="flex gap-3">
          <button onClick={() => setStep("saisie")} className="px-4 py-2 text-sm border border-slate-300 rounded-md">
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
        Copiez le texte des reçus depuis Word et collez-le ci-dessous. Chaque
        reçu doit contenir une ligne "N°recu-facture:OCI-...". Une facture
        avec plusieurs articles donnera plusieurs lignes de vente.
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
        disabled={checking}
        className="mt-4 px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
      >
        {checking ? "Vérification des doublons..." : "Extraire les factures"}
      </button>
    </div>
  );
}
