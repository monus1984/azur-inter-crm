import { useState, useRef } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import { parseTexteFactures, type LigneExtraiteOCI } from "../lib/parseFacturesOCI";
import { usePersistentState } from "../lib/usePersistentState";
import { deviserUnivers } from "../lib/univers";
import type { Profile } from "../types/database";

interface Props { profile: Profile; }

type Onglet = "scan_pdf" | "ventes_excel" | "oci_excel";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LigneExtraite {
  // Champs bruts extraits du reçu
  n_facture: string;
  n_journal: string;
  date_vente: string;        // YYYY-MM-DD
  operateur: string;         // nom tel qu'imprimé sur le reçu
  agence_site: string;       // ex: OCI-SSA → SmartStore
  client: string | null;
  n_client: string | null;
  lignes_articles: LigneArticle[];
  montant_total: number;
  est_avoir: boolean;
  mode_paiement: string | null;
  // Résolution
  profile_id: string | null;
  confiance: "haute" | "moyenne" | "faible";
  erreurs: string[];
}

interface LigneArticle {
  libelle: string;
  quantite: number;
  prix_unitaire: number;
  total: number;
}

interface LigneRevue extends LigneExtraite {
  selected: boolean;
  page_source: number;
}

// ─── Mapping site → agence ────────────────────────────────────────────────────
const SITE_TO_AGENCE: Record<string, string> = {
  "OCI-SSA": "SmartStore",
  "OCI-ANT": "Angré 7ème Tranche",
  "OCI-AND": "Angré Djibi",
  "OCI-PLN": "Plateau Nord / Pyramide",
  "OCI-ADM": "Adjamé Mosquée",
  "OCI-AD2": "Adjamé 220 Logts",
  "OCI-BSM": "Bassam",
};

// ─── Mapping opérateur → profile ─────────────────────────────────────────────
const OPERATEUR_TO_LOGIN: Record<string, string> = {
  "LINDA ANANI":         "c_lamani",
  "ANANI LINDA":         "c_lamani",
  "SYRA AIDARA":         "c_saidara",
  "AIDARA SYRA":         "c_saidara",
  "HABIBATA BANHORO":    "c_hbanhoro",
  "BANHORO HABIBATA":    "c_hbanhoro",
  "BAKAYOKO MAX":        "c_lbakayoko1",
  "NANTENIN BANHORO":    "c_nbanhoroep",
  "BANHORO NANTENIN":    "c_nbanhoroep",
  "CELESTE BONNY":       "c_cbonny",
  "BONNY CELESTE":       "c_cbonny",
  "MABOUTE FATIGA":      "c_afatiga",
  "FATIGA MABOUTE":      "c_afatiga",
  "HADJA SAYON DIAKITE": "c_sdiakite",
  "DIAKITE HADJA SAYON": "c_sdiakite",
  "JEANNETTE N'DRI":     "c_jndri1",
  "N'DRI JEANNETTE":     "c_jndri1",
  "DORCASSE GUIBILIHONON": "c_dguibiliho",
  "GUIBILIHONON DORCASSE": "c_dguibiliho",
  "HERVE AMOA":          "c_hamoa",
  "AMOA HERVE":          "c_hamoa",
  "AMOA HERVÉ":          "c_hamoa",
  "SAUL ATTAYE":         "c_sattaye",
  "ATTAYE SAUL":         "c_sattaye",
  "NADEGE KOUASSI":      "c_fkouassi5",
  "KOUASSI NADEGE":      "c_fkouassi5",
  "KOUASSI NADÈGE-FLORE": "c_fkouassi5",
  "KEVIN ATTO":          "c_ratto",
  "ATTO KEVIN":          "c_ratto",
  "AYEKO AGBARO":        "c_kagbaro",
  "AGBARO AYEKO":        "c_kagbaro",
  "HAMADOU DRAMERA":     "c_hdramera",
  "DRAMERA HAMADOU":     "c_hdramera",
  "JADE SENDZE":         "c_jsendze",
  "SENDZE JADE":         "c_jsendze",
  "ANABELLE KOFFI":      "c_akoffi4",
  "KOFFI ANABELLE":      "c_akoffi4",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDateFr(dateStr: string): string | null {
  // "17 août 2026 14:43" → "2026-08-17"
  const MOIS: Record<string, string> = {
    janvier:"01", février:"02", mars:"03", avril:"04",
    mai:"05", juin:"06", juillet:"07", août:"08",
    septembre:"09", octobre:"10", novembre:"11", décembre:"12"
  };
  const m = dateStr.match(/(\d{1,2})[.\s]+(\w+)\s+(\d{4})/);
  if (!m) return null;
  const moisNum = MOIS[m[2].toLowerCase()];
  if (!moisNum) return null;
  return `${m[3]}-${moisNum}-${m[1].padStart(2, "0")}`;
}

function parseNumber(s: string): number {
  // "93 220,34" ou "93.220,34" ou "93220.34" → 93220.34
  return parseFloat(s.replace(/\s/g, "").replace(/\./g, "").replace(",", ".")) || 0;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Parser Claude Vision ─────────────────────────────────────────────────────

const PROMPT_EXTRACTION = `Tu analyses un reçu-facture Orange CI (Côte d'Ivoire).
Extrais EXACTEMENT les informations suivantes au format JSON strict.
Ne devine pas — si un champ est absent ou illisible, mets null.

{
  "n_facture": "numéro complet ex: OCI-SSA.001.055769",
  "n_journal": "numéro journal ex: 119079",
  "date_vente": "date au format YYYY-MM-DD ex: 2026-08-17",
  "operateur": "nom opérateur EXACTEMENT comme imprimé",
  "site": "code site ex: OCI-SSA",
  "client": "nom du client ou null",
  "n_client": "numéro client ou null",
  "est_avoir": true si libellé contient 'Avoir' sinon false,
  "montant_total": montant total numérique sans symbole,
  "mode_paiement": "Orange Money1 | Espèces | Chèque | null",
  "articles": [
    {
      "libelle": "libellé article complet",
      "quantite": nombre entier,
      "prix_unitaire": prix numérique,
      "total": total numérique
    }
  ]
}

IMPORTANT:
- Retourne UNIQUEMENT le JSON, aucun texte avant ou après
- Les montants sont en XOF, ne pas inclure le symbole
- Si plusieurs articles, liste-les tous
- La date est dans l'en-tête du reçu (champ "Date:")
- L'opérateur est dans le champ "Opérateur:" de l'en-tête`;

async function extraireDepuisImage(imageBase64: string): Promise<LigneExtraite | null> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: imageBase64 }
            },
            { type: "text", text: PROMPT_EXTRACTION }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // Nettoyer et parser le JSON
    const jsonStr = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(jsonStr);

    // Construire la LigneExtraite
    const erreurs: string[] = [];
    if (!parsed.n_facture) erreurs.push("N° facture manquant");
    if (!parsed.date_vente) erreurs.push("Date manquante");
    if (!parsed.operateur) erreurs.push("Opérateur manquant");

    const agence = parsed.site ? (SITE_TO_AGENCE[parsed.site] || parsed.site) : null;
    if (!agence) erreurs.push("Site/agence non reconnu");

    const login = parsed.operateur
      ? OPERATEUR_TO_LOGIN[parsed.operateur.trim().toUpperCase()] ||
        OPERATEUR_TO_LOGIN[parsed.operateur.trim()] ||
        null
      : null;

    const confiance: "haute" | "moyenne" | "faible" =
      erreurs.length === 0 && login ? "haute" :
      erreurs.length <= 1 ? "moyenne" : "faible";

    return {
      n_facture: parsed.n_facture || "",
      n_journal: parsed.n_journal || "",
      date_vente: parsed.date_vente || "",
      operateur: parsed.operateur || "",
      agence_site: agence || "",
      client: parsed.client || null,
      n_client: parsed.n_client || null,
      lignes_articles: (parsed.articles || []).map((a: any) => ({
        libelle: a.libelle || "",
        quantite: Number(a.quantite) || 1,
        prix_unitaire: Number(a.prix_unitaire) || 0,
        total: Number(a.total) || 0,
      })),
      montant_total: Number(parsed.montant_total) || 0,
      est_avoir: Boolean(parsed.est_avoir),
      mode_paiement: parsed.mode_paiement || null,
      profile_id: null, // résolu après via lookup
      confiance,
      erreurs,
    };
  } catch (e) {
    console.error("Erreur extraction Claude:", e);
    return null;
  }
}

// ─── Conversion PDF → images base64 côté client ───────────────────────────────

async function pdfToImages(file: File): Promise<string[]> {
  // Utilise PDF.js via CDN pour rasteriser chaque page
  const pdfjsLib = (window as any).pdfjsLib;
  if (!pdfjsLib) throw new Error("PDF.js non chargé");

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 }); // 150 DPI environ
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    // Convertir en JPEG base64 (sans le préfixe data:image/...)
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    images.push(dataUrl.split(",")[1]);
  }

  return images;
}

// ─── Sous-composant : Import Scan PDF ─────────────────────────────────────────

function ImportScanPDF({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [lignes, setLignes] = useState<LigneRevue[]>([]);
  const [step, setStep] = useState<"idle" | "processing" | "review" | "done">("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0, page: "" });
  const [loginToId, setLoginToId] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [resultats, setResultats] = useState({ inseres: 0, erreurs: 0 });
  const [pdfJsLoaded, setPdfJsLoaded] = useState(false);

  // Charger PDF.js depuis CDN au montage
  if (typeof window !== "undefined" && !(window as any).pdfjsLib && !pdfJsLoaded) {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      setPdfJsLoaded(true);
    };
    document.head.appendChild(script);
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    setStep("processing");
    setLignes([]);

    // Charger les logins depuis Supabase
    const { data: profils } = await supabase
      .from("profiles")
      .select("id, login_oci, nom")
      .eq("actif", true)
      .eq("role", "commercial");

    const ltoi: Record<string, string> = {};
    (profils ?? []).forEach((p: any) => { if (p.login_oci) ltoi[p.login_oci] = p.id; });
    setLoginToId(ltoi);

    const toutesLignes: LigneRevue[] = [];
    let pageGlobale = 0;

    for (const file of files) {
      let images: string[];
      try {
        images = await pdfToImages(file);
      } catch (err) {
        console.error("Erreur rasterisation:", err);
        continue;
      }

      const totalPages = images.length;

      for (let i = 0; i < images.length; i++) {
        pageGlobale++;
        setProgress({
          current: pageGlobale,
          total: 0, // calculé après
          page: `${file.name} — page ${i + 1}/${totalPages}`
        });

        const extraite = await extraireDepuisImage(images[i]);
        if (!extraite) continue;

        // Résoudre le profile_id via le login
        const login = OPERATEUR_TO_LOGIN[extraite.operateur?.trim().toUpperCase()] ||
                      OPERATEUR_TO_LOGIN[extraite.operateur?.trim()] || null;
        const profile_id = login ? ltoi[login] || null : null;

        toutesLignes.push({
          ...extraite,
          profile_id,
          selected: extraite.confiance !== "faible",
          page_source: pageGlobale,
        });
      }
    }

    setLignes(toutesLignes);
    setStep("review");
    if (fileRef.current) fileRef.current.value = "";
  }

  function toggleLigne(i: number) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, selected: !l.selected } : l));
  }

  function updateLigne(i: number, field: string, value: any) {
    setLignes(prev => prev.map((l, j) => j === i ? { ...l, [field]: value } : l));
  }

  async function inserer() {
    const selection = lignes.filter(l => l.selected);
    if (!selection.length) return;
    setSaving(true);

    let inseres = 0;
    let erreurs = 0;

    for (const l of selection) {
      // Une ligne par article dans sales
      const rows = l.lignes_articles.length > 0
        ? l.lignes_articles.map(a => ({
            profile_id: l.profile_id,
            date_vente: l.date_vente || null,
            agence: l.agence_site || "—",
            univers: deviserUnivers(a.libelle),
            offre: a.libelle,
            client: l.client,
            quantite: a.quantite,
            prix_unitaire: a.prix_unitaire,
            ca_ttc: a.total,
            commission_oci: 0,
            points: 0,
            prime: 0,
            n_facture: l.n_facture || null,
            n_journal: l.n_journal || null,
            n_client: l.n_client || null,
            mode_paiement: l.mode_paiement,
            statut: l.profile_id && l.n_facture && l.n_journal ? "validee" : "en_attente_oci",
            est_avoir: l.est_avoir,
            libelle_source: "pdf_scan",
            cree_par: profile.id,
          }))
        : [{
            profile_id: l.profile_id,
            date_vente: l.date_vente || null,
            agence: l.agence_site || "—",
            univers: "AUTRES",
            offre: "Voir reçu",
            client: l.client,
            quantite: 1,
            prix_unitaire: l.montant_total,
            ca_ttc: l.montant_total,
            commission_oci: 0,
            points: 0,
            prime: 0,
            n_facture: l.n_facture || null,
            n_journal: l.n_journal || null,
            n_client: l.n_client || null,
            mode_paiement: l.mode_paiement,
            statut: "en_attente_oci" as const,
            est_avoir: l.est_avoir,
            libelle_source: "pdf_scan",
            cree_par: profile.id,
          }];

      const { error } = await supabase.from("sales").insert(rows);
      if (error) { erreurs++; console.error(error.message); }
      else inseres++;
    }

    setResultats({ inseres, erreurs });
    setStep("done");
    setSaving(false);
  }

  const confianceBadge = (c: "haute" | "moyenne" | "faible") => {
    const s = { haute: "bg-green-100 text-green-700", moyenne: "bg-amber-100 text-amber-700", faible: "bg-red-100 text-red-700" };
    return <span className={`text-xs px-2 py-0.5 rounded-full ${s[c]}`}>{c}</span>;
  };

  // ── Step : idle ──────────────────────────────────────────────────────────────
  if (step === "idle") return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Importez des PDF de reçus OCI scannés. Chaque page est analysée par IA pour en extraire
        automatiquement les données. Vérifiez les lignes avant insertion.
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 transition-colors">
        <span className="text-3xl mb-2">🔍</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Cliquer pour choisir les PDF scannés</span>
        <span className="text-xs text-slate-400">.pdf — plusieurs fichiers autorisés</span>
        <input ref={fileRef} type="file" accept=".pdf" multiple onChange={handleFiles} className="hidden" />
      </label>
      <div className="mt-4 bg-slate-50 rounded-lg p-3 text-xs text-slate-500 space-y-1">
        <p>• Chaque page du PDF = un reçu Orange CI</p>
        <p>• L'IA extrait : N° facture, N° journal, date, opérateur, articles, montant</p>
        <p>• Vous validez les données avant insertion en base</p>
        <p>• Un PDF de 10 pages prend environ 30 secondes</p>
      </div>
    </div>
  );

  // ── Step : processing ────────────────────────────────────────────────────────
  if (step === "processing") return (
    <div className="text-center py-8">
      <div className="text-3xl mb-4">🔍</div>
      <p className="text-sm font-medium text-slate-800 mb-1">Analyse en cours...</p>
      <p className="text-xs text-slate-400 mb-4">{progress.page}</p>
      <div className="bg-slate-100 rounded-full h-2 max-w-xs mx-auto overflow-hidden">
        <div className="bg-slate-800 h-full rounded-full animate-pulse" style={{ width: "60%" }} />
      </div>
      <p className="text-xs text-slate-400 mt-3">L'IA lit chaque reçu — ne fermez pas cette page</p>
    </div>
  );

  // ── Step : done ──────────────────────────────────────────────────────────────
  if (step === "done") return (
    <div className="text-center py-8">
      <div className="text-3xl mb-3">✅</div>
      <p className="text-base font-medium text-slate-900 mb-1">Import terminé</p>
      <p className="text-sm text-slate-500 mb-4">
        {resultats.inseres} reçu(s) inséré(s){resultats.erreurs > 0 ? `, ${resultats.erreurs} erreur(s)` : ""}
      </p>
      <button onClick={() => { setStep("idle"); setLignes([]); }}
        className="text-sm text-slate-600 underline">
        Importer d'autres PDF
      </button>
    </div>
  );

  // ── Step : review ────────────────────────────────────────────────────────────
  const nbSelectionnees = lignes.filter(l => l.selected).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-medium text-slate-900">{lignes.length} reçu(s) détecté(s)</p>
          <p className="text-xs text-slate-400">{nbSelectionnees} sélectionné(s) pour insertion</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setLignes(prev => prev.map(l => ({ ...l, selected: true })))}
            className="text-xs text-slate-500 underline">Tout cocher</button>
          <button onClick={() => setLignes(prev => prev.map(l => ({ ...l, selected: false })))}
            className="text-xs text-slate-500 underline">Tout décocher</button>
        </div>
      </div>

      <div className="space-y-3 max-h-[60vh] overflow-y-auto mb-4">
        {lignes.map((l, i) => (
          <div key={i} className={`border rounded-lg p-4 ${l.selected ? "border-slate-300" : "border-slate-100 opacity-60"}`}>
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={l.selected} onChange={() => toggleLigne(i)} className="mt-1 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                {/* En-tête */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="text-sm font-mono font-medium text-slate-800">{l.n_facture || "—"}</span>
                  <span className="text-xs text-slate-400">J.{l.n_journal || "—"}</span>
                  {confianceBadge(l.confiance)}
                  {l.est_avoir && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">AVOIR</span>}
                  <span className="text-xs text-slate-400 ml-auto">page {l.page_source}</span>
                </div>

                {/* Champs éditables */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Date</label>
                    <input type="date" value={l.date_vente}
                      onChange={e => updateLigne(i, "date_vente", e.target.value)}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Opérateur</label>
                    <input type="text" value={l.operateur}
                      onChange={e => updateLigne(i, "operateur", e.target.value)}
                      className={`w-full border rounded px-2 py-1 text-xs ${!l.profile_id ? "border-amber-300 bg-amber-50" : "border-slate-200"}`} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Agence</label>
                    <input type="text" value={l.agence_site}
                      onChange={e => updateLigne(i, "agence_site", e.target.value)}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-0.5">Montant total</label>
                    <div className="text-xs font-semibold text-slate-800 px-2 py-1">
                      {l.montant_total.toLocaleString("fr-FR")} F
                    </div>
                  </div>
                </div>

                {/* Articles */}
                {l.lignes_articles.length > 0 && (
                  <div className="border-t border-slate-100 pt-2 mt-1">
                    <p className="text-xs text-slate-400 mb-1">Articles</p>
                    {l.lignes_articles.map((a, j) => (
                      <div key={j} className="flex gap-2 text-xs text-slate-600 items-center mb-0.5">
                        <span className="flex-1 truncate" title={a.libelle}>{a.libelle}</span>
                        <span className="text-slate-400">{a.quantite} × {a.prix_unitaire.toLocaleString("fr-FR")} F</span>
                        <span className="font-medium w-24 text-right">{a.total.toLocaleString("fr-FR")} F</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Erreurs */}
                {l.erreurs.length > 0 && (
                  <div className="mt-1 text-xs text-amber-600">
                    ⚠ {l.erreurs.join(" · ")}
                  </div>
                )}

                {/* Client */}
                {l.client && (
                  <div className="mt-1 text-xs text-slate-400">Client : {l.client}{l.n_client ? ` (N° ${l.n_client})` : ""}</div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button onClick={() => { setStep("idle"); setLignes([]); }}
          className="px-4 py-2 text-sm border border-slate-300 rounded-md text-slate-600 hover:bg-slate-50">
          Annuler
        </button>
        <button onClick={inserer} disabled={saving || nbSelectionnees === 0}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50">
          {saving ? "Insertion..." : `Insérer ${nbSelectionnees} reçu(s)`}
        </button>
      </div>
    </div>
  );
}

// ─── Sous-composant : Import Ventes Excel ────────────────────────────────────

function ImportVentesExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle"|"loading"|"done"|"error">("idle");
  const [stats, setStats] = useState<{inseres:number;doublons:number;incomplets:number}|null>(null);

  function addLog(msg: string) { setLog(prev => [...prev, msg]); }

  const NOM_TO_LOGIN: Record<string, string> = {
    "AIDARA SYRA":"c_saidara","BANHORO HABIBATA":"c_hbanhoro","BAKAYOKO MAX":"c_lbakayoko1",
    "BANHORO NANTENIN":"c_nbanhoroep","ANANI LINDA":"c_lamani","BONNY CELESTE":"c_cbonny",
    "FATIGA MABOUTE":"c_afatiga","DIAKITE HADJA SAYON":"c_sdiakite","N'DRI JEANNETTE":"c_jndri1",
    "GUIBILIHONON DORCASSE":"c_dguibiliho","AMOA HERVÉ":"c_hamoa","ATTAYE SAUL":"c_sattaye",
    "KOUASSI NADÈGE-FLORE":"c_fkouassi5","ATTO KEVIN":"c_ratto","AGBARO AYEKO":"c_kagbaro",
    "DRAMERA HAMADOU":"c_hdramera","SENDZE JADE":"c_jsendze","KOFFI ANABELLE":"c_akoffi4",
  };

  function normalizeUnivers(raw: string): string {
    const u = (raw||"").toUpperCase().trim();
    if (u.includes("INTERNET")||u.includes("FIBRE")||u.includes("4G")||u.includes("FTTH")||u.includes("FLYBOX")||u.includes("EASYBOX")) return "INTERNET";
    if (u.includes("MOBILE")||u.includes("MIX")||u.includes("SMS")||u.includes("COMMUNITY")||u.includes("START LITE")) return "MOBILE";
    if (u.includes("ICT")||u.includes("EASY OFFICE")||u.includes("MSSP")||u.includes("BAAS")) return "ICT";
    if (u.includes("FIXE")||u.includes("VOIX")) return "FIXE";
    return "AUTRES";
  }

  function parseExcelDate(val: unknown): string | null {
    if (!val) return null;
    if (typeof val === "number") {
      const d = new Date(Math.round((val - 25569) * 86400 * 1000));
      return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
    }
    const m = String(val).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setStatus("loading"); setLog([]); setStats(null);

    try {
      const { data: profils } = await supabase.from("profiles").select("id, login_oci").not("login_oci","is",null);
      const loginToId: Record<string,string> = {};
      (profils??[]).forEach((p:any) => { if (p.login_oci) loginToId[p.login_oci] = p.id; });
      addLog(`${Object.keys(loginToId).length} commerciaux en base.`);

      let toutesLignes: any[] = [];
      for (const file of files) {
        addLog(`📄 ${file.name}`);
        const wb = XLSX.read(await file.arrayBuffer(), { type:"array" });
        const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes("ventes")||n.toLowerCase().includes("données"));
        if (!sheetName) { addLog(`   ⚠ Feuille 'Données ventes' introuvable`); continue; }
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval:null }) as any[];
        let skip = 0;
        for (const row of rows) {
          const dateVente = parseExcelDate(row["Date"]);
          if (!dateVente) { skip++; continue; }
          const nomRaw = String(row["Commercial"]??"").trim().toUpperCase();
          const login = NOM_TO_LOGIN[nomRaw];
          const pid = login ? loginToId[login] : null;
          const nFacture = String(row["N° Reçu-Facture"]??"").trim()||null;
          const nJournal = String(row["N° Journal"]??"").trim();
          const caTtc = parseFloat(String(row["CA TTC (XOF)"]??row["Prix TTC (XOF)"]??0));
          const journalValide = /^\d+$/.test(nJournal.trim());
          toutesLignes.push({
            profile_id: pid ?? "00000000-0000-0000-0000-000000000020",
            date_vente: dateVente,
            agence: String(row["Agence"]??"").trim()||null,
            univers: normalizeUnivers(String(row["Univers"]??row["Offre / Libellé"]??"")),
            offre: String(row["Offre / Libellé"]??"").trim()||"Inconnu",
            client: String(row["Client"]??"").trim()||null,
            quantite: parseInt(String(row["Qté"]??1),10),
            prix_unitaire: parseFloat(String(row["Prix TTC (XOF)"]??0)),
            ca_ttc: caTtc,
            commission_oci: parseFloat(String(row["Comm. OCI HT (XOF)"]??0)),
            points:0, prime:0,
            n_facture: nFacture,
            n_journal: journalValide ? nJournal : null,
            n_client: String(row["N° Client"]??"").trim()||null,
            ref_oci: String(row["Réf. OCI/B"]??"").trim()||null,
            mode_paiement: String(row["Mode Paiement"]??"").trim()||null,
            statut: pid && nFacture && journalValide ? "validee" : "en_attente_oci",
            est_avoir: caTtc < 0,
            libelle_source: "excel_ventes",
            cree_par: profile.id,
            _key: `${nFacture}|${String(row["Offre / Libellé"]??"").trim()}|${caTtc}`,
          });
        }
        addLog(`   → ${rows.length - skip} lignes (${skip} sans date ignorées)`);
      }

      addLog(`Total brut : ${toutesLignes.length} lignes.`);

      // Déduplication interne
      const vus = new Set<string>();
      toutesLignes = toutesLignes.filter(l => { if(vus.has(l._key)) return false; vus.add(l._key); return true; });
      addLog(`Après déduplication : ${toutesLignes.length} lignes.`);

      // Déduplication base
      const nFactures = [...new Set(toutesLignes.map(l=>l.n_facture).filter(Boolean))];
      let doublonsBase = 0;
      if (nFactures.length) {
        const { data: existantes } = await supabase.from("sales").select("n_facture,offre,ca_ttc").in("n_facture",nFactures as string[]);
        const clesBase = new Set((existantes??[]).map((e:any)=>`${e.n_facture}|${e.offre}|${e.ca_ttc}`));
        const avant = toutesLignes.length;
        toutesLignes = toutesLignes.filter(l => !clesBase.has(l._key));
        doublonsBase = avant - toutesLignes.length;
        if (doublonsBase) addLog(`⚠ ${doublonsBase} doublons base exclus.`);
      }

      if (!toutesLignes.length) { addLog("⚠ Aucune nouvelle ligne."); setStatus("done"); setStats({inseres:0,doublons:doublonsBase,incomplets:0}); return; }

      const aInserer = toutesLignes.map(({_key,...rest}) => rest);
      const nbIncomplets = aInserer.filter(l=>l.statut==="en_attente_oci").length;
      addLog(`À insérer : ${aInserer.length} lignes (dont ${nbIncomplets} en attente OCI).`);

      for (let i=0; i<Math.ceil(aInserer.length/200); i++) {
        const lot = aInserer.slice(i*200,(i+1)*200);
        const {error} = await supabase.from("sales").insert(lot);
        if (error) throw new Error(error.message);
        addLog(`  Lot ${i+1} — ${lot.length} lignes.`);
      }

      setStats({inseres:aInserer.length,doublons:doublonsBase,incomplets:nbIncomplets});
      addLog(`✅ ${aInserer.length} ventes insérées.`);
      setStatus("done");
    } catch(err:any) {
      addLog(`❌ ${err.message||String(err)}`);
      setStatus("error");
    } finally { if(fileRef.current) fileRef.current.value=""; }
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Fichier : <code className="bg-slate-100 px-1 rounded">AZUR_INTER_Ventes_Justificatif_OCI_*.xlsx</code>
        <br/>Feuille : <strong>Données ventes AZUR</strong>
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 transition-colors mb-4">
        <span className="text-2xl mb-2">📂</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Cliquer pour choisir un ou plusieurs fichiers Excel</span>
        <span className="text-xs text-slate-400">.xlsx — sélection multiple autorisée</span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={handleFiles} className="hidden" disabled={status==="loading"} />
      </label>
      {status !== "idle" && (
        <div className={`text-xs font-medium px-3 py-2 rounded-md mb-3 ${status==="loading"?"bg-blue-50 text-blue-700":status==="done"?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>
          {status==="loading"&&"⏳ Import en cours…"}{status==="done"&&"✅ Import réussi"}{status==="error"&&"❌ Erreur"}
        </div>
      )}
      {stats && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-green-700">{stats.inseres}</div><div className="text-xs text-green-600">insérées</div></div>
          <div className="bg-amber-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-amber-700">{stats.incomplets}</div><div className="text-xs text-amber-600">en attente OCI</div></div>
          <div className="bg-slate-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-slate-500">{stats.doublons}</div><div className="text-xs text-slate-400">doublons exclus</div></div>
        </div>
      )}
      {log.length > 0 && (
        <div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto">
          {log.map((l,i) => <div key={i} style={{color:l.startsWith("✅")?"#4ade80":l.startsWith("❌")?"#f87171":l.startsWith("⚠")?"#fbbf24":undefined}}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

// ─── Sous-composant : Import Rapport OCI Excel ───────────────────────────────

function ImportOCIExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle"|"loading"|"done"|"error">("idle");

  function addLog(msg: string) { setLog(prev => [...prev, msg]); }

  function parseExcelDate(val: unknown): string | null {
    if (!val) return null;
    if (typeof val === "number") {
      const d = new Date(Math.round((val - 25569) * 86400 * 1000));
      return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
    }
    const m = String(val).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  function parseOCIWorkbook(wb: XLSX.WorkBook) {
    const transactions: any[] = [];
    for (const shName of ["Base FTTH","Base Backlog"]) {
      const sh = wb.Sheets[shName]; if (!sh) continue;
      const rows = XLSX.utils.sheet_to_json(sh,{defval:null}) as any[];
      addLog(`  ${shName} : ${rows.length} lignes`);
      for (const row of rows) {
        const dateStr = parseExcelDate(row["date_creation_dossier"]);
        transactions.push({
          ref_externe: String(row["contratclient"]??row["id_dossier"]??"").trim()||null,
          source: shName==="Base Backlog"?"FTTH_BACKLOG":"FTTH",
          date_transaction: dateStr, mois: dateStr?.substring(0,7)||null,
          offre: String(row["offer"]??row["produit"]??"").trim()||null,
          agence: String(row["pointvente"]??"").trim()||null,
          login_oci: String(row["Login"]??row["login"]??row["usercrea"]??"").trim()||null,
          client: String(row["nomclient"]??"").trim()||null, univers:"INTERNET", quantite:1,
          prix_ttc: parseFloat(String(row["Récurrent"]??0))||null, commission_oci:null,
          statut_oci: String(row["statut"]??"").trim()||null,
          n_facture: String(row["rscoptiquepb"]??"").trim()||null, n_journal:null,
          remarque: String(row["motif"]??row["etape"]??"").trim()||null,
          fichier_source: shName, importe_par: profile.id,
        });
      }
    }
    const sh4G = wb.Sheets["Base 4G"];
    if (sh4G) {
      const rows = XLSX.utils.sheet_to_json(sh4G,{defval:null}) as any[];
      addLog(`  Base 4G : ${rows.length} lignes`);
      for (const row of rows) {
        const dateStr = parseExcelDate(row["date_facture"]??row["date_jour"]);
        transactions.push({
          ref_externe: String(row["numero_facture"]??"").trim()||null, source:"4G",
          date_transaction: dateStr, mois: dateStr?.substring(0,7)||null,
          offre: String(row["offre"]??"").trim()||null, agence: String(row["code_agence"]??"").trim()||null,
          login_oci: String(row["Login"]??row["user_name"]??"").trim()||null,
          client: String(row["customer_name"]??"").trim()||null, univers:"INTERNET", quantite:1,
          prix_ttc: parseFloat(String(row["montant_facture"]??0))||null, commission_oci:null,
          statut_oci:"installe", n_facture: String(row["numero_facture"]??"").trim()||null,
          n_journal: String(row["numero_recu"]??"").trim()||null, remarque:null,
          fichier_source:"Base 4G", importe_par: profile.id,
        });
      }
    }
    const shMobile = wb.Sheets["Mobile NTS"];
    if (shMobile) {
      const rows = XLSX.utils.sheet_to_json(shMobile,{defval:null}) as any[];
      addLog(`  Mobile NTS : ${rows.length} lignes`);
      for (const row of rows) {
        const dateStr = parseExcelDate(row["Date de transaction"]??row["Date comptable"]);
        transactions.push({
          ref_externe: String(row["N< Facture mensuelle/Initiale"]??row["Numéro du journal"]??"").trim()||null,
          source:"MOBILE", date_transaction:dateStr, mois:dateStr?.substring(0,7)||null,
          offre: String(row["Offres"]??row["Nom article"]??"").trim()||null,
          agence: String(row["Nom Agence"]??"").trim()||null,
          login_oci: String(row["Login utilisateur"]??"").trim()||null,
          client: String(row["Nom Client"]??"").trim()||null, univers:"MOBILE",
          quantite: parseInt(String(row["Quantité "]??row["Quantite"]??1),10),
          prix_ttc: parseFloat(String(row["Prix unitaire"]??0))||null,
          commission_oci: parseFloat(String(row["Commissions"]??0))||null,
          statut_oci:"installe",
          n_facture: String(row["N< Facture mensuelle/Initiale"]??"").trim()||null,
          n_journal: String(row["Numéro du journal"]??"").trim()||null, remarque:null,
          fichier_source:"Mobile NTS", importe_par: profile.id,
        });
      }
    }
    return transactions;
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files??[]);
    if (!files.length) return;
    setStatus("loading"); setLog([]);
    try {
      let toutes: any[] = [];
      for (const file of files) {
        addLog(`📄 ${file.name}`);
        const wb = XLSX.read(await file.arrayBuffer(),{type:"array"});
        addLog(`  Feuilles : ${wb.SheetNames.join(", ")}`);
        const tx = parseOCIWorkbook(wb);
        addLog(`  → ${tx.length} transactions`);
        toutes = [...toutes, ...tx];
      }
      addLog(`Total : ${toutes.length} transactions.`);
      if (!toutes.length) throw new Error("Aucune donnée trouvée.");
      for (let i=0; i<Math.ceil(toutes.length/200); i++) {
        const {error} = await supabase.from("oci_transactions").insert(toutes.slice(i*200,(i+1)*200));
        if (error) throw new Error(error.message);
        addLog(`  Lot ${i+1} envoyé.`);
      }
      addLog(`✅ ${toutes.length} transactions OCI insérées.`);
      setStatus("done");
    } catch(err:any) { addLog(`❌ ${err.message||String(err)}`); setStatus("error"); }
    finally { if(fileRef.current) fileRef.current.value=""; }
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Fichier : <code className="bg-slate-100 px-1 rounded">OCI_DISTRI_OSS_AZUR_INTER_*.xlsx</code>
        <br/>Feuilles : <strong>Base FTTH, Base Backlog, Base 4G, Mobile NTS</strong>
      </p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 transition-colors mb-4">
        <span className="text-2xl mb-2">📡</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Cliquer pour choisir les rapports OCI</span>
        <span className="text-xs text-slate-400">.xlsx — sélection multiple autorisée</span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={handleFiles} className="hidden" disabled={status==="loading"} />
      </label>
      {status !== "idle" && (
        <div className={`text-xs font-medium px-3 py-2 rounded-md mb-3 ${status==="loading"?"bg-blue-50 text-blue-700":status==="done"?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>
          {status==="loading"&&"⏳ Import en cours…"}{status==="done"&&"✅ Import réussi"}{status==="error"&&"❌ Erreur"}
        </div>
      )}
      {log.length > 0 && (
        <div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto">
          {log.map((l,i) => <div key={i} style={{color:l.startsWith("✅")?"#4ade80":l.startsWith("❌")?"#f87171":undefined}}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

// ─── Composant principal ──────────────────────────────────────────────────────

export default function ImportPDF({ profile }: Props) {
  const [onglet, setOnglet] = useState<Onglet>("scan_pdf");

  const tabs: { key: Onglet; label: string; desc: string }[] = [
    { key: "scan_pdf",      label: "🔍 Scan PDF",      desc: "Reçus scannés → IA" },
    { key: "ventes_excel",  label: "📋 Ventes Excel",   desc: "Justificatif OCI" },
    { key: "oci_excel",     label: "📡 Rapport OCI",    desc: "OCI Distri Excel" },
  ];

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Import de données</h1>
      <p className="text-sm text-slate-500 mb-5">
        Trois sources : reçus PDF scannés (source primaire), justificatif Excel AZUR, rapport OCI Distri.
      </p>

      {/* Onglets */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setOnglet(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              onglet === t.key
                ? "bg-white border border-b-white border-slate-200 text-slate-900 -mb-px"
                : "text-slate-500 hover:text-slate-700"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {onglet === "scan_pdf"     && <ImportScanPDF profile={profile} />}
      {onglet === "ventes_excel" && <ImportVentesExcel profile={profile} />}
      {onglet === "oci_excel"    && <ImportOCIExcel profile={profile} />}
    </div>
  );
}
