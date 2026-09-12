import { useState, useRef } from "react";
import * as XLSX from "xlsx";
import { createWorker } from "tesseract.js";
import { supabase } from "../lib/supabase";
import { deviserUnivers } from "../lib/univers";
import type { Profile } from "../types/database";

interface Props { profile: Profile; }

type Onglet = "scan_pdf" | "ventes_excel" | "oci_excel";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface LigneArticle {
  libelle: string;
  quantite: number;
  prix_unitaire: number;
  total: number;
}

interface LigneExtraite {
  n_facture: string;
  n_journal: string;
  date_vente: string;
  operateur: string;
  agence_site: string;
  client: string | null;
  n_client: string | null;
  lignes_articles: LigneArticle[];
  montant_total: number;
  est_avoir: boolean;
  mode_paiement: string | null;
  profile_id: string | null;
  confiance: "haute" | "moyenne" | "faible";
  erreurs: string[];
  texte_brut: string;
}

interface LigneRevue extends LigneExtraite {
  selected: boolean;
  page_source: number;
}

// ─── Mappings ──────────────────────────────────────────────────────────────────

const SITE_TO_AGENCE: Record<string, string> = {
  "OCI-SSA": "SmartStore",
  "OCI-ANT": "Angré 7ème Tranche",
  "OCI-AND": "Angré Djibi",
  "OCI-PLN": "Plateau Nord / Pyramide",
  "OCI-ADM": "Adjamé Mosquée",
  "OCI-AD2": "Adjamé 220 Logts",
  "OCI-BSM": "Bassam",
};

const OPERATEUR_TO_LOGIN: Record<string, string> = {
  "LINDA ANANI": "c_lamani", "ANANI LINDA": "c_lamani",
  "SYRA AIDARA": "c_saidara", "AIDARA SYRA": "c_saidara",
  "HABIBATA BANHORO": "c_hbanhoro", "BANHORO HABIBATA": "c_hbanhoro",
  "BAKAYOKO MAX": "c_lbakayoko1",
  "NANTENIN BANHORO": "c_nbanhoroep", "BANHORO NANTENIN": "c_nbanhoroep",
  "CELESTE BONNY": "c_cbonny", "BONNY CELESTE": "c_cbonny",
  "MABOUTE FATIGA": "c_afatiga", "FATIGA MABOUTE": "c_afatiga",
  "HADJA SAYON DIAKITE": "c_sdiakite", "DIAKITE HADJA SAYON": "c_sdiakite",
  "JEANNETTE N'DRI": "c_jndri1", "N'DRI JEANNETTE": "c_jndri1",
  "DORCASSE GUIBILIHONON": "c_dguibiliho", "GUIBILIHONON DORCASSE": "c_dguibiliho",
  "HERVE AMOA": "c_hamoa", "AMOA HERVE": "c_hamoa", "AMOA HERVÉ": "c_hamoa",
  "SAUL ATTAYE": "c_sattaye", "ATTAYE SAUL": "c_sattaye",
  "NADEGE KOUASSI": "c_fkouassi5", "KOUASSI NADEGE": "c_fkouassi5",
  "KOUASSI NADÈGE-FLORE": "c_fkouassi5",
  "KEVIN ATTO": "c_ratto", "ATTO KEVIN": "c_ratto",
  "AYEKO AGBARO": "c_kagbaro", "AGBARO AYEKO": "c_kagbaro",
  "HAMADOU DRAMERA": "c_hdramera", "DRAMERA HAMADOU": "c_hdramera",
  "JADE SENDZE": "c_jsendze", "SENDZE JADE": "c_jsendze",
  "ANABELLE KOFFI": "c_akoffi4", "KOFFI ANABELLE": "c_akoffi4",
};

// ─── Parser OCR → données structurées ─────────────────────────────────────────

function normaliserTexte(t: string): string {
  // Corriger les erreurs OCR fréquentes sur les reçus Orange CI
  return t
    .replace(/aotit|aofit|août/gi, "août")
    .replace(/fevrier|février/gi, "février")
    .replace(/\bRecu\b/g, "Reçu")
    .replace(/\bN[°o]\b/g, "N°")
    .replace(/\bxor\b/gi, "XOF")
    .replace(/(\d)\s+(\d{3}),/g, "$1$2,")  // "93 220,34" garder tel quel
    .trim();
}

function extraireChamp(texte: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = texte.match(re);
    if (m) return m[1]?.trim() || null;
  }
  return null;
}

function parseMontant(s: string): number {
  // "110 000,00" ou "110.000,00" ou "110000" → 110000
  return parseFloat(s.replace(/\s/g, "").replace(/\./g, "").replace(",", ".")) || 0;
}

function parseDateOCR(dateStr: string): string | null {
  const MOIS: Record<string, string> = {
    janvier:"01", février:"02", fevrier:"02", mars:"03", avril:"04",
    mai:"05", juin:"06", juillet:"07", août:"08", aout:"08",
    septembre:"09", octobre:"10", novembre:"11", décembre:"12", decembre:"12"
  };
  // "17 août 2026 14:43" ou "17. août 2026"
  const m = dateStr.match(/(\d{1,2})[.\s]+(\w+)\s+(\d{4})/i);
  if (!m) return null;
  const moisNum = MOIS[m[2].toLowerCase()];
  if (!moisNum) return null;
  return `${m[3]}-${moisNum}-${m[1].padStart(2, "0")}`;
}

function parserTexteRecu(texte: string): Omit<LigneExtraite, "profile_id" | "confiance" | "erreurs"> {
  const t = normaliserTexte(texte);
  const lignes = t.split("\n").map(l => l.trim()).filter(Boolean);

  // ── Champs d'en-tête ────────────────────────────────────────────────────────
  const n_facture = extraireChamp(t, [
    /N[°o]\s*re[çc]u\s*[-—]\s*facture\s*[:\s]+([A-Z0-9\-_.]+)/i,
    /OCI-[A-Z]+\.\d+\.\d+/,
    /Re[çc]u\s*[—-]\s*Facture[:\s]+(\d+)/i,
  ]) || "";

  // N° facture complet depuis le grand titre
  const nFull = t.match(/N[°o]\s*re[çc]u\s*-\s*facture\s*:\s*(OCI-[A-Z0-9.]+)/i)?.[1] ||
                t.match(/OCI-[A-Z]+\.\d{3}\.\d+/)?.[0] || n_facture;

  const n_journal = extraireChamp(t, [
    /N[°o]\s*journal\s*[:\s]+(\d+)/i,
    /journal\s*[:\s]+(\d+)/i,
  ]) || "";

  const dateRaw = extraireChamp(t, [
    /Date\s*[:\s]+(\d{1,2}[.\s]\w+\s+\d{4}[^\\n]*)/i,
  ]) || "";
  const date_vente = parseDateOCR(dateRaw) || "";

  const operateur = extraireChamp(t, [
    /Op[ée]rateur\s*[:\s]+([A-ZÁÀÂÉÈÊÎÏÔÙÛÜ'\s]+?)(?:\n|Printing)/i,
    /Operator\s*[:\s]+([A-ZÁÀÂÉÈÊÎÏÔÙÛÜ'\s]+?)(?:\n|$)/i,
  ])?.trim().toUpperCase() || "";

  const site = extraireChamp(t, [
    /Site\s*[:\s]+([A-Z0-9-]+)/i,
  ]) || "";

  const agence_site = SITE_TO_AGENCE[site] || site;

  // Client (lignes avant l'en-tête date)
  // Le client est souvent en haut à gauche, avant "Date:"
  const clientZone = t.split(/Date\s*:/i)[0];
  const clientLines = clientZone.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.includes("Agence Orange") && !l.includes("OCI") && l.length > 3);
  const client = clientLines[clientLines.length - 1] || null;
  const n_client = extraireChamp(t, [/N[°o]\s*client\s*[:\s]+([\d.]+)/i]) || null;

  // ── Est un avoir ? ──────────────────────────────────────────────────────────
  const est_avoir = /\bAvoir\b/i.test(t);

  // ── Articles ─────────────────────────────────────────────────────────────────
  // Format : "0001 SERV00093 Business Mobile Mix 5 22 PCE 4237,29 93 220,34 XOF"
  // ou ligne suivante avec "18% TVA"
  const lignes_articles: LigneArticle[] = [];

  // Chercher les lignes avec pattern Pos/N° article
  const tableauStart = t.indexOf("Pos.");
  const tableauEnd = t.indexOf("Montant total net");
  if (tableauStart !== -1 && tableauEnd !== -1) {
    const tableau = t.substring(tableauStart, tableauEnd);
    const rowRegex = /\d{4}\s+[A-Z0-9\-/]+\s+(.+?)\s+(\d+)\s+PCE[.\s]+([0-9\s,]+)\s+([0-9\s,]+)\s*(?:XOF|xor)/gi;
    let m;
    while ((m = rowRegex.exec(tableau)) !== null) {
      const libelle = m[1].trim().replace(/18%\s*TVA/i, "").trim();
      if (!libelle || libelle.length < 3) continue;
      lignes_articles.push({
        libelle,
        quantite: parseInt(m[2]) || 1,
        prix_unitaire: parseMontant(m[3]),
        total: parseMontant(m[4]),
      });
    }
  }

  // Fallback : chercher les lignes article une par une si le regex tableau n'a rien trouvé
  if (lignes_articles.length === 0) {
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      // Ligne typique : "0001  SERV00093  Business Mobile Mix 5  22 PCE.  4237,29  93 220,34 xor"
      const mLigne = l.match(/^(\d{4})\s+\S+\s+(.+?)\s+(\d+)\s+PC[E.]+\s+([\d\s,]+)\s+([\d\s,]+)/i);
      if (mLigne) {
        lignes_articles.push({
          libelle: mLigne[2].trim(),
          quantite: parseInt(mLigne[3]) || 1,
          prix_unitaire: parseMontant(mLigne[4]),
          total: parseMontant(mLigne[5]),
        });
      }
      // Avoir : "AP  Avoir  1 PCE  10000"
      const mAvoir = l.match(/AP\s+Avoir\s+(\d+)\s+PCE[.\s]+([\d\s,]+)/i);
      if (mAvoir) {
        lignes_articles.push({
          libelle: extraireChamp(t, [/AJOUT\s+(.+?)(?:\n|$)/i]) || "Avoir",
          quantite: 1,
          prix_unitaire: parseMontant(mAvoir[2]),
          total: parseMontant(mAvoir[2]),
        });
      }
    }
  }

  // ── Montant total ───────────────────────────────────────────────────────────
  const montantRaw = extraireChamp(t, [
    /Montant total\s+([\d\s,]+)\s*(?:XOF|xor)/i,
    /Montant total\b[^\n]*([\d]{3,}[,\s][\d]{2,})/i,
  ]) || "";
  const montant_total = parseMontant(montantRaw) ||
    lignes_articles.reduce((s, a) => s + a.total, 0);

  // Mode paiement
  const mode_paiement = extraireChamp(t, [
    /(Orange Money\d*|Espèces|Especes|Chèque|Cheque|Virement)/i,
  ]);

  return {
    n_facture: nFull || n_facture,
    n_journal,
    date_vente,
    operateur,
    agence_site,
    client,
    n_client,
    lignes_articles,
    montant_total,
    est_avoir,
    mode_paiement,
    texte_brut: t,
  };
}

// ─── Rasterisation PDF → canvas ───────────────────────────────────────────────

async function pdfPageToCanvas(file: File, pageNum: number): Promise<HTMLCanvasElement> {
  const pdfjsLib = (window as any).pdfjsLib;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 2.0 }); // 200 DPI pour meilleure OCR
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
  return canvas;
}

async function getPdfPageCount(file: File): Promise<number> {
  const pdfjsLib = (window as any).pdfjsLib;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  return pdf.numPages;
}

// ─── Sous-composant : Import Scan PDF ─────────────────────────────────────────

function ImportScanPDF({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [lignes, setLignes] = useState<LigneRevue[]>([]);
  const [step, setStep] = useState<"idle" | "loading_pdfjs" | "processing" | "review" | "done">("idle");
  const [progress, setProgress] = useState({ label: "", pct: 0 });
  const [saving, setSaving] = useState(false);
  const [resultats, setResultats] = useState({ inseres: 0, lignes_inserees: 0, erreurs: 0 });

  // Charger PDF.js au clic (lazy)
  function chargerPdfJs(): Promise<void> {
    return new Promise((resolve) => {
      if ((window as any).pdfjsLib) { resolve(); return; }
      setStep("loading_pdfjs");
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    await chargerPdfJs();
    setStep("processing");
    setLignes([]);

    // Charger profils
    const { data: profils } = await supabase
      .from("profiles")
      .select("id, login_oci, nom")
      .eq("actif", true)
      .eq("role", "commercial");

    const loginToId: Record<string, string> = {};
    (profils ?? []).forEach((p: any) => { if (p.login_oci) loginToId[p.login_oci] = p.id; });

    // Compter total pages
    let totalPages = 0;
    const pageCounts: number[] = [];
    for (const f of files) {
      const n = await getPdfPageCount(f);
      pageCounts.push(n);
      totalPages += n;
    }

    // Créer worker Tesseract (une seule instance réutilisée)
    setProgress({ label: "Initialisation OCR...", pct: 2 });
    const worker = await createWorker("eng", 1, {
      logger: () => {}, // silence les logs
    });

    const toutesLignes: LigneRevue[] = [];
    let pageGlobale = 0;

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const nbPages = pageCounts[fi];

      for (let p = 1; p <= nbPages; p++) {
        pageGlobale++;
        const pct = Math.round((pageGlobale / totalPages) * 90);
        setProgress({ label: `${file.name} — page ${p}/${nbPages}`, pct });

        try {
          const canvas = await pdfPageToCanvas(file, p);
          const { data: { text } } = await worker.recognize(canvas);

          const extraite = parserTexteRecu(text);

          // Résoudre profile_id
          const nomOp = extraite.operateur.toUpperCase().trim();
          const login = OPERATEUR_TO_LOGIN[nomOp] ||
            Object.entries(OPERATEUR_TO_LOGIN).find(([k]) =>
              nomOp.includes(k) || k.includes(nomOp)
            )?.[1] || null;
          const profile_id = login ? loginToId[login] || null : null;

          const erreurs: string[] = [];
          if (!extraite.n_facture) erreurs.push("N° facture non trouvé");
          if (!extraite.date_vente) erreurs.push("Date non trouvée");
          if (!extraite.operateur) erreurs.push("Opérateur non trouvé");
          if (!profile_id) erreurs.push(`Opérateur non reconnu : "${extraite.operateur}"`);
          if (extraite.lignes_articles.length === 0) erreurs.push("Aucun article extrait");

          const confiance: "haute" | "moyenne" | "faible" =
            erreurs.length === 0 ? "haute" :
            erreurs.length <= 1 ? "moyenne" : "faible";

          toutesLignes.push({
            ...extraite,
            profile_id,
            confiance,
            erreurs,
            selected: confiance !== "faible",
            page_source: pageGlobale,
          });
        } catch (err) {
          console.error(`Erreur page ${p}:`, err);
        }
      }
    }

    await worker.terminate();
    setProgress({ label: "Terminé", pct: 100 });
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
    let lignes_inserees = 0;
    let erreurs = 0;

    for (const l of selection) {
      const statut = l.profile_id && l.n_facture && l.n_journal ? "validee" : "en_attente_oci";

      // Une ligne par article — si pas d'articles, une ligne globale
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
            commission_oci: 0, points: 0, prime: 0,
            n_facture: l.n_facture || null,
            n_journal: l.n_journal || null,
            n_client: l.n_client || null,
            mode_paiement: l.mode_paiement,
            statut,
            est_avoir: l.est_avoir,
            libelle_source: "pdf_scan",
            cree_par: profile.id,
          }))
        : [{
            profile_id: l.profile_id,
            date_vente: l.date_vente || null,
            agence: l.agence_site || "—",
            univers: "AUTRES" as const,
            offre: "Voir reçu PDF",
            client: l.client,
            quantite: 1,
            prix_unitaire: l.montant_total,
            ca_ttc: l.montant_total,
            commission_oci: 0, points: 0, prime: 0,
            n_facture: l.n_facture || null,
            n_journal: l.n_journal || null,
            n_client: l.n_client || null,
            mode_paiement: l.mode_paiement,
            statut,
            est_avoir: l.est_avoir,
            libelle_source: "pdf_scan",
            cree_par: profile.id,
          }];

      const { error } = await supabase.from("sales").insert(rows);
      if (error) { erreurs++; console.error(l.n_facture, error.message); }
      else { inseres++; lignes_inserees += rows.length; }
    }

    setResultats({ inseres, lignes_inserees, erreurs });
    setStep("done");
    setSaving(false);
  }

  const confianceBadge = (c: "haute" | "moyenne" | "faible") => {
    const s = { haute: "bg-green-100 text-green-700", moyenne: "bg-amber-100 text-amber-700", faible: "bg-red-100 text-red-700" };
    return <span className={`text-xs px-2 py-0.5 rounded-full ${s[c]}`}>{c}</span>;
  };

  // ── Idle ─────────────────────────────────────────────────────────────────────
  if (step === "idle" || step === "loading_pdfjs") return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Import de reçus Orange CI scannés au format PDF. L'OCR tourne entièrement dans votre navigateur —
        <strong> aucun appel API, aucun token consommé.</strong>
      </p>
      <label className={`flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 transition-colors ${step === "loading_pdfjs" ? "opacity-50" : "cursor-pointer hover:border-slate-400"}`}>
        <span className="text-3xl mb-2">{step === "loading_pdfjs" ? "⏳" : "🔍"}</span>
        <span className="text-sm font-medium text-slate-700 mb-1">
          {step === "loading_pdfjs" ? "Chargement du moteur PDF..." : "Cliquer pour choisir les PDF scannés"}
        </span>
        <span className="text-xs text-slate-400">.pdf — plusieurs fichiers autorisés</span>
        <input ref={fileRef} type="file" accept=".pdf" multiple
          onChange={handleFiles} className="hidden" disabled={step === "loading_pdfjs"} />
      </label>
      <div className="mt-4 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700 space-y-1">
        <p className="font-medium">Comment ça marche :</p>
        <p>• Chaque page = un reçu → OCR local (Tesseract) lit le texte</p>
        <p>• Extraction automatique : N° facture, N° journal, date, opérateur, articles</p>
        <p>• <strong>Multi-articles gérés</strong> : chaque ligne article → une vente dans la base</p>
        <p>• Révision et correction avant insertion</p>
      </div>
    </div>
  );

  // ── Processing ───────────────────────────────────────────────────────────────
  if (step === "processing") return (
    <div className="py-8">
      <div className="text-center mb-6">
        <div className="text-3xl mb-3">🔍</div>
        <p className="text-sm font-medium text-slate-800 mb-1">OCR en cours...</p>
        <p className="text-xs text-slate-400">{progress.label}</p>
      </div>
      <div className="max-w-sm mx-auto">
        <div className="bg-slate-100 rounded-full h-3 overflow-hidden">
          <div className="bg-slate-800 h-full rounded-full transition-all duration-500"
            style={{ width: `${progress.pct}%` }} />
        </div>
        <div className="flex justify-between text-xs text-slate-400 mt-1">
          <span>OCR local — 0 token consommé</span>
          <span>{progress.pct}%</span>
        </div>
      </div>
    </div>
  );

  // ── Done ─────────────────────────────────────────────────────────────────────
  if (step === "done") return (
    <div className="text-center py-8">
      <div className="text-3xl mb-3">✅</div>
      <p className="text-base font-medium text-slate-900 mb-1">Import terminé</p>
      <div className="flex justify-center gap-4 mb-4">
        <div className="text-center">
          <div className="text-xl font-bold text-green-600">{resultats.inseres}</div>
          <div className="text-xs text-slate-400">reçus importés</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold text-blue-600">{resultats.lignes_inserees}</div>
          <div className="text-xs text-slate-400">lignes créées</div>
        </div>
        {resultats.erreurs > 0 && (
          <div className="text-center">
            <div className="text-xl font-bold text-red-500">{resultats.erreurs}</div>
            <div className="text-xs text-slate-400">erreurs</div>
          </div>
        )}
      </div>
      <button onClick={() => { setStep("idle"); setLignes([]); }}
        className="text-sm text-slate-600 underline">Importer d'autres PDF</button>
    </div>
  );

  // ── Review ───────────────────────────────────────────────────────────────────
  const nbSel = lignes.filter(l => l.selected).length;
  const nbLignesTotal = lignes.filter(l => l.selected)
    .reduce((s, l) => s + Math.max(l.lignes_articles.length, 1), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-medium text-slate-900">{lignes.length} reçu(s) analysé(s)</p>
          <p className="text-xs text-slate-400">
            {nbSel} sélectionné(s) → <strong>{nbLignesTotal} ligne(s)</strong> seront créées dans la base
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setLignes(p => p.map(l => ({ ...l, selected: true })))}
            className="text-xs text-slate-500 underline">Tout cocher</button>
          <button onClick={() => setLignes(p => p.map(l => ({ ...l, selected: false })))}
            className="text-xs text-slate-500 underline">Tout décocher</button>
        </div>
      </div>

      <div className="space-y-3 max-h-[60vh] overflow-y-auto mb-4 pr-1">
        {lignes.map((l, i) => (
          <div key={i} className={`border rounded-lg p-4 ${l.selected ? "border-slate-300" : "border-slate-100 opacity-60"}`}>
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={l.selected} onChange={() => toggleLigne(i)} className="mt-1 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                {/* En-tête */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="text-sm font-mono font-semibold text-slate-800">{l.n_facture || "—"}</span>
                  <span className="text-xs text-slate-400">J.{l.n_journal || "—"}</span>
                  {confianceBadge(l.confiance)}
                  {l.est_avoir && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">AVOIR</span>}
                  <span className="ml-auto text-xs text-slate-300">p.{l.page_source}</span>
                </div>

                {/* Champs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Date</label>
                    <input type="date" value={l.date_vente}
                      onChange={e => updateLigne(i, "date_vente", e.target.value)}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Opérateur</label>
                    <input type="text" value={l.operateur}
                      onChange={e => updateLigne(i, "operateur", e.target.value)}
                      className={`w-full border rounded px-2 py-1 text-xs ${!l.profile_id ? "border-amber-300 bg-amber-50" : "border-slate-200"}`} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Agence</label>
                    <input type="text" value={l.agence_site}
                      onChange={e => updateLigne(i, "agence_site", e.target.value)}
                      className="w-full border border-slate-200 rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-0.5">Total TTC</label>
                    <div className="text-xs font-bold text-slate-900 px-2 py-1">
                      {l.montant_total.toLocaleString("fr-FR")} F
                    </div>
                  </div>
                </div>

                {/* Articles */}
                {l.lignes_articles.length > 0 ? (
                  <div className="bg-slate-50 rounded-md p-2 mb-2">
                    <p className="text-[10px] text-slate-400 mb-1 font-medium uppercase tracking-wide">
                      {l.lignes_articles.length} article(s) → {l.lignes_articles.length} ligne(s) vente
                    </p>
                    {l.lignes_articles.map((a, j) => (
                      <div key={j} className="flex gap-2 text-xs items-center py-0.5 border-b border-slate-100 last:border-0">
                        <span className="flex-1 text-slate-700 truncate" title={a.libelle}>{a.libelle}</span>
                        <span className="text-slate-400 flex-shrink-0">×{a.quantite}</span>
                        <span className="text-slate-400 flex-shrink-0">{a.prix_unitaire.toLocaleString("fr-FR")} F</span>
                        <span className="font-semibold text-slate-800 w-24 text-right flex-shrink-0">
                          {a.total.toLocaleString("fr-FR")} F
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-amber-50 rounded px-2 py-1 text-xs text-amber-600 mb-2">
                    ⚠ Articles non extraits — 1 ligne globale sera créée à {l.montant_total.toLocaleString("fr-FR")} F
                  </div>
                )}

                {/* Client */}
                {l.client && (
                  <p className="text-xs text-slate-400">Client : {l.client}{l.n_client ? ` — N° ${l.n_client}` : ""}</p>
                )}

                {/* Erreurs */}
                {l.erreurs.length > 0 && (
                  <p className="text-xs text-amber-600 mt-1">⚠ {l.erreurs.join(" · ")}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-3 items-center">
        <button onClick={() => { setStep("idle"); setLignes([]); }}
          className="px-4 py-2 text-sm border border-slate-300 rounded-md text-slate-600 hover:bg-slate-50">
          Annuler
        </button>
        <button onClick={inserer} disabled={saving || nbSel === 0}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50">
          {saving ? "Insertion..." : `Insérer ${nbSel} reçu(s) → ${nbLignesTotal} ligne(s)`}
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
        const wb = XLSX.read(await file.arrayBuffer(), {type:"array"});
        const sheetName = wb.SheetNames.find(n=>n.toLowerCase().includes("ventes")||n.toLowerCase().includes("données"));
        if (!sheetName) { addLog(`   ⚠ Feuille introuvable`); continue; }
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{defval:null}) as any[];
        let skip = 0;
        for (const row of rows) {
          const dateVente = parseExcelDate(row["Date"]);
          if (!dateVente) { skip++; continue; }
          const nom = String(row["Commercial"]??"").trim().toUpperCase();
          const login = NOM_TO_LOGIN[nom];
          const pid = login ? loginToId[login] : null;
          const nFacture = String(row["N° Reçu-Facture"]??"").trim()||null;
          const nJournal = String(row["N° Journal"]??"").trim();
          const ca = parseFloat(String(row["CA TTC (XOF)"]??row["Prix TTC (XOF)"]??0));
          const journalValide = /^\d+$/.test(nJournal);
          toutesLignes.push({
            profile_id: pid ?? "00000000-0000-0000-0000-000000000020",
            date_vente: dateVente,
            agence: String(row["Agence"]??"").trim()||null,
            univers: normalizeUnivers(String(row["Univers"]??row["Offre / Libellé"]??"")),
            offre: String(row["Offre / Libellé"]??"").trim()||"Inconnu",
            client: String(row["Client"]??"").trim()||null,
            quantite: parseInt(String(row["Qté"]??1),10),
            prix_unitaire: parseFloat(String(row["Prix TTC (XOF)"]??0)),
            ca_ttc: ca,
            commission_oci: parseFloat(String(row["Comm. OCI HT (XOF)"]??0)),
            points:0, prime:0,
            n_facture: nFacture,
            n_journal: journalValide ? nJournal : null,
            n_client: String(row["N° Client"]??"").trim()||null,
            mode_paiement: String(row["Mode Paiement"]??"").trim()||null,
            statut: pid && nFacture && journalValide ? "validee" : "en_attente_oci",
            est_avoir: ca < 0,
            libelle_source: "excel_ventes",
            cree_par: profile.id,
            _key: `${nFacture}|${String(row["Offre / Libellé"]??"").trim()}|${ca}`,
          });
        }
        addLog(`   → ${rows.length-skip} lignes (${skip} sans date)`);
      }
      addLog(`Total brut : ${toutesLignes.length}`);
      const vus = new Set<string>();
      toutesLignes = toutesLignes.filter(l=>{if(vus.has(l._key))return false;vus.add(l._key);return true;});
      addLog(`Après dédup : ${toutesLignes.length}`);
      const nFact = [...new Set(toutesLignes.map(l=>l.n_facture).filter(Boolean))];
      let doublons = 0;
      if (nFact.length) {
        const {data:ex} = await supabase.from("sales").select("n_facture,offre,ca_ttc").in("n_facture",nFact as string[]);
        const cb = new Set((ex??[]).map((e:any)=>`${e.n_facture}|${e.offre}|${e.ca_ttc}`));
        const av = toutesLignes.length;
        toutesLignes = toutesLignes.filter(l=>!cb.has(l._key));
        doublons = av - toutesLignes.length;
        if(doublons) addLog(`⚠ ${doublons} doublons exclus`);
      }
      if(!toutesLignes.length){addLog("⚠ Tout déjà en base.");setStatus("done");setStats({inseres:0,doublons,incomplets:0});return;}
      const ins = toutesLignes.map(({_key,...r})=>r);
      const inc = ins.filter(l=>l.statut==="en_attente_oci").length;
      addLog(`À insérer : ${ins.length} (${inc} en attente)`);
      for(let i=0;i<Math.ceil(ins.length/200);i++){
        const {error}=await supabase.from("sales").insert(ins.slice(i*200,(i+1)*200));
        if(error) throw new Error(error.message);
      }
      setStats({inseres:ins.length,doublons,incomplets:inc});
      addLog(`✅ ${ins.length} insérées.`);
      setStatus("done");
    } catch(err:any){addLog(`❌ ${err.message}`);setStatus("error");}
    finally{if(fileRef.current)fileRef.current.value="";}
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Fichier : <code className="bg-slate-100 px-1 rounded">AZUR_INTER_Ventes_Justificatif_OCI_*.xlsx</code> — Feuille : <strong>Données ventes AZUR</strong></p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 mb-4">
        <span className="text-2xl mb-2">📂</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Choisir fichier(s) Excel</span>
        <span className="text-xs text-slate-400">sélection multiple autorisée</span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={handleFiles} className="hidden" disabled={status==="loading"} />
      </label>
      {status!=="idle"&&<div className={`text-xs px-3 py-2 rounded-md mb-3 ${status==="loading"?"bg-blue-50 text-blue-700":status==="done"?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>{status==="loading"&&"⏳ En cours…"}{status==="done"&&"✅ Réussi"}{status==="error"&&"❌ Erreur"}</div>}
      {stats&&<div className="grid grid-cols-3 gap-3 mb-4"><div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-green-700">{stats.inseres}</div><div className="text-xs text-green-600">insérées</div></div><div className="bg-amber-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-amber-700">{stats.incomplets}</div><div className="text-xs">en attente OCI</div></div><div className="bg-slate-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-slate-500">{stats.doublons}</div><div className="text-xs">doublons exclus</div></div></div>}
      {log.length>0&&<div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto">{log.map((l,i)=><div key={i} style={{color:l.startsWith("✅")?"#4ade80":l.startsWith("❌")?"#f87171":l.startsWith("⚠")?"#fbbf24":undefined}}>{l}</div>)}</div>}
    </div>
  );
}

// ─── Sous-composant : Import Rapport OCI Excel ───────────────────────────────

function ImportOCIExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle"|"loading"|"done"|"error">("idle");
  function addLog(m:string){setLog(p=>[...p,m]);}
  function parseDate(val:unknown):string|null{
    if(!val)return null;
    if(typeof val==="number"){const d=new Date(Math.round((val-25569)*86400*1000));return isNaN(d.getTime())?null:d.toISOString().split("T")[0];}
    const m=String(val).match(/(\d{4})-(\d{2})-(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:null;
  }
  async function handleFiles(e:React.ChangeEvent<HTMLInputElement>){
    const files=Array.from(e.target.files??[]);if(!files.length)return;
    setStatus("loading");setLog([]);
    try{
      let tx:any[]=[];
      for(const file of files){
        addLog(`📄 ${file.name}`);
        const wb=XLSX.read(await file.arrayBuffer(),{type:"array"});
        addLog(`  Feuilles : ${wb.SheetNames.join(", ")}`);
        for(const shName of["Base FTTH","Base Backlog"]){
          const sh=wb.Sheets[shName];if(!sh)continue;
          const rows=XLSX.utils.sheet_to_json(sh,{defval:null})as any[];
          addLog(`  ${shName} : ${rows.length}`);
          for(const r of rows){const d=parseDate(r["date_creation_dossier"]);tx.push({ref_externe:String(r["contratclient"]??r["id_dossier"]??"").trim()||null,source:shName==="Base Backlog"?"FTTH_BACKLOG":"FTTH",date_transaction:d,mois:d?.substring(0,7)||null,offre:String(r["offer"]??r["produit"]??"").trim()||null,agence:String(r["pointvente"]??"").trim()||null,login_oci:String(r["Login"]??r["login"]??r["usercrea"]??"").trim()||null,client:String(r["nomclient"]??"").trim()||null,univers:"INTERNET",quantite:1,prix_ttc:parseFloat(String(r["Récurrent"]??0))||null,commission_oci:null,statut_oci:String(r["statut"]??"").trim()||null,n_facture:String(r["rscoptiquepb"]??"").trim()||null,n_journal:null,remarque:String(r["motif"]??r["etape"]??"").trim()||null,fichier_source:shName,importe_par:profile.id});}
        }
        const s4=wb.Sheets["Base 4G"];if(s4){const rows=XLSX.utils.sheet_to_json(s4,{defval:null})as any[];addLog(`  Base 4G : ${rows.length}`);for(const r of rows){const d=parseDate(r["date_facture"]??r["date_jour"]);tx.push({ref_externe:String(r["numero_facture"]??"").trim()||null,source:"4G",date_transaction:d,mois:d?.substring(0,7)||null,offre:String(r["offre"]??"").trim()||null,agence:String(r["code_agence"]??"").trim()||null,login_oci:String(r["Login"]??r["user_name"]??"").trim()||null,client:String(r["customer_name"]??"").trim()||null,univers:"INTERNET",quantite:1,prix_ttc:parseFloat(String(r["montant_facture"]??0))||null,commission_oci:null,statut_oci:"installe",n_facture:String(r["numero_facture"]??"").trim()||null,n_journal:String(r["numero_recu"]??"").trim()||null,remarque:null,fichier_source:"Base 4G",importe_par:profile.id});}}
        const sm=wb.Sheets["Mobile NTS"];if(sm){const rows=XLSX.utils.sheet_to_json(sm,{defval:null})as any[];addLog(`  Mobile NTS : ${rows.length}`);for(const r of rows){const d=parseDate(r["Date de transaction"]??r["Date comptable"]);tx.push({ref_externe:String(r["N< Facture mensuelle/Initiale"]??r["Numéro du journal"]??"").trim()||null,source:"MOBILE",date_transaction:d,mois:d?.substring(0,7)||null,offre:String(r["Offres"]??r["Nom article"]??"").trim()||null,agence:String(r["Nom Agence"]??"").trim()||null,login_oci:String(r["Login utilisateur"]??"").trim()||null,client:String(r["Nom Client"]??"").trim()||null,univers:"MOBILE",quantite:parseInt(String(r["Quantité "]??r["Quantite"]??1),10),prix_ttc:parseFloat(String(r["Prix unitaire"]??0))||null,commission_oci:parseFloat(String(r["Commissions"]??0))||null,statut_oci:"installe",n_facture:String(r["N< Facture mensuelle/Initiale"]??"").trim()||null,n_journal:String(r["Numéro du journal"]??"").trim()||null,remarque:null,fichier_source:"Mobile NTS",importe_par:profile.id});}}
      }
      addLog(`Total : ${tx.length}`);
      if(!tx.length)throw new Error("Aucune donnée.");
      for(let i=0;i<Math.ceil(tx.length/200);i++){const{error}=await supabase.from("oci_transactions").insert(tx.slice(i*200,(i+1)*200));if(error)throw new Error(error.message);addLog(`  Lot ${i+1} envoyé.`);}
      addLog(`✅ ${tx.length} transactions insérées.`);setStatus("done");
    }catch(err:any){addLog(`❌ ${err.message}`);setStatus("error");}
    finally{if(fileRef.current)fileRef.current.value="";}
  }
  return(
    <div>
      <p className="text-sm text-slate-500 mb-4">Fichier : <code className="bg-slate-100 px-1 rounded">OCI_DISTRI_OSS_AZUR_INTER_*.xlsx</code> — Feuilles : Base FTTH, Base Backlog, Base 4G, Mobile NTS</p>
      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 mb-4">
        <span className="text-2xl mb-2">📡</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Choisir rapport(s) OCI</span>
        <span className="text-xs text-slate-400">sélection multiple autorisée</span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={handleFiles} className="hidden" disabled={status==="loading"}/>
      </label>
      {status!=="idle"&&<div className={`text-xs px-3 py-2 rounded-md mb-3 ${status==="loading"?"bg-blue-50 text-blue-700":status==="done"?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>{status==="loading"&&"⏳"}{status==="done"&&"✅ Réussi"}{status==="error"&&"❌ Erreur"}</div>}
      {log.length>0&&<div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-40 overflow-y-auto">{log.map((l,i)=><div key={i} style={{color:l.startsWith("✅")?"#4ade80":l.startsWith("❌")?"#f87171":undefined}}>{l}</div>)}</div>}
    </div>
  );
}

// ─── Composant principal ──────────────────────────────────────────────────────

export default function ImportPDF({ profile }: Props) {
  const [onglet, setOnglet] = useState<Onglet>("scan_pdf");
  const tabs = [
    { key: "scan_pdf" as Onglet,     label: "🔍 Scan PDF" },
    { key: "ventes_excel" as Onglet, label: "📋 Ventes Excel" },
    { key: "oci_excel" as Onglet,    label: "📡 Rapport OCI" },
  ];
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Import de données</h1>
      <p className="text-sm text-slate-500 mb-5">Reçus PDF scannés · Justificatif Excel · Rapport OCI Distri</p>
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {tabs.map(t=>(
          <button key={t.key} onClick={()=>setOnglet(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${onglet===t.key?"bg-white border border-b-white border-slate-200 text-slate-900 -mb-px":"text-slate-500 hover:text-slate-700"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {onglet==="scan_pdf"     && <ImportScanPDF profile={profile}/>}
      {onglet==="ventes_excel" && <ImportVentesExcel profile={profile}/>}
      {onglet==="oci_excel"    && <ImportOCIExcel profile={profile}/>}
    </div>
  );
}
