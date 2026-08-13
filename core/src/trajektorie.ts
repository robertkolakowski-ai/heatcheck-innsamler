/**
 * TIMESBANEN — hvordan dagen ser ut time for time, og når toppen kommer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVA SOM MANGLET
 *
 *  Innsamlingen har hentet ETT tall per modell per dag: `temperature_2m_max`.
 *  Det er nok til å velge en bøtte, og det er alt som trengs for et marked der
 *  ytterpunktet settes om natta mens ingen ser på.
 *
 *  For dagens maksimum kaster det bort det meste. «26 °C en gang i dag» og
 *  «26 °C klokka 14, og 25,8 klokka 13 og 15» er ulike påstander: den andre
 *  sier NÅR toppen kommer, og dermed hvor lenge det er til den, og dermed om
 *  en observasjon tatt nå ligger foran eller etter kurven.
 *
 *  Uten det tallet kan «timer til forventet maksimum» ikke regnes ut, og da
 *  kan hverken inngangsvinduet eller observasjonsvekten måles.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── AVTRYKKET, OG HVORFOR DET AVGJØR OM DETTE LAR SEG LAGRE ───────────────
 *
 * Én rad per (modell, time, variabel) blir mange tusen rader i døgnet for én
 * by. Det sprenger et gratisnivå på noen måneder.
 *
 * Men en modellkjøring er en HENDELSE, ikke en strøm: verdiene står helt
 * stille mellom kjøringene. `avtrykk` er et fingeravtrykk av selve
 * verdivektoren, og lagringslaget skriver bare når det har ENDRET seg. Da blir
 * det én rad per modellkjøring — noen titalls i døgnet i stedet for tusener.
 *
 * Og bieffekten er den nyttigste delen: tidspunktet den FØRSTE raden med et
 * nytt avtrykk ble sett, avgrenser når modellkjøringen kom. Det er
 * `forecast_initialization_time` som en MÅLING i stedet for et felt vi håper
 * leverandøren oppgir.
 *
 * ── INGEN TOLKNING ────────────────────────────────────────────────────────
 *
 * Filen sier ikke om en bane er god, om toppen er tidlig, eller om noe bør
 * kjøpes. Den finner maksimum, tidspunktet, og hvor langt det er dit.
 * Vurderingen hører hjemme på den andre siden av skillet i `docs/DELING.md`.
 */

import { fingeravtrykk, kanonisk } from "./avtrykk.ts";

/** Ett punkt i en timesserie. `verdi: null` er et hull, ikke en null. */
export interface Timespunkt {
  readonly tidUtc: string;
  readonly verdi: number | null;
}

export interface Bane {
  /** Høyeste verdi i serien. Null når ingen punkter har verdi. */
  readonly maks: number | null;
  /** Timen maksimum står i. Ved likhet vinner den FØRSTE. */
  readonly maksTidUtc: string | null;
  /** Punkter med verdi. */
  readonly antall: number;
  /** Punkter uten verdi — et hull er en opplysning, ikke et fravær. */
  readonly hull: number;
  /**
   * Fingeravtrykk av verdivektoren, med tidene.
   *
   * Tidene MÅ være med. To kjøringer kan gi de samme verdiene forskjøvet en
   * time, og et avtrykk som bare så på tallene ville kalt dem like — altså
   * hoppet over å lagre en modellkjøring som faktisk sa noe nytt.
   */
  readonly avtrykk: string;
}

const TOM: Bane = {
  maks: null, maksTidUtc: null, antall: 0, hull: 0,
  avtrykk: fingeravtrykk(kanonisk([])),
};

/**
 * Les en timesserie.
 *
 * Punkter med ugyldig tidsstempel hoppes over helt: de kan ikke plasseres, og
 * et punkt uten tid er ikke et hull i banen — det er en rad vi ikke vet hva er.
 */
export function lesBane(punkter: readonly Timespunkt[]): Bane {
  if (!punkter.length) return TOM;

  let maks: number | null = null;
  let maksTidUtc: string | null = null;
  let antall = 0;
  let hull = 0;
  const vektor: Array<[string, number | null]> = [];

  for (const p of punkter) {
    const ms = Date.parse(p.tidUtc);
    if (!Number.isFinite(ms)) continue;
    vektor.push([p.tidUtc, p.verdi ?? null]);

    if (p.verdi === null || p.verdi === undefined || !Number.isFinite(p.verdi)) { hull++; continue; }
    antall++;
    if (maks === null || p.verdi > maks) { maks = p.verdi; maksTidUtc = p.tidUtc; }
    else if (p.verdi === maks && maksTidUtc !== null && ms < Date.parse(maksTidUtc)) maksTidUtc = p.tidUtc;
  }

  // Sortert før avtrykk: rekkefølgen svaret kom i er ikke en egenskap ved
  // modellkjøringen, og to like kjøringer skal ikke få ulikt avtrykk fordi
  // leverandøren snudde listen.
  vektor.sort((a, b) => a[0].localeCompare(b[0]));

  return { maks, maksTidUtc, antall, hull, avtrykk: fingeravtrykk(kanonisk(vektor)) };
}

/**
 * Timer fra `nåMs` til maksimum. Negativt når toppen alt er passert.
 *
 * Fortegnet er bevart med vilje. «Toppen kommer om to timer» og «toppen kom
 * for to timer siden» er motsatte tilstander for en beslutning, og en
 * absoluttverdi ville gjort dem like.
 */
export function timerTilMaks(bane: Bane, nåMs: number): number | null {
  if (!bane.maksTidUtc) return null;
  const ms = Date.parse(bane.maksTidUtc);
  if (!Number.isFinite(ms)) return null;
  return (ms - nåMs) / 3_600_000;
}

/**
 * Verdien banen sier vi skal ligge på akkurat nå, interpolert mellom naboene.
 *
 * Brukes til å svare på om observasjonen ligger FORAN eller ETTER kurven —
 * spesifikasjonens «observed temperature above forecast trajectory». Uten
 * interpolasjon ville svaret hoppet hver hele time, og et hopp i referansen
 * ser ut som et hopp i været.
 *
 * Null utenfor seriens ender: å forlenge en bane er en gjetning, og en
 * gjetning som ser ut som en prognose er verre enn ingen verdi.
 */
export function verdiVed(punkter: readonly Timespunkt[], nåMs: number): number | null {
  const gyldige = punkter
    .map((p) => ({ ms: Date.parse(p.tidUtc), verdi: p.verdi }))
    .filter((p): p is { ms: number; verdi: number } =>
      Number.isFinite(p.ms) && typeof p.verdi === "number" && Number.isFinite(p.verdi))
    .sort((a, b) => a.ms - b.ms);

  if (!gyldige.length) return null;
  if (nåMs < gyldige[0].ms || nåMs > gyldige[gyldige.length - 1].ms) return null;

  for (let i = 0; i < gyldige.length - 1; i++) {
    const a = gyldige[i];
    const b = gyldige[i + 1];
    if (nåMs >= a.ms && nåMs <= b.ms) {
      if (b.ms === a.ms) return a.verdi;
      return a.verdi + (b.verdi - a.verdi) * ((nåMs - a.ms) / (b.ms - a.ms));
    }
  }
  return gyldige[gyldige.length - 1].verdi;
}

/**
 * Bygg en serie av Open-Meteos to parallelle lister.
 *
 * `hourly.time` og `hourly.<variabel>` kommer som to lister som skal leses
 * side om side. Er de ulikt lange, er svaret ikke til å stole på, og da er
 * tom serie riktigere enn en serie der halve verdiene er forskjøvet — en
 * forskjøvet bane ser helt normal ut og er systematisk feil.
 */
export function serieFra(
  tider: unknown,
  verdier: unknown,
): Timespunkt[] {
  if (!Array.isArray(tider) || !Array.isArray(verdier)) return [];
  if (tider.length !== verdier.length) return [];

  const ut: Timespunkt[] = [];
  for (let i = 0; i < tider.length; i++) {
    const t = tider[i];
    if (typeof t !== "string" || !t) continue;
    // Open-Meteo skriver «2026-08-10T14:00» uten sone når `timezone` er satt.
    // Uten Z tolkes den som lokal tid av Date.parse, og det er en times feil
    // om sommeren — nok til å flytte maksimum til feil time.
    const tidUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? `${t}:00Z` : t;
    const v = verdier[i];
    ut.push({ tidUtc, verdi: typeof v === "number" && Number.isFinite(v) ? v : null });
  }
  return ut;
}
