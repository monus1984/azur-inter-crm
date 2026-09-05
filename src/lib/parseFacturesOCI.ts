// Parseur de reçus OCI collés depuis Word.
//
// Contexte : les factures/reçus PDF d'OCI sont souvent des scans (images),
// illisibles par extraction de texte. Mais Mounir peut copier-coller le texte
// directement depuis Word, qui contient plusieurs dizaines de reçus concaténés
// avec une mise en page dégradée (colonnes mélangées, labels et valeurs sur
// des lignes différentes selon les pages).
//
// Le seul repère fiable dans tout ce bruit est la ligne
// "N°recu -facture:OCI-XXX.XXX.XXXXXX" (avec variantes OCR : "N recu", "Nrecu",
// "N⁰recu", "N regu"). Ce marqueur tombe AU MILIEU de chaque reçu : après
// l'en-tête (agence/client/date/opérateur), avant le corps (articles/montant).
//
// Stratégie : pour chaque marqueur, on découpe deux fenêtres de recherche :
//   - preText  = texte entre le marqueur précédent et le marqueur courant
//                (contient l'en-tête du reçu courant)
//   - postText = texte entre le marqueur courant et le marqueur suivant
//                (contient le corps du reçu courant)
// On y cherche respectivement date/agent et montant, sans jamais laisser un
// motif traverser un saut de ligne (source du bug de fusion de nombres).

export interface LigneExtraiteOCI {
  nFacture: string;
  date: string | null;       // ISO yyyy-mm-dd
  agentNom: string | null;   // nom canonique du roster, à résoudre en profile_id
  agence: string | null;
  offre: string;
  montant: number | null;
  estAvoir: boolean;
  confiance: 'haute' | 'moyenne' | 'faible'; // aide visuelle pour la relecture
}

const FACTURE_RE = /N[°⁰]?\s*(?:re[cg]u)\s*-?\s*[Ff]acture\s*:\s*(OCI-[A-Z]+\.\d+\.\d+)/g;

const MOIS: Record<string, number> = {
  jan: 1, fev: 2, 'fév': 2, mar: 3, avr: 4, mai: 5, juin: 6,
  juil: 7, aout: 8, 'août': 8, sept: 9, oct: 10, nov: 11, dec: 12, 'déc': 12,
};

// Roster figé au 02/09/2026. À tenir synchronisé avec COMMERCIAUX_ROSTER côté
// CRM historique si de nouveaux commerciaux rejoignent l'équipe.
const ROSTER: { agent: string; agence: string; alias: string[] }[] = [
  { agent: 'AIDARA SYRA',           agence: 'Angré 7ème Tranche',      alias: ['AIDARA', 'SYRA AISSATOU'] },
  { agent: 'BANHORO Habibata',      agence: 'Angré 7ème Tranche',      alias: ['HABIBATA BANHORO', 'BANHORO HABIBATA'] },
  { agent: 'BAKAYOKO MAX',          agence: 'Angré Djibi',             alias: ['MAX LANDRY BAKAYOKO', 'BAKAYOKO'] },
  { agent: 'BANHORO NANTENIN',      agence: 'Angré Djibi',             alias: ['NANTENIN BANHORO'] },
  { agent: 'ANANI LINDA',           agence: 'SmartStore',              alias: ['LINDA ANANI'] },
  { agent: 'BONNY CELESTE',         agence: 'SmartStore',              alias: ['CELESTE BONNY', 'JOSEPHINE CELESTE', 'BONNY'] },
  { agent: 'FATIGA MABOUTE',        agence: 'SmartStore',              alias: ['MABOUTE AISSATA FATIGA', 'AISSATA FATIGA'] },
  { agent: 'DIAKITE Hadja Sayon',   agence: 'SmartStore',              alias: ['SAYON DIAKITE', 'HADJA SAYON'] },
  { agent: "N'DRI JEANNETTE",       agence: 'Plateau Nord / Pyramide', alias: ["N'DRI JEANNETTE", 'NDRI JEANNETTE'] },
  { agent: 'GUIBILIHONON Dorcasse', agence: 'Plateau Nord / Pyramide', alias: ['DORCASSE GUIBILIHONON'] },
  { agent: 'AMOA Hervé',            agence: 'Adjamé Mosquée',          alias: ['HERVE AMOA'] },
  { agent: 'ATTAYE Saul',           agence: 'Adjamé Mosquée',          alias: ['SAUL ATTAYE'] },
  { agent: 'KOUASSI Nadège-Flore',  agence: 'Adjamé 220 Logts',        alias: ['NADEGE KOUASSI', 'NADEGE-FLORE'] },
  { agent: 'KOTIE Diane',           agence: 'Adjamé 220 Logts',        alias: ['DIANE KOTIE'] },
  { agent: 'ATTO Kevin',            agence: 'Bassam',                  alias: ['KEVIN ATTO'] },
  { agent: 'AGBARO Ayeko',          agence: 'Bassam',                  alias: ['AYEKO AGBARO'] },
];

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(preText: string): string | null {
  const m = preText.match(/Date\s*:?\.?\s*(\d{1,2})\s*([a-zéû]+)\.?\s*(\d{4})/i);
  if (!m) return null;
  const jour = m[1].padStart(2, '0');
  const moisTxt = m[2].toLowerCase().slice(0, 4).replace('û', 'u');
  const mois = MOIS[moisTxt] || MOIS[moisTxt.slice(0, 3)];
  if (!mois) return null;
  return `${m[3]}-${String(mois).padStart(2, '0')}-${jour}`;
}

function parseAgentEtAgence(preText: string): { agent: string | null; agence: string | null } {
  const norm = normalize(preText);
  for (const r of ROSTER) {
    const candidates = [r.agent, ...r.alias].map(normalize);
    for (const c of candidates) {
      const words = c.split(' ').filter(Boolean);
      const mainWord = words.sort((a, b) => b.length - a.length)[0];
      if (mainWord.length >= 4 && norm.includes(mainWord)) {
        const otherWords = words.filter(w => w !== mainWord && w.length >= 3);
        const confirmed = otherWords.length === 0 || otherWords.some(w => norm.includes(w));
        if (confirmed) return { agent: r.agent, agence: r.agence };
      }
    }
  }
  return { agent: null, agence: null };
}

function parseMontantTotal(postText: string): number | null {
  // Le nombre et son "xOF" sont toujours sur la même ligne dans le texte
  // source. Interdire le saut de ligne évite de fusionner des chiffres
  // provenant de champs différents (n° de page, téléphone, ID transaction).
  const re = /(\d[\d]{0,9}(?:[.,]\d{2,3})?)[ \t]*[x×][oO0Ff][Ff]?\b/gi;
  const counts = new Map<number, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(postText)) !== null) {
    const num = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 100) {
      counts.set(num, (counts.get(num) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: number | null = null;
  let bestCount = 0;
  for (const [val, count] of counts) {
    if (count > bestCount || (count === bestCount && val > (best ?? 0))) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}

// Classification heuristique de l'offre à partir de mots-clés présents dans
// le corps du reçu. Approximatif par nature — l'admin corrige à la relecture.
const OFFRE_KEYWORDS: { test: RegExp; offre: string }[] = [
  { test: /sms\s*affaires/i,                        offre: 'SMS Affaires' },
  { test: /business\s*mobile\s*mix|mobile\s*mix/i,  offre: 'Business Mobile Mix' },
  { test: /community/i,                             offre: 'B2B Kit Community' },
  { test: /internet\s*top\s*?up/i,                  offre: 'Internet TopUp' },
  { test: /flybox|flybox\s*mini/i,                  offre: 'Pack 4G Flybox' },
  { test: /tozed|easybox/i,                         offre: 'Pack 4G EasyBox' },
  { test: /doro|logicom|post[e]?\s*t[ée]l/i,        offre: 'Terminal (poste téléphonique)' },
  { test: /initial\s*in[vy]oice\s*payment/i,        offre: 'Paiement facture initiale' },
  { test: /paiement\s*de\s*facture/i,               offre: 'Paiement de facture' },
  { test: /avoir/i,                                 offre: 'Avoir / Régularisation' },
];

function parseOffre(postText: string): { offre: string; estAvoir: boolean } {
  for (const k of OFFRE_KEYWORDS) {
    if (k.test.test(postText)) {
      return { offre: k.offre, estAvoir: k.offre.startsWith('Avoir') };
    }
  }
  return { offre: 'À préciser', estAvoir: false };
}

export function parseTexteFactures(texte: string): LigneExtraiteOCI[] {
  const matches = [...texte.matchAll(FACTURE_RE)];
  const resultats: LigneExtraiteOCI[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const prevEnd = i > 0 ? matches[i - 1].index! + matches[i - 1][0].length : 0;
    const nextStart = i < matches.length - 1 ? matches[i + 1].index! : texte.length;
    const preText = texte.slice(prevEnd, m.index);
    const postText = texte.slice(m.index! + m[0].length, nextStart);

    const date = parseDate(preText);
    const { agent, agence } = parseAgentEtAgence(preText);
    const montant = parseMontantTotal(postText);
    const { offre, estAvoir } = parseOffre(postText);

    const champsTrouves = [date, agent, montant].filter(v => v !== null).length;
    const confiance = champsTrouves === 3 ? 'haute' : champsTrouves === 2 ? 'moyenne' : 'faible';

    resultats.push({
      nFacture: m[1],
      date,
      agentNom: agent,
      agence,
      offre,
      montant,
      estAvoir,
      confiance,
    });
  }

  return resultats;
}
