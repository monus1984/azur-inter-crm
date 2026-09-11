import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";
import { parseTexteFactures, type LigneExtraiteOCI } from "../lib/parseFacturesOCI";
import { usePersistentState } from "../lib/usePersistentState";
import { deviserUnivers } from "../lib/univers";
import type { Profile } from "../types/database";

interface Props {
  profile: Profile;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LigneRevue extends LigneExtraiteOCI {
  selected: boolean;
  profileId: string | null;
  dejaEnBase: boolean;
}

type FiltreAffichage = "toutes" | "a_verifier";
type Onglet = "pdf" | "ventes_excel" | "oci_excel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estAVerifier(l: LigneRevue): boolean {
  return l.confiance === "faible" || !l.profileId || l.dejaEnBase;
}

const NOM_TO_LOGIN: Record<string, string> = {
  "AIDARA SYRA": "c_saidara",
  "BANHORO HABIBATA": "c_hbanhoro",
  "BAKAYOKO MAX": "c_lbakayoko1",
  "BANHORO NANTENIN": "c_nbanhoroep",
  "ANANI LINDA": "c_lamani",
  "BONNY CELESTE": "c_cbonny",
  "FATIGA MABOUTE": "c_afatiga",
  "DIAKITE HADJA SAYON": "c_sdiakite",
  "N'DRI JEANNETTE": "c_jndri1",
  "GUIBILIHONON DORCASSE": "c_dguibiliho",
  "AMOA HERVÉ": "c_hamoa",
  "ATTAYE SAUL": "c_sattaye",
  "KOUASSI NADÈGE-FLORE": "c_fkouassi5",
  "ATTO KEVIN": "c_ratto",
  "AGBARO AYEKO": "c_kagbaro",
  "DRAMERA HAMADOU": "c_hdramera",
  "SENDZE JADE": "c_jsendze",
  "KOFFI ANABELLE": "c_akoffi4",
};

function normalizeUnivers(raw: string | null): string {
  if (!raw) return "AUTRES";
  const u = String(raw).toUpperCase().trim();
  if (u.includes("INTERNET") || u.includes("FIBRE") || u.includes("4G") || u.includes("FTTH") || u.includes("EASYBOX") || u.includes("FLYBOX")) return "INTERNET";
  if (u.includes("MOBILE") || u.includes("MIX") || u.includes("SMS") || u.includes("COMMUNITY") || u.includes("START LITE")) return "MOBILE";
  if (u.includes("ICT") || u.includes("EASY OFFICE") || u.includes("MSSP") || u.includes("BAAS")) return "ICT";
  if (u.includes("FIXE") || u.includes("VOIX")) return "FIXE";
  return "AUTRES";
}

function parseExcelDate(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "number") {
    // Serial Excel
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  }
  const s = String(val).trim();
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Sous-composant : Import Ventes Excel ────────────────────────────────────

function ImportVentesExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null);
  const [stats, setStats] = useState<{ inseres: number; doublons: number; incomplets: number } | null>(null);

  function addLog(msg: string) {
    setLog(prev => [...prev, msg]);
  }

  async function fetchLoginToId(): Promise<Record<string, string>> {
    const { data } = await supabase.from("profiles").select("id, login_oci").not("login_oci", "is", null);
    const map: Record<string, string> = {};
    (data ?? []).forEach((p: { id: string; login_oci: string }) => {
      if (p.login_oci) map[p.login_oci] = p.id;
    });
    return map;
  }

  // Parse un workbook → tableau de lignes sales
  function parseWorkbook(wb: XLSX.WorkBook, loginToId: Record<string, string>) {
    const sheetName = wb.SheetNames.find(n =>
      n.toLowerCase().includes("ventes") || n.toLowerCase().includes("données")
    );
    if (!sheetName) throw new Error("Feuille 'Données ventes AZUR' introuvable.");

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null }) as Record<string, unknown>[];
    const sales = [];
    let skippedDate = 0;

    for (const row of rows) {
      const dateVente = parseExcelDate(row["Date"]);
      if (!dateVente) { skippedDate++; continue; }

      const nomRaw = String(row["Commercial"] ?? "").trim().toUpperCase();
      const loginOci = NOM_TO_LOGIN[nomRaw];
      const profileId = loginOci ? loginToId[loginOci] : null;
      const nFacture = String(row["N° Reçu-Facture"] ?? "").trim() || null;
      const caTtc = parseFloat(String(row["CA TTC (XOF)"] ?? row["Prix TTC (XOF)"] ?? 0));
      const commOci = parseFloat(String(row["Comm. OCI HT (XOF)"] ?? 0));
      const nJournal = String(row["N° Journal"] ?? "").trim();

      // Statut : validee si données complètes, en_attente_oci si manquant
      const donneeComplete = !!profileId && !!nFacture && !nJournal.includes("COMPLÉTER");
      const statut = donneeComplete ? "validee" : "en_attente_oci";

      sales.push({
        profile_id: profileId ?? "00000000-0000-0000-0000-000000000020",
        date_vente: dateVente,
        agence: String(row["Agence"] ?? "").trim() || null,
        univers: normalizeUnivers(String(row["Univers"] ?? row["Offre / Libellé"] ?? "")),
        offre: String(row["Offre / Libellé"] ?? "").trim() || "Inconnu",
        client: String(row["Client"] ?? "").trim() || null,
        quantite: parseInt(String(row["Qté"] ?? 1), 10),
        prix_unitaire: parseFloat(String(row["Prix TTC (XOF)"] ?? 0)),
        ca_ttc: caTtc,
        commission_oci: commOci,
        points: 0,
        prime: 0,
        n_facture: nFacture,
        n_journal: nJournal && !nJournal.includes("COMPLÉTER") ? nJournal : null,
        n_client: String(row["N° Client"] ?? "").trim() || null,
        ref_oci: String(row["Réf. OCI/B"] ?? "").trim() || null,
        mode_paiement: String(row["Mode Paiement"] ?? "").trim() || null,
        statut,
        est_avoir: caTtc < 0,
        cree_par: profile.id,
        _nFacture: nFacture, // champ temporaire pour déduplication
      });
    }

    return { sales, skippedDate };
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setStatus("loading");
    setLog([]);
    setPreview(null);
    setStats(null);

    try {
      const loginToId = await fetchLoginToId();
      addLog(`${Object.keys(loginToId).length} commerciaux trouvés en base.`);

      // 1. Parser tous les fichiers
      let toutesLignes: (ReturnType<typeof parseWorkbook>["sales"][0])[] = [];
      let totalSkippedDate = 0;

      for (const file of files) {
        addLog(`📄 Lecture : ${file.name}`);
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: "array" });
        const { sales, skippedDate } = parseWorkbook(wb, loginToId);
        addLog(`   → ${sales.length} lignes parsées${skippedDate > 0 ? `, ${skippedDate} sans date ignorées` : ""}`);
        toutesLignes = [...toutesLignes, ...sales];
        totalSkippedDate += skippedDate;
      }

      addLog(`Total brut : ${toutesLignes.length} lignes sur ${files.length} fichier(s).`);

      // 2. Déduplication interne (entre fichiers)
      const vusEnLocal = new Set<string>();
      toutesLignes = toutesLignes.filter(l => {
        const cle = `${l._nFacture}|${l.offre}|${l.ca_ttc}`;
        if (vusEnLocal.has(cle)) return false;
        vusEnLocal.add(cle);
        return true;
      });
      addLog(`Après déduplication interne : ${toutesLignes.length} lignes.`);

      // 3. Déduplication base (n_facture déjà en base)
      const nFactures = [...new Set(toutesLignes.map(l => l._nFacture).filter(Boolean))];
      let doublonsBase = 0;
      if (nFactures.length > 0) {
        const { data: existantes } = await supabase
          .from("sales")
          .select("n_facture, offre, ca_ttc")
          .in("n_facture", nFactures as string[]);
        const clesBase = new Set(
          (existantes ?? []).map((e: { n_facture: string; offre: string; ca_ttc: number }) =>
            `${e.n_facture}|${e.offre}|${e.ca_ttc}`
          )
        );
        const avant = toutesLignes.length;
        toutesLignes = toutesLignes.filter(l => {
          const cle = `${l._nFacture}|${l.offre}|${l.ca_ttc}`;
          return !clesBase.has(cle);
        });
        doublonsBase = avant - toutesLignes.length;
        if (doublonsBase > 0) addLog(`⚠ ${doublonsBase} doublons déjà en base exclus.`);
      }

      if (toutesLignes.length === 0) {
        addLog("⚠ Aucune nouvelle ligne à insérer — tout est déjà en base.");
        setStatus("done");
        setStats({ inseres: 0, doublons: doublonsBase, incomplets: 0 });
        return;
      }

      // 4. Nettoyer le champ temporaire avant insertion
      const aInserer = toutesLignes.map(({ _nFacture, ...rest }) => rest);
      const nbIncomplets = aInserer.filter(l => l.statut === "en_attente_oci").length;

      setPreview(aInserer.slice(0, 5) as Record<string, unknown>[]);
      addLog(`À insérer : ${aInserer.length} lignes (dont ${nbIncomplets} en attente OCI).`);

      // 5. Insertion par lots
      const chunks2 = chunk(aInserer, 200);
      for (let i = 0; i < chunks2.length; i++) {
        const { error } = await supabase.from("sales").insert(chunks2[i]);
        if (error) throw new Error(error.message);
        addLog(`  Lot ${i + 1}/${chunks2.length} — ${chunks2[i].length} lignes envoyées.`);
      }

      setStats({ inseres: aInserer.length, doublons: doublonsBase, incomplets: nbIncomplets });
      addLog(`✅ Import terminé — ${aInserer.length} ventes insérées.`);
      setStatus("done");
    } catch (err: unknown) {
      addLog(`❌ ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Fichier(s) attendu(s) : <code className="bg-slate-100 px-1 rounded">AZUR_INTER_Ventes_Justificatif_OCI_*.xlsx</code>
        <br />Feuille : <strong>Données ventes AZUR</strong> — Sélection multiple possible.
      </p>

      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 transition-colors mb-4">
        <span className="text-2xl mb-2">📂</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Cliquer pour choisir un ou plusieurs fichiers Excel</span>
        <span className="text-xs text-slate-400">.xlsx — sélection multiple autorisée</span>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          multiple
          onChange={handleFiles}
          className="hidden"
          disabled={status === "loading"}
        />
      </label>

      {status !== "idle" && (
        <div className={`text-xs font-medium px-3 py-2 rounded-md mb-3 ${
          status === "loading" ? "bg-blue-50 text-blue-700" :
          status === "done" ? "bg-green-50 text-green-700" :
          "bg-red-50 text-red-700"
        }`}>
          {status === "loading" && "⏳ Import en cours…"}
          {status === "done" && "✅ Import réussi"}
          {status === "error" && "❌ Erreur lors de l'import"}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-green-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-green-700">{stats.inseres}</div>
            <div className="text-xs text-green-600">insérées</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-amber-700">{stats.incomplets}</div>
            <div className="text-xs text-amber-600">en attente OCI</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-slate-500">{stats.doublons}</div>
            <div className="text-xs text-slate-400">doublons exclus</div>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-48 overflow-y-auto mb-4">
          {log.map((l, i) => (
            <div key={i} style={{ color: l.startsWith("✅") ? "#4ade80" : l.startsWith("❌") ? "#f87171" : l.startsWith("⚠") ? "#fbbf24" : undefined }}>
              {l}
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div>
          <p className="text-xs font-medium text-slate-600 mb-2">Aperçu (5 premières lignes insérées)</p>
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse w-full">
              <thead>
                <tr>
                  {["date_vente","agence","offre","univers","ca_ttc","statut","n_facture"].map(k => (
                    <th key={k} className="bg-slate-100 border border-slate-200 px-2 py-1 text-left font-medium">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i}>
                    {["date_vente","agence","offre","univers","ca_ttc","statut","n_facture"].map(k => (
                      <td key={k} className={`border border-slate-200 px-2 py-1 max-w-[120px] truncate ${k === "statut" && row[k] === "en_attente_oci" ? "text-amber-600 font-medium" : ""}`}>
                        {row[k] == null ? <span className="text-slate-300">—</span> : String(row[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sous-composant : Import Rapport OCI Excel ───────────────────────────────

function ImportOCIExcel({ profile }: { profile: Profile }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  function addLog(msg: string) {
    setLog(prev => [...prev, msg]);
  }

  function parseOCIWorkbook(wb: XLSX.WorkBook) {
    const transactions: Record<string, unknown>[] = [];

    // FTTH + Backlog
    for (const shName of ["Base FTTH", "Base Backlog"]) {
      const sh = wb.Sheets[shName];
      if (!sh) continue;
      const rows = XLSX.utils.sheet_to_json(sh, { defval: null }) as Record<string, unknown>[];
      addLog(`  ${shName} : ${rows.length} lignes`);
      for (const row of rows) {
        const dateStr = parseExcelDate(row["date_creation_dossier"]);
        transactions.push({
          ref_externe: String(row["contratclient"] ?? row["id_dossier"] ?? "").trim() || null,
          source: shName === "Base Backlog" ? "FTTH_BACKLOG" : "FTTH",
          date_transaction: dateStr,
          mois: dateStr ? dateStr.substring(0, 7) : null,
          offre: String(row["offer"] ?? row["produit"] ?? "").trim() || null,
          agence: String(row["pointvente"] ?? "").trim() || null,
          login_oci: String(row["Login"] ?? row["login"] ?? row["usercrea"] ?? "").trim() || null,
          client: String(row["nomclient"] ?? "").trim() || null,
          univers: "INTERNET",
          quantite: 1,
          prix_ttc: parseFloat(String(row["Récurrent"] ?? 0)) || null,
          commission_oci: null,
          statut_oci: String(row["statut"] ?? "").trim() || null,
          n_facture: String(row["rscoptiquepb"] ?? "").trim() || null,
          n_journal: null,
          remarque: String(row["motif"] ?? row["etape"] ?? "").trim() || null,
          fichier_source: shName,
          importe_par: profile.id,
        });
      }
    }

    // Base 4G
    const sh4G = wb.Sheets["Base 4G"];
    if (sh4G) {
      const rows = XLSX.utils.sheet_to_json(sh4G, { defval: null }) as Record<string, unknown>[];
      addLog(`  Base 4G : ${rows.length} lignes`);
      for (const row of rows) {
        const dateStr = parseExcelDate(row["date_facture"] ?? row["date_jour"]);
        transactions.push({
          ref_externe: String(row["numero_facture"] ?? "").trim() || null,
          source: "4G",
          date_transaction: dateStr,
          mois: dateStr ? dateStr.substring(0, 7) : null,
          offre: String(row["offre"] ?? "").trim() || null,
          agence: String(row["code_agence"] ?? "").trim() || null,
          login_oci: String(row["Login"] ?? row["user_name"] ?? "").trim() || null,
          client: String(row["customer_name"] ?? "").trim() || null,
          univers: "INTERNET",
          quantite: 1,
          prix_ttc: parseFloat(String(row["montant_facture"] ?? 0)) || null,
          commission_oci: null,
          statut_oci: "installe",
          n_facture: String(row["numero_facture"] ?? "").trim() || null,
          n_journal: String(row["numero_recu"] ?? "").trim() || null,
          remarque: null,
          fichier_source: "Base 4G",
          importe_par: profile.id,
        });
      }
    }

    // Mobile NTS
    const shMobile = wb.Sheets["Mobile NTS"];
    if (shMobile) {
      const rows = XLSX.utils.sheet_to_json(shMobile, { defval: null }) as Record<string, unknown>[];
      addLog(`  Mobile NTS : ${rows.length} lignes`);
      for (const row of rows) {
        const dateStr = parseExcelDate(row["Date de transaction"] ?? row["Date comptable"]);
        transactions.push({
          ref_externe: String(row["N< Facture mensuelle/Initiale"] ?? row["Numéro du journal"] ?? "").trim() || null,
          source: "MOBILE",
          date_transaction: dateStr,
          mois: dateStr ? dateStr.substring(0, 7) : null,
          offre: String(row["Offres"] ?? row["Nom article"] ?? "").trim() || null,
          agence: String(row["Nom Agence"] ?? "").trim() || null,
          login_oci: String(row["Login utilisateur"] ?? "").trim() || null,
          client: String(row["Nom Client"] ?? "").trim() || null,
          univers: "MOBILE",
          quantite: parseInt(String(row["Quantité "] ?? row["Quantite"] ?? 1), 10),
          prix_ttc: parseFloat(String(row["Prix unitaire"] ?? 0)) || null,
          commission_oci: parseFloat(String(row["Commissions"] ?? 0)) || null,
          statut_oci: "installe",
          n_facture: String(row["N< Facture mensuelle/Initiale"] ?? "").trim() || null,
          n_journal: String(row["Numéro du journal"] ?? "").trim() || null,
          remarque: null,
          fichier_source: "Mobile NTS",
          importe_par: profile.id,
        });
      }
    }

    return transactions;
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus("loading");
    setLog([]);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      addLog(`Feuilles détectées : ${wb.SheetNames.join(", ")}`);

      const transactions = parseOCIWorkbook(wb);
      addLog(`Total : ${transactions.length} transactions parsées.`);

      if (transactions.length === 0) throw new Error("Aucune donnée trouvée. Vérifiez les noms des feuilles.");

      const chunks = chunk(transactions, 200);
      for (let i = 0; i < chunks.length; i++) {
        const { error } = await supabase.from("oci_transactions").insert(chunks[i]);
        if (error) throw new Error(error.message);
        addLog(`  Lot ${i + 1}/${chunks.length} — ${chunks[i].length} lignes envoyées.`);
      }

      addLog(`✅ Import terminé — ${transactions.length} transactions OCI insérées.`);
      setStatus("done");
    } catch (err: unknown) {
      addLog(`❌ ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">
        Fichier attendu : <code className="bg-slate-100 px-1 rounded">OCI_DISTRI_OSS_AZUR_INTER_*.xlsx</code>
        <br />Feuilles traitées : <strong>Base FTTH</strong>, <strong>Base Backlog</strong>, <strong>Base 4G</strong>, <strong>Mobile NTS</strong>
      </p>

      <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-8 cursor-pointer hover:border-slate-400 transition-colors mb-4">
        <span className="text-2xl mb-2">📡</span>
        <span className="text-sm font-medium text-slate-700 mb-1">Cliquer pour choisir le rapport OCI</span>
        <span className="text-xs text-slate-400">.xlsx uniquement</span>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFile}
          className="hidden"
          disabled={status === "loading"}
        />
      </label>

      {status !== "idle" && (
        <div className={`text-xs font-medium px-3 py-2 rounded-md mb-3 ${
          status === "loading" ? "bg-blue-50 text-blue-700" :
          status === "done" ? "bg-green-50 text-green-700" :
          "bg-red-50 text-red-700"
        }`}>
          {status === "loading" && "⏳ Import en cours…"}
          {status === "done" && "✅ Import réussi"}
          {status === "error" && "❌ Erreur lors de l'import"}
        </div>
      )}

      {log.length > 0 && (
        <div className="bg-slate-900 text-slate-300 rounded-lg p-3 font-mono text-xs max-h-48 overflow-y-auto">
          {log.map((l, i) => (
            <div key={i} style={{ color: l.startsWith("✅") ? "#4ade80" : l.startsWith("❌") ? "#f87171" : undefined }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Composant principal ──────────────────────────────────────────────────────

export default function ImportPDF({ profile }: Props) {
  const [onglet, setOnglet] = useState<Onglet>("pdf");

  // ── État onglet PDF (inchangé) ─────────────────────────────────────────────
  const [texteCollee, setTexteCollee] = usePersistentState("import_texte", "");
  const [lignes, setLignes] = usePersistentState<LigneRevue[]>("import_lignes", []);
  const [step, setStep] = usePersistentState<"saisie" | "review" | "done">("import_step", "saisie");
  const [profilesByNom, setProfilesByNom] = useState<Map<string, string>>(new Map());
  const [filtre, setFiltre] = useState<FiltreAffichage>("a_verifier");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importCount, setImportCount] = useState(0);
  const [importBacklog, setImportBacklog] = useState(0);

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
      setError('Aucune facture détectée. Vérifiez que le texte contient bien des lignes "N°recu-facture:OCI-...".');
      return;
    }
    setChecking(true);
    const facturesUniques = [...new Set(extraites.map(l => l.nFacture))];
    const { data: existantes } = await supabase.from("sales").select("n_facture, offre, ca_ttc").in("n_facture", facturesUniques);
    const clesExistantes = new Set((existantes ?? []).map((e: { n_facture: string; offre: string; ca_ttc: number }) => `${e.n_facture}|${e.offre}|${e.ca_ttc}`));
    const revues: LigneRevue[] = extraites.map(l => {
      const dejaEnBase = clesExistantes.has(`${l.nFacture}|${l.offre}|${l.montant}`);
      return { ...l, profileId: l.agentNom ? profilesByNom.get(l.agentNom) ?? null : null, dejaEnBase, selected: l.confiance !== "faible" && !!l.agentNom && !dejaEnBase };
    });
    setChecking(false);
    setLignes(revues);
    setStep("review");
  }

  function toggleLigne(i: number) { setLignes(prev => prev.map((l, j) => j === i ? { ...l, selected: !l.selected } : l)); }
  function updateLigne(i: number, field: keyof LigneRevue, value: string | number | boolean) { setLignes(prev => prev.map((l, j) => j === i ? { ...l, [field]: value } : l)); }
  function toutCocher(valeur: boolean) { setLignes(prev => prev.map(l => filtre === "toutes" || estAVerifier(l) ? { ...l, selected: valeur } : l)); }

  async function handleImport() {
    const selection = lignes.filter(l => l.selected);
    if (selection.length === 0) { setError("Sélectionnez au moins une ligne."); return; }
    setLoading(true); setError(null);
    const rows = selection.map(l => {
      const complete = !!l.profileId && !!l.date && l.montant !== null;
      return { profile_id: complete ? l.profileId : null, date_vente: l.date, agence: l.agence || "—", univers: deviserUnivers(l.offre), offre: l.offre, client: null, quantite: 1, prix_unitaire: l.montant ?? 0, ca_ttc: l.montant ?? 0, commission_oci: 0, points: 0, prime: 0, n_facture: l.nFacture, statut: complete ? "saisie" : "incomplete", est_avoir: l.estAvoir, cree_par: profile.id };
    });
    const { error: err } = await supabase.from("sales").insert(rows);
    if (err) { setError("Erreur : " + err.message); } else { const nbIncomplet = rows.filter(r => r.statut === "incomplete").length; setImportCount(selection.length); setImportBacklog(nbIncomplet); setStep("done"); setTexteCollee(""); setLignes([]); }
    setLoading(false);
  }

  function nouvelImport() { setStep("saisie"); setTexteCollee(""); setLignes([]); }

  const confianceBadge = (c: LigneExtraiteOCI["confiance"]) => {
    const styles = { haute: "bg-green-100 text-green-700", moyenne: "bg-amber-100 text-amber-700", faible: "bg-red-100 text-red-700" };
    return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[c]}`}>{c}</span>;
  };

  // ── Rendu ──────────────────────────────────────────────────────────────────

  const tabs: { key: Onglet; label: string }[] = [
    { key: "pdf", label: "📄 Reçus OCI" },
    { key: "ventes_excel", label: "📋 Ventes Excel" },
    { key: "oci_excel", label: "📡 Rapport OCI" },
  ];

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-4">Import de données</h1>

      {/* Onglets */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setOnglet(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              onglet === t.key
                ? "bg-white border border-b-white border-slate-200 text-slate-900 -mb-px"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Onglet Reçus OCI (inchangé) ──────────────────────────────────── */}
      {onglet === "pdf" && step === "done" && (
        <div>
          <h2 className="text-base font-medium text-slate-900 mb-3">Import terminé</h2>
          <p className="text-sm text-slate-600 mb-2">{importCount} vente{importCount > 1 ? "s" : ""} enregistrée{importCount > 1 ? "s" : ""}.</p>
          {importBacklog > 0 ? (
            <p className="text-sm text-amber-700 mb-4">Dont {importBacklog} ligne{importBacklog > 1 ? "s" : ""} incomplète{importBacklog > 1 ? "s" : ""} envoyée{importBacklog > 1 ? "s" : ""} dans le backlog.</p>
          ) : (
            <p className="text-sm text-slate-600 mb-4">Toutes les lignes sont en attente de validation.</p>
          )}
          <button onClick={nouvelImport} className="text-sm text-slate-600 underline">Importer un autre lot</button>
        </div>
      )}

      {onglet === "pdf" && step === "review" && (() => {
        const nbAVerifier = lignes.filter(estAVerifier).length;
        const lignesAffichees = filtre === "toutes" ? lignes : lignes.filter(estAVerifier);
        const lignesTriees = filtre === "toutes" ? [...lignesAffichees].sort((a, b) => Number(estAVerifier(b)) - Number(estAVerifier(a))) : lignesAffichees;
        return (
          <div>
            <h2 className="text-base font-medium text-slate-900 mb-1">Vérification avant import</h2>
            <p className="text-sm text-slate-500 mb-4">{lignes.length} ligne{lignes.length > 1 ? "s" : ""} détectée{lignes.length > 1 ? "s" : ""}, dont {nbAVerifier} à vérifier.</p>
            <div className="flex items-center justify-between mb-4">
              <div className="flex gap-2">
                <button onClick={() => setFiltre("a_verifier")} className={`px-3 py-1.5 text-xs rounded-md font-medium ${filtre === "a_verifier" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>À vérifier ({nbAVerifier})</button>
                <button onClick={() => setFiltre("toutes")} className={`px-3 py-1.5 text-xs rounded-md font-medium ${filtre === "toutes" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>Toutes ({lignes.length})</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => toutCocher(true)} className="text-xs text-slate-500 underline">Tout cocher</button>
                <button onClick={() => toutCocher(false)} className="text-xs text-slate-500 underline">Tout décocher</button>
              </div>
            </div>
            <div className="space-y-2 mb-6 max-h-[55vh] overflow-y-auto">
              {lignesTriees.map((l) => {
                const i = lignes.indexOf(l);
                return (
                  <div key={`${l.nFacture}-${l.offre}-${i}`} className={`border rounded-lg p-3 text-sm ${l.selected ? "border-slate-300" : "border-slate-100 opacity-60"}`}>
                    <div className="flex items-start gap-3">
                      <input type="checkbox" checked={l.selected} onChange={() => toggleLigne(i)} className="mt-1" />
                      <div className="flex-1 grid grid-cols-7 gap-2 items-center">
                        <span className="col-span-1 text-xs text-slate-500 truncate" title={l.nFacture}>{l.nFacture}</span>
                        <input type="date" value={l.date ?? ""} onChange={e => updateLigne(i, "date", e.target.value)} className="col-span-1 border border-slate-200 rounded px-1 py-1 text-xs" />
                        <input type="text" placeholder="Agent non reconnu" value={l.agentNom ?? ""} onChange={e => { updateLigne(i, "agentNom", e.target.value); updateLigne(i, "profileId", profilesByNom.get(e.target.value) ?? ""); }} className={`col-span-1 border rounded px-1 py-1 text-xs ${!l.profileId ? "border-red-300 bg-red-50" : "border-slate-200"}`} />
                        <input type="text" value={l.offre} onChange={e => updateLigne(i, "offre", e.target.value)} className="col-span-1 border border-slate-200 rounded px-1 py-1 text-xs" />
                        <input type="number" value={l.montant ?? ""} onChange={e => updateLigne(i, "montant", parseFloat(e.target.value))} className="col-span-1 border border-slate-200 rounded px-1 py-1 text-xs text-right" />
                        <div className="col-span-1">{l.dejaEnBase && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">déjà en base</span>}</div>
                        <div className="col-span-1 flex justify-end">{confianceBadge(l.confiance)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => setStep("saisie")} className="px-4 py-2 text-sm border border-slate-300 rounded-md">Retour</button>
              <button onClick={handleImport} disabled={loading} className="px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50">{loading ? "Import..." : `Importer ${lignes.filter(l => l.selected).length} ligne(s)`}</button>
            </div>
          </div>
        );
      })()}

      {onglet === "pdf" && step === "saisie" && (
        <div>
          <p className="text-sm text-slate-500 mb-4">Copiez le texte des reçus depuis Word et collez-le ci-dessous. Chaque reçu doit contenir une ligne "N°recu-facture:OCI-...". Une facture avec plusieurs articles donnera plusieurs lignes de vente.</p>
          <textarea value={texteCollee} onChange={e => setTexteCollee(e.target.value)} placeholder="Collez ici le texte copié depuis Word..." rows={14} className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono" />
          {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
          <button onClick={handleExtraire} disabled={checking} className="mt-4 px-4 py-2 text-sm bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50">{checking ? "Vérification des doublons..." : "Extraire les factures"}</button>
        </div>
      )}

      {/* ── Onglet Ventes Excel ───────────────────────────────────────────── */}
      {onglet === "ventes_excel" && <ImportVentesExcel profile={profile} />}

      {/* ── Onglet Rapport OCI Excel ─────────────────────────────────────── */}
      {onglet === "oci_excel" && <ImportOCIExcel profile={profile} />}
    </div>
  );
}