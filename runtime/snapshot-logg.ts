#!/usr/bin/env node --experimental-strip-types
/**
 * SNAPSHOT-LOGGEREN (B04) — den som gjør at data i det hele tatt finnes.
 *
 * Hver time: for alle 21 byene og begge markedstypene, skriv ned hva hver
 * modell sa om dagen framover, og hva hver bøtte kostet. Append-only.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVORFOR DENNE HASTER MER ENN ALT ANNET I BACKLOGEN
 *
 *  MET gir ikke ut gamle varsler. Gamma gir ikke ut gamle priser. Alt annet i
 *  backlogen — kalibreringen (B05), inngangstidspunktet (B06), den prediktive
 *  fordelingen (B01) — kan bygges når som helst. Dataene de trenger kan bare
 *  samles i sanntid, og en time som ikke ble lagret er borte for godt.
 *
 *  Derfor er dette den ene oppgaven der ventetid er den eneste kostnaden som
 *  ikke kan hentes inn igjen senere.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  TO SKRIVEMÅL, MED ULIK ROLLE
 *
 *  · POSTGRES er målet. Full oppløsning: hver modell, hver bøtte, hver time.
 *    Krever nøklene i `docs/SUPABASE.md`.
 *
 *  · FILEN er en nødbro, og med vilje MINDRE. Uten nøkler skrives bare
 *    ensemble-medianen per by og markedets midtpriser — ikke per modell. Full
 *    oppløsning i git ville vært ~150 MB i året; den reduserte er ~2 % av det,
 *    og den beholder nettopp det B05 og B06 trenger for å komme i gang.
 *    Å skrive alt til fil ville gjort repoet ubrukelig i løpet av noen måneder,
 *    og å skrive ingenting ville betydd at klokka ikke startet før noen fikk
 *    klikket seg gjennom Supabase.
 *
 *  Er nøklene satt, skrives BEGGE. Filen er da en billig andrekopi, og
 *  kostnaden er kjent og liten.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HVORFOR JOBBEN HAR FLERE TIDSPUNKT ENN DEN TRENGER
 *
 *  Målt 31. juli: cron sto på to tidspunkt i timen, og jobben kjørte tre
 *  ganger på seks og en halv time. GitHub Actions FORSINKER ikke en planlagt
 *  kjøring som ikke får plass — den HOPPER OVER den, og sier det ikke.
 *
 *  Svaret er det parallell-loggen allerede bruker: be om flere tidspunkt enn
 *  du trenger, og kast de overflødige SELV — før nettverkskallene, så
 *  ekstra-tidspunktene ikke firedobler trafikken mot Open-Meteo og Gamma.
 *  `--minst-minutter` er den vakten.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Kjør:
 *   node --experimental-strip-types runtime/snapshot-logg.ts
 *        [--dager N] [--byer a,b] [--tørr] [--bare-base] [--bare-fil]
 *        [--minst-minutter N]
 *     --dager           hvor mange dager fram, inkl. i dag. Standard 2.
 *     --byer            bare disse byslugene. Standard alle.
 *     --tørr            hent og regn, men skriv ingenting
 *     --bare-base       ikke skriv fil
 *     --bare-fil        ikke skriv til Postgres
 *     --minst-minutter  gjør ingenting hvis forrige runde er nyere enn dette.
 *                       Utelatt: hent alltid.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hentRunde, type Runde } from "./snapshots.ts";
import { ENSEMBLE_NØKLER } from "../core/src/observasjon.ts";
// FRA `base-snapshots.ts`, IKKE `base.ts` — med vilje, av samme grunn som
// importen av `observasjon.ts` over. `base.ts` bærer skjemaet for
// prediksjoner, fasit og skyggeordrer; ingenting av det hører hjemme der
// denne jobben kan komme til å kjøre. Se `docs/DELING.md`.
import {
  lesOppsett, skrivKjøringer, skrivPrisSnapshots, skrivPrognoseSnapshots,
  type KjøringSnapshot, type PrisSnapshot, type PrognoseSnapshot,
} from "./base-snapshots.ts";
import type { HentOpsjoner } from "./hent.ts";

const ROT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAPPE = join(ROT, "data", "snapshots");

function arg(navn: string): string | null {
  const i = process.argv.indexOf(`--${navn}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : null;
}
const flagg = (navn: string) => process.argv.includes(`--${navn}`);

/** ISO-dato N dager fram i UTC. */
export function isoOm(nåMs: number, dager: number): string {
  return new Date(nåMs + dager * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Den reduserte raden som går i fil.
 *
 * Én linje per by, markedstype og måldato — ikke én per modell og bøtte. Det
 * er forskjellen på ~90 KB og ~4 MB i døgnet, og den koster bare noe hvis man
 * senere vil kalibrere per modell fra filen. Postgres har den detaljen.
 */
export interface FilRad {
  t: string;              // hentetidspunkt
  d: string;              // måldato
  by: string;
  type: string;
  /** Ensemble-medianen i celsius — tallet beslutningen hviler på. */
  med: number | null;
  /**
   * Ensemble-snittet, samme utvalg og samme avrunding som medianen.
   *
   * Kryssjekken: spriker de to, er utvalget skjevt på en måte medianen alene
   * ikke viser. Den regnes av modellverdiene i øyeblikket, og en lagret runde
   * uten snitt kan ikke gjenskape den i ettertid. Filen er den REDUSERTE
   * formen; per modell ligger bare i Postgres, så uten dette feltet er tallet
   * borte for godt.
   *
   * Mangler på rader skrevet før 1. august 2026. Det er derfor `undefined` er
   * lovlig her og ikke bare `null`: en gammel rad sier ikke «snittet var
   * ukjent», den sier «her ble det ikke skrevet ned».
   */
  snitt?: number | null;
  /**
   * Antall ENSEMBLE-modeller bak `med` og `snitt`. Et tall som hviler på fire
   * er ikke som ni.
   *
   * Talte alle kildene som svarte fram til 7. august 2026, altså opptil tolv:
   * de ni pluss de tre høyoppløselige. Da regnet også utledningene over tolv,
   * så tallet var i det minste sant om sitt eget grunnlag. Nå regner de over
   * de ni (se `ensembleVerdier` i `snapshots.ts`), og et `n` på tolv ville
   * beskrevet et utvalg medianen ikke lenger bruker.
   *
   * Rader skrevet før den datoen bærer derfor et annet mål enn rader skrevet
   * etter. Skillet er datoen, og det er ikke utledbart fra raden selv.
   */
  n: number;
  enhet: string | null;
  /** [etikett, midtpris] per bøtte. Ask og bid ligger i basen. */
  p: Array<[string, number | null]>;
}

/** Nøklene `n` teller. Et sett og ikke en liste — `reduser` slår opp per rad. */
const ENSEMBLE = new Set<string>(ENSEMBLE_NØKLER);

/** Trekk den reduserte formen ut av den fulle runden. */
export function reduser(runde: Runde): FilRad[] {
  const ut = new Map<string, FilRad>();
  const nøkkel = (by: string, type: string, d: string) => `${by}|${type}|${d}`;

  for (const p of runde.prognoser) {
    const k = nøkkel(p.city, p.market_type, p.target_date);
    if (!ut.has(k)) {
      ut.set(k, { t: p.fetched_at, d: p.target_date, by: p.city, type: p.market_type,
                  med: null, snitt: null, n: 0, enhet: null, p: [] });
    }
    const rad = ut.get(k)!;
    // De to ensemble-radene er UTLEDNINGER, ikke kilder. Telles de som
    // modeller, blir `n` to for høy — og «hvor mange modeller står bak dette
    // tallet» er nettopp spørsmålet feltet finnes for å svare på.
    //
    // Av samme grunn telles bare de ni: en hires-rad er en kilde vi lagrer,
    // men ikke en stemme medianen hørte på.
    if (p.source === "ensemble_median") rad.med = p.value;
    else if (p.source === "ensemble_mean") rad.snitt = p.value;
    else if (p.value != null && ENSEMBLE.has(p.source)) rad.n++;
  }

  for (const pr of runde.priser) {
    const k = nøkkel(pr.city, pr.market_type, pr.target_date);
    if (!ut.has(k)) {
      ut.set(k, { t: pr.fetched_at, d: pr.target_date, by: pr.city, type: pr.market_type,
                  med: null, snitt: null, n: 0, enhet: null, p: [] });
    }
    const rad = ut.get(k)!;
    rad.enhet = pr.unit;
    rad.p.push([pr.bucket_label, pr.yes_mid]);
  }

  // Runder uten noe som helst skal ikke etterlate tomme linjer.
  return [...ut.values()].filter((r) => r.med != null || r.p.length);
}

/**
 * Én fil per døgn, NDJSON. Append-only på disk også — en linje legges til, og
 * ingenting som står der fra før leses eller skrives om.
 */
export function filFor(stempel: string): string {
  return join(MAPPE, `${stempel.slice(0, 10)}.ndjson`);
}

/**
 * Når ble det sist skrevet en snapshot-runde?
 *
 * Leses av dagsfilen, ikke av basen: filen skrives ALLTID (med mindre
 * `--bare-base`), den ligger på disken jobben allerede har sjekket ut, og å
 * spørre Postgres først ville lagt et nettverkskall foran vakten som finnes
 * for å unngå nettverkskall.
 *
 * `null` betyr «vet ikke» — ingen fil, tom fil, eller bare ulesbare linjer.
 * Alle tre skal føre til at vi HENTER. En vakt som blokkerer fordi den ikke
 * fikk lest noe, er en vakt som stille slutter å samle data.
 */
export function sisteHenting(innhold: string | null): number | null {
  if (!innhold) return null;
  let nyeste: number | null = null;
  for (const linje of innhold.split("\n")) {
    if (!linje.trim()) continue;
    let t: unknown;
    try { t = (JSON.parse(linje) as { t?: unknown }).t; } catch { continue; }
    const ms = typeof t === "string" ? Date.parse(t) : NaN;
    if (Number.isFinite(ms) && (nyeste == null || ms > nyeste)) nyeste = ms;
  }
  return nyeste;
}

/**
 * Skal denne kjøringen hente, eller er den et av de overflødige tidspunktene?
 *
 * Samme form og samme regler som `skalLogge` i parallell-logg.ts, med vilje:
 * to jobber som løser det samme problemet på to måter er to jobber man må
 * huske forskjellen på.
 */
export function skalHente(
  sisteMs: number | null,
  nåMs: number,
  minstMinutter: number | null,
): { readonly hent: true } | { readonly hent: false; readonly grunn: string } {
  if (minstMinutter == null) return { hent: true };
  if (sisteMs == null) return { hent: true };

  const alder = (nåMs - sisteMs) / 60_000;
  // En framtidig tidsstempel (klokkeskrew, eller en fil fra en annen sone)
  // gir negativ alder. Da vet vi ikke, og da henter vi.
  if (!Number.isFinite(alder) || alder < 0) return { hent: true };
  if (alder >= minstMinutter) return { hent: true };

  return {
    hent: false,
    grunn: `forrige runde er ${alder.toFixed(0)} min gammel (grensen er ` +
      `${minstMinutter}). Hopper over — neste tidspunkt tar den.`,
  };
}

async function main(): Promise<void> {
  const nåMs = Date.now();
  const dager = Math.max(1, Math.min(7, Number(arg("dager") ?? 2)));
  const byer = arg("byer")?.split(",").map((s) => s.trim()).filter(Boolean);
  const tørr = flagg("tørr");

  // ── vakten, FØR nettverket ───────────────────────────────────────────────
  // Rekkefølgen er hele poenget: kastes de overflødige tidspunktene etter
  // hentingen, har de allerede kostet 21 byer × 2 markedstyper i trafikk.
  const minstRå = arg("minst-minutter");
  const minstMinutter = minstRå == null ? null : Number(minstRå);
  if (minstMinutter != null && !Number.isFinite(minstMinutter)) {
    console.error(`[snapshots] --minst-minutter «${minstRå}» er ikke et tall.`);
    process.exitCode = 2;
    return;
  }
  if (minstMinutter != null) {
    const sti = filFor(new Date(nåMs).toISOString());
    const innhold = existsSync(sti) ? readFileSync(sti, "utf8") : null;
    const vakt = skalHente(sisteHenting(innhold), nåMs, minstMinutter);
    if (!vakt.hent) {
      console.log(`[snapshots] ${vakt.grunn}`);
      return;
    }
  }

  const opt: HentOpsjoner = { fetcher: fetch, nåMs, forsøk: 3, timeoutMs: 20_000 };

  const runder: Runde[] = [];
  for (let i = 0; i < dager; i++) {
    const iso = isoOm(nåMs, i);
    console.log(`[snapshots] henter ${iso}${byer ? ` (${byer.length} byer)` : ""}…`);
    runder.push(await hentRunde(opt, { iso, byer }));
  }

  const prognoser: PrognoseSnapshot[] = runder.flatMap((r) => [...r.prognoser]);
  const priser: PrisSnapshot[] = runder.flatMap((r) => [...r.priser]);
  const kjøringer: KjøringSnapshot[] = runder.flatMap((r) => [...r.kjøringer]);
  const notater = runder.flatMap((r) => [...r.notater]);

  const medMarked = notater.filter((n) => n.marked === "ok").length;
  const tomme = notater.filter((n) => n.marked === "tomt").length;
  const feilet = notater.filter((n) => n.marked === "feil").length;
  console.log(`[snapshots] ${prognoser.length} prognoserader · ${priser.length} prisrader` +
              (kjøringer.length ? ` · ${kjøringer.length} timesbaner` : ""));
  console.log(`[snapshots] marked: ${medMarked} notert · ${tomme} ikke notert · ${feilet} feilet`);
  // «Ikke notert» er normalt: lowest finnes bare for London, og highest listes
  // typisk 1–2 dager fram. «Feilet» er det ikke, og skal skille seg ut.
  if (feilet) {
    console.log(`[snapshots] feilet: ` +
      notater.filter((n) => n.marked === "feil").map((n) => `${n.by}/${n.type}`).join(", "));
  }

  if (tørr) {
    console.log("[snapshots] --tørr: skriver ingenting.");
    return;
  }

  // ── fil ──────────────────────────────────────────────────────────────────
  let skrevetFil = 0;
  if (!flagg("bare-base")) {
    const rader = runder.flatMap(reduser);
    if (rader.length) {
      if (!existsSync(MAPPE)) mkdirSync(MAPPE, { recursive: true });
      const sti = filFor(rader[0].t);
      appendFileSync(sti, rader.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      skrevetFil = rader.length;
      console.log(`[snapshots] fil: ${skrevetFil} linjer → ${sti.replace(ROT + "/", "")}`);
    }
  }

  // ── base ─────────────────────────────────────────────────────────────────
  if (flagg("bare-fil")) return;
  const oppsett = lesOppsett(process.env);
  if (oppsett.status === "mangler") {
    console.log(`[snapshots] Postgres hoppet over — mangler ${oppsett.navn.join(" og ")}.`);
    console.log(`[snapshots] Filen har den reduserte formen. FULL oppløsning ` +
      `(per modell, ask/bid per bøtte) skrives først når nøklene finnes — se docs/SUPABASE.md.`);
    return;
  }
  if (oppsett.status === "ugyldig") {
    console.error(`[snapshots] Postgres-oppsettet er feil: ${oppsett.grunn}`);
    process.exitCode = 1;
    return;
  }

  // Filen er skrevet først med vilje. Feiler basen, ligger den reduserte
  // formen trygt, og jobben blir ikke rød for en tapt Postgres-runde alene.
  const a = await skrivPrognoseSnapshots(prognoser, oppsett.oppsett, opt);
  const b = await skrivPrisSnapshots(priser, oppsett.oppsett, opt);
  // Timesbanene skrives bare når det finnes noen. En tom skriving ville
  // meldt «kjøringer skrevet» på en runde der ingen bane ble hentet, og det
  // er nettopp forskjellen mellom «hentet ingenting» og «hentet ikke».
  const c = kjøringer.length ? await skrivKjøringer(kjøringer, oppsett.oppsett, opt) : null;

  const skrivinger: Array<readonly [string, typeof a]> = [["prognoser", a], ["priser", b]];
  if (c) skrivinger.push(["timesbaner", c]);

  for (const [navn, svar] of skrivinger) {
    if (svar.utfall === "ok") console.log(`[snapshots] base: ${navn} skrevet.`);
    else {
      console.error(`[snapshots] base: ${navn} FEILET — ${"grunn" in svar ? svar.grunn : svar.utfall}`);
      process.exitCode = 1;
    }
  }
}

// Kjøres den som skript, kjør. Importeres den fra en test, gjør ingenting.
if (process.argv[1] && process.argv[1].endsWith("snapshot-logg.ts")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
