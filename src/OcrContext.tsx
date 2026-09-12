import { createContext, useContext, useRef, useState, useCallback, type ReactNode } from "react";

// ─── Types échangés avec le Worker ────────────────────────────────────────────

export interface ArticleOCR {
  libelle: string;
  quantite: number;
  prix_unitaire: number;
  total: number;
}

export interface ReçuExtrait {
  n_facture: string;
  n_journal: string;
  date_vente: string;
  operateur: string;
  site: string;
  agence_site: string;
  client: string | null;
  n_client: string | null;
  articles: ArticleOCR[];
  montant_total: number;
  est_avoir: boolean;
  mode_paiement: string | null;
  texte_brut: string;
  erreurs: string[];
}

export interface OcrState {
  running: boolean;
  progress: { label: string; pct: number };
  results: ReçuExtrait[];
  done: boolean;
  error: string | null;
}

interface OcrContextValue {
  state: OcrState;
  startOcr: (files: { name: string; buffer: ArrayBuffer }[]) => void;
  cancelOcr: () => void;
  clearResults: () => void;
}

const OcrContext = createContext<OcrContextValue | null>(null);

export function OcrProvider({ children }: { children: ReactNode }) {
  const workerRef = useRef<Worker | null>(null);

  const [state, setState] = useState<OcrState>({
    running: false,
    progress: { label: "", pct: 0 },
    results: [],
    done: false,
    error: null,
  });

  const cancelOcr = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setState(s => ({ ...s, running: false }));
  }, []);

  const clearResults = useCallback(() => {
    setState({ running: false, progress: { label: "", pct: 0 }, results: [], done: false, error: null });
  }, []);

  const startOcr = useCallback((files: { name: string; buffer: ArrayBuffer }[]) => {
    // Tuer un éventuel worker précédent
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    setState({ running: true, progress: { label: "Démarrage...", pct: 1 }, results: [], done: false, error: null });

    const worker = new Worker(
      new URL("./pages/pdf-ocr.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === "PROGRESS") {
        setState(s => ({ ...s, progress: { label: msg.label, pct: msg.pct } }));
      }

      if (msg.type === "PAGE_DONE" && msg.result) {
        setState(s => ({ ...s, results: [...s.results, msg.result] }));
      }

      if (msg.type === "DONE") {
        setState(s => ({ ...s, running: false, done: true }));
        worker.terminate();
        workerRef.current = null;
      }

      if (msg.type === "ERROR") {
        setState(s => ({ ...s, running: false, error: msg.message }));
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.onerror = (err) => {
      setState(s => ({ ...s, running: false, error: err.message || "Erreur worker" }));
      workerRef.current = null;
    };

    // Transférer les buffers au worker (zero-copy)
    worker.postMessage(
      { type: "PROCESS_FILES", files },
      files.map(f => f.buffer)
    );
  }, []);

  return (
    <OcrContext.Provider value={{ state, startOcr, cancelOcr, clearResults }}>
      {children}
    </OcrContext.Provider>
  );
}

export function useOcr() {
  const ctx = useContext(OcrContext);
  if (!ctx) throw new Error("useOcr doit être utilisé dans OcrProvider");
  return ctx;
}
