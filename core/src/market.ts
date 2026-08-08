/**
 * Markedslaget — rent. Tolker Polymarkets gamma-svar til bøtter og priser.
 * Selve hentingen (og alt som kan feile mot nettet) hører hjemme i fase 3.
 */

export interface Bøtte {
  /** Heltallsgraden bøtta gjelder, tolket fra spørsmålsteksten. */
  readonly grad: number;
  readonly etikett: string;
  /** YES-prisen, 0–1. Polymarket oppgir `outcomes = [Yes, No]`. */
  readonly pris: number;
}

export interface Marked {
  readonly slug: string | null;
  /** Oppslag grad → YES-pris. */
  readonly bøtter: Readonly<Record<number, number>>;
  /** Alle bøtter, sortert stigende på grad. */
  readonly alle: readonly Bøtte[];
}

/** Alle sifferblokker i en streng: "18°C or below" → [18] */
function tall(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map(Number);
}

/**
 * Heltallsgraden en bøtteetikett gjelder — det FØRSTE tallet i etiketten.
 *
 * «17°C» → 17 · «14°C or below» → 14 · «18-19°C» → 18 · «varmt» → null
 *
 * Regelen sto inne i `lesMarked` og trengtes så et sted til: snapshot-filene
 * lagrer etiketten og prisen, ikke graden, så den som leser dem må tolke det
 * samme. To kopier av «hvilken grad er dette» er nøyaktig den feiltypen
 * prosjektet har blitt brent av før — de glir fra hverandre, og ingenting blir
 * rødt av det.
 */
export function gradFor(etikett: string): number | null {
  const n = tall(etikett);
  return n.length ? n[0] : null;
}

/**
 * Tolker ett event fra `gamma-api.polymarket.com/events`.
 *
 * Tomt eller uventet svar gir null i stedet for kast — markedet er rutinemessig
 * ikke åpnet ennå når vi kjører 24 t før natten, og det er ikke en feil.
 */
export function lesMarked(svar: unknown): Marked | null {
  const liste = Array.isArray(svar) ? svar : null;
  if (!liste?.length) return null;
  const event = liste[0] as { slug?: string; markets?: unknown[] };
  const markeder = Array.isArray(event.markets) ? event.markets : [];

  const bøtter: Record<number, number> = {};
  const alle: Bøtte[] = [];

  for (const m of markeder as Array<Record<string, unknown>>) {
    const etikett = String(m.groupItemTitle ?? m.question ?? "");
    const grad = gradFor(etikett);
    if (grad == null) continue;

    let priser: unknown = m.outcomePrices;
    if (typeof priser === "string") {
      try { priser = JSON.parse(priser); } catch { priser = []; }
    }
    const yes = Array.isArray(priser) && priser.length ? Number.parseFloat(String(priser[0])) : 0;
    const pris = Number.isFinite(yes) ? yes : 0;

    bøtter[grad] = pris;
    alle.push({ grad, etikett, pris });
  }

  if (!alle.length) return null;
  alle.sort((a, b) => a.grad - b.grad);
  return { slug: event.slug ?? null, bøtter, alle };
}

// ── hele bøttesettet, med grenser og ordrebok-topp (B04) ───────────────────
//
// `lesMarked` over er Temp-Traders syn på markedet: grad → YES-pris, som er
// alt beslutningen der trenger. Snapshot-loggingen trenger mer — grensene for
// hver bøtte, og både ask og bid — fordi det er dét en historisk pris ER.
// Uten grensene kan en fremtidig analyse ikke vite hva bøtta dekket; uten
// spreaden kan den ikke vite hva en handel faktisk hadde kostet.
//
// Grensene tolkes som halvåpne intervaller [lav, høy), med et halvt grad
// slingringsmonn i hver ende — nøyaktig som `parseBucket` i temp-bets.html,
// og holdt der av en paritetstest.

export interface FullBøtte {
  readonly etikett: string;
  /** null = åpen ende («below 18°C» har ingen nedre grense). */
  readonly lav: number | null;
  readonly høy: number | null;
  /** Kjøp Yes. */
  readonly ask: number | null;
  /** Selg Yes — No-siden koster 1 − bid. */
  readonly bid: number | null;
  /** Midtpris fra `outcomePrices`, det gamma oppgir som «prisen». */
  readonly mid: number | null;
  /**
   * CLOB-tokenet for Yes-siden av denne bøtta, null når gamma ikke oppgir det.
   *
   * Uten dette kan en beslutning ikke rutes til et marked: `trader/trader.js`
   * kjøper et *token*, ikke en etikett. Nettleseren har lest feltet siden
   * ordreboken kom inn (`temp-bets.html`, `marketBuckets`); Node-siden har ikke,
   * og det er hele grunnen til at A1 sto igjen.
   */
  readonly yesToken: string | null;
  /** Samme for No-siden. Å kjøpe No er å kjøpe No-tokenet. */
  readonly noToken: string | null;
}

export interface FullMarked {
  readonly slug: string | null;
  readonly enhet: "celsius" | "fahrenheit";
  readonly bøtter: readonly FullBøtte[];
}

/**
 * Grensene for én bøtteetikett.
 *
 * «below 18°C» → [null, 18.5)   ·  «22°C or above» → [21.5, null)
 * «18-19°C»    → [17.5, 19.5)   ·  «20°C»          → [19.5, 20.5)
 */
export function tolkGrenser(etikett: string): { lav: number | null; høy: number | null } {
  const n = tall(etikett);
  const l = etikett.toLowerCase();
  if (l.includes("below") && n.length) return { lav: null, høy: n[0] + 0.5 };
  if ((l.includes("higher") || l.includes("above")) && n.length) return { lav: n[0] - 0.5, høy: null };
  if (n.length >= 2) return { lav: n[0] - 0.5, høy: n[1] + 0.5 };
  if (n.length === 1) return { lav: n[0] - 0.5, høy: n[0] + 0.5 };
  return { lav: null, høy: null };
}

function tallEller(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** gamma sender lister som JSON-strenger like ofte som som lister. */
function liste(v: unknown): unknown[] {
  if (typeof v === "string") {
    try { return JSON.parse(v) as unknown[]; } catch { return []; }
  }
  return Array.isArray(v) ? v : [];
}

/**
 * Tokenene for én bøtte, tolket som nettleseren gjør det.
 *
 * Oppslaget er på navn og ikke på posisjon, fordi rekkefølgen i `outcomes`
 * ikke er lovet noe sted. Den posisjonelle reserven `[Yes, No]` brukes bare når
 * navnet ikke finnes, og bare for et par — den er en gjetning, og en gjetning
 * over to elementer er den eneste som er trygg.
 *
 * Ulik lengde på `outcomes` og `clobTokenIds` gir null for begge. Et token
 * plukket fra en liste som ikke stemmer overens ville pekt på feil marked, og
 * en ordre mot feil token er verre enn ingen ordre.
 */
function tokener(m: Record<string, unknown>): { yesToken: string | null; noToken: string | null } {
  const utfall = liste(m.outcomes);
  const toks = liste(m.clobTokenIds);
  if (!utfall.length || utfall.length !== toks.length) return { yesToken: null, noToken: null };

  const finn = (navn: string, reserve: number): string | null => {
    const i = utfall.findIndex((o) => String(o).toLowerCase() === navn);
    const t = i >= 0 ? toks[i] : (toks.length === 2 ? toks[reserve] : null);
    return t == null || t === "" ? null : String(t);
  };
  return { yesToken: finn("yes", 0), noToken: finn("no", 1) };
}

/** Hele bøttesettet med grenser, ask og bid. Null når eventet er tomt. */
export function lesFulltMarked(svar: unknown): FullMarked | null {
  const liste = Array.isArray(svar) ? svar : null;
  if (!liste?.length) return null;
  const event = liste[0] as { slug?: string; markets?: unknown[] };
  const markeder = Array.isArray(event.markets) ? event.markets : [];

  let enhet: "celsius" | "fahrenheit" = "fahrenheit";
  const bøtter: FullBøtte[] = [];

  for (const m of markeder as Array<Record<string, unknown>>) {
    const etikett = String(m.groupItemTitle ?? m.question ?? "");
    if (etikett.includes("°C")) enhet = "celsius";

    let priser: unknown = m.outcomePrices;
    if (typeof priser === "string") {
      try { priser = JSON.parse(priser); } catch { priser = []; }
    }
    const mid = Array.isArray(priser) && priser.length ? tallEller(priser[0]) : null;

    const { lav, høy } = tolkGrenser(etikett);
    const { yesToken, noToken } = tokener(m);
    bøtter.push({
      etikett, lav, høy,
      ask: tallEller(m.bestAsk), bid: tallEller(m.bestBid), mid,
      yesToken, noToken,
    });
  }

  if (!bøtter.length) return null;
  // Samme sortering som nettleseren: stigende på nedre grense, med den åpne
  // nedre enden først.
  bøtter.sort((a, b) => (a.lav ?? -Infinity) - (b.lav ?? -Infinity));
  return { slug: event.slug ?? null, enhet, bøtter };
}

/**
 * Samlet kjøpspris for anbefalingen — én eller to bøtter. Null hvis én av dem
 * ikke er priset: da har vi ingen handel, bare et flagg.
 *
 * Tom liste gir også null. En sum over ingenting er 0, og en pris på 0 ville
 * blitt lest som «gratis handel» i stedet for «ingen handel».
 */
export function kombinertPris(marked: Marked, bøtter: readonly number[]): number | null {
  if (!bøtter.length) return null;
  let sum = 0;
  for (const b of bøtter) {
    const pris = marked.bøtter[b];
    if (pris == null) return null;
    sum += pris;
  }
  return sum;
}

/**
 * Markedets to dyreste bøtter — altså hva markedet selv tror på.
 * Grunnlaget for «enig/uenig med marked» (byggeplanens punkt 8).
 */
export function markedetsFavoritter(marked: Marked): number[] {
  return [...marked.alle]
    .sort((a, b) => (b.pris - a.pris) || (a.grad - b.grad))
    .slice(0, 2)
    .map((b) => b.grad)
    .sort((a, b) => a - b);
}
