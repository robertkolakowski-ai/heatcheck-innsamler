/**
 * SNAPSHOT-LAGET (B04) — treningsdataen, hentet og formet.
 *
 * Én runde = for hver by og hver markedstype: hva sa hver modell om denne
 * dagen, og hva kostet hver bøtte, akkurat nå. Det er alt. Ingen beslutning
 * tas her, ingen median regnes ut som noe annet enn en kilde blant kildene.
 *
 * HVORFOR DETTE ER SKILT FRA `kjor.ts`
 * `kjor.ts` er Temp-Trader: én by, ett marked, én beslutning, og et rikt
 * radformat som speiler den beslutningen. Denne filen har motsatt formål — den
 * skal lagre RÅSTOFF, i en form som ikke antar hva det senere skal brukes til.
 * Blandes de to, begynner snapshot-formen å arve beslutningens antakelser, og
 * da er den ikke lenger råstoff.
 *
 * ENHET
 * Prognoser hentes ALLTID i celsius, uansett hva markedet viser. Bøttegrensene
 * står i markedets egen enhet, fordi det er der de er definert. Se
 * enhetsavsnittet i `db/schema.sql` — dette er den ene detaljen som er lett å
 * ta feil av og vanskelig å oppdage etterpå.
 *
 * TOMT MARKED ER IKKE EN FEIL
 * `lowest`-markedet finnes i dag bare for London, og `highest` er rutinemessig
 * ikke notert ennå to dager fram. Begge deler registreres som «tomt», ikke som
 * «feil». Skulle de sett like ut i historikken, ville en fremtidig analyse
 * ikke kunne skille «markedet var tynt» fra «markedet fantes ikke».
 */

import { BYER, MARKEDSTYPER, byslug, type Markedstype } from "../core/src/byer.ts";
// FRA `observasjon.ts`, IKKE `models.ts` — med vilje. Innsamleren skal kunne
// kjøre uten beslutningsregelen i bagasjen, og denne importlinja er stedet den
// påstanden enten holder eller ryker. Trenger du noe herfra som bare finnes i
// `models.ts`, er det et signal om at innsamleren har begynt å beslutte.
// Se `docs/DELING.md`.
import { ALLE_NØKLER, ENSEMBLE_NØKLER } from "../core/src/observasjon.ts";
import { lesFulltMarked, type FullMarked } from "../core/src/market.ts";
import type { PrisSnapshot, PrognoseSnapshot } from "./base-snapshots.ts";
import { Buffer, hentJson, medTak, type HentOpsjoner } from "./hent.ts";

const OM = "https://api.open-meteo.com/v1/forecast";
const GAMMA = "https://gamma-api.polymarket.com/events";

/** Samtidige spørringer. Open-Meteo og Gamma har begge en grense. */
const TAK = 4;

/** `highest` leser dagens maks, `lowest` nattens minimum. */
export function feltFor(type: Markedstype): "temperature_2m_max" | "temperature_2m_min" {
  return type === "highest" ? "temperature_2m_max" : "temperature_2m_min";
}

/**
 * Alle modellene for én by og én dag, i ett kall.
 *
 * Merk forskjellen fra `kilder.ts:hentMinima`, som spør om én modell om gangen.
 * Der er grunnen at et bomskudd på én modell ikke skal etterlate hull i en
 * BESLUTNING. Her er formålet lagring: et hull er en opplysning i seg selv, og
 * `null` for en modell er en rad vi vil ha.
 */
export function urlPrognose(lat: number, lon: number, iso: string, type: Markedstype): string {
  return `${OM}?latitude=${lat}&longitude=${lon}`
    + `&start_date=${iso}&end_date=${iso}&daily=${feltFor(type)}`
    + `&temperature_unit=celsius&timezone=auto&models=${ALLE_NØKLER.join(",")}`;
}

export function urlMarked(by: string, type: Markedstype, iso: string): string {
  return `${GAMMA}?closed=false&limit=3&slug=${byslug(by, type, iso)}`;
}

/** Én verdi per modellnøkkel, med null for de som ikke svarte. */
export function lesPrognose(data: unknown, type: Markedstype): Record<string, number | null> {
  const daily = (data as { daily?: Record<string, unknown> } | null)?.daily ?? {};
  const ut: Record<string, number | null> = {};
  for (const n of ALLE_NØKLER) {
    const serie = daily[`${feltFor(type)}_${n}`];
    const v = Array.isArray(serie) && serie.length ? serie[0] : null;
    ut[n] = typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  }
  return ut;
}

/**
 * De NI ensemble-verdiene som faktisk kom — utvalget de to utledningene hviler på.
 *
 * ── HVORFOR DETTE IKKE ER ALLE TOLV ───────────────────────────────────────
 *
 * `lesPrognose` leverer én verdi per nøkkel i `ALLE_NØKLER`, altså de ni
 * ensemble-modellene PLUSS de tre høyoppløselige. Fram til 7. august 2026
 * regnet `ensemble_median` og `ensemble_mean` over hele det settet. Det var
 * feil, og feilen var stille på nøyaktig den måten som er verst: medianen
 * tåler tre ekstra verdier uten å flytte seg, så tallene så riktige ut de
 * fleste dagene, og skilte lag først når det gjaldt.
 *
 * Tre ting brast samtidig:
 *
 *   · NAVNET LØY. `Weathermarket/api/london-stats.js` sier i klartekst at de
 *     to radene er utledninger av de ni, og tabellen har hele tiden vist et
 *     tolv-modells tall under overskriften «Ensemble-median».
 *   · FASITEN MÅLTE FEIL TING. Etterprøvingen tok median, snitt og antall rett
 *     fra disse radene, og scoret dermed en estimator ingen har handlet på.
 *   · NEDSTRØMS BLE DEN BRUKT. `Markedsdel.verdier` under gikk samme vei.
 *
 * Målt på arkivet, med samme etterbehandling lagt på begge: ni-modells
 * medianen traff blinken merkbart oftere enn tolv-modells, og tolv var
 * samtidig mer skråsikker — altså både modigere og dårligere. De
 * høyoppløselige er de svakeste i settet og har dokumentert varm bias; se
 * `HIRES` i `observasjon.ts`. Tallene bak dette står i `models.ts`.
 *
 * De tolv per-modell-radene skrives fortsatt, uendret. Det er råstoffet, og
 * det skal ikke tynnes ut — det er nettopp derfor et tolv-modells snitt kan
 * regnes ut igjen når som helst, av den som vil ha det.
 */
function ensembleVerdier(verdier: Record<string, number | null>): number[] {
  const ut: number[] = [];
  for (const k of ENSEMBLE_NØKLER) {
    const v = verdier[k];
    if (typeof v === "number" && Number.isFinite(v)) ut.push(v);
  }
  return ut;
}

/** Median av verdiene som faktisk finnes. Null hvis ingen gjorde det. */
export function median(vs: readonly number[]): number | null {
  if (!vs.length) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 10) / 10;
}

/**
 * Snittet av de samme verdiene. Samme avrunding som medianen.
 *
 * Medianen er tallet som brukes videre; snittet er kryssjekken. Spriker de to,
 * er utvalget skjevt på en måte medianen alene ikke viser.
 *
 * Snittet MÅ lagres i samme runde. Kryssjekken regnes av modellverdiene i det
 * øyeblikket, og en lagret runde uten snitt kan ikke gjenskape den i ettertid —
 * per-modell-verdiene finnes bare i Postgres.
 */
export function snitt(vs: readonly number[]): number | null {
  if (!vs.length) return null;
  return Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10;
}

/**
 * Markedet og modellverdiene for én (by, type), slik de var FØR utflatingen.
 *
 * `prognoser` og `priser` er flate rader bygget for basen, og de har mistet to
 * ting på veien: hvilke verdier som hørte sammen (altså spredningen) og
 * bøttesettet som ett objekt. Snapshot-loggingen trenger ikke noe av det.
 * Kandidatbyggingen (A1) trenger begge, og hentet dem ellers en gang til.
 *
 * Derfor bæres de med i stedet. Feltet er additivt: `snapshot-logg.ts` leser
 * bare `prognoser`, `priser` og `notater`, og merker ingen forskjell.
 */
export interface Markedsdel {
  readonly by: string;
  readonly type: Markedstype;
  readonly målDato: string;
  /** Null når markedet ikke var notert ennå — rutine, ikke feil. */
  readonly fullt: FullMarked | null;
  /** Modellverdiene som faktisk kom, uten null-radene. Grunnlag for spredning. */
  readonly verdier: readonly number[];
}

export interface Runde {
  readonly prognoser: readonly PrognoseSnapshot[];
  readonly priser: readonly PrisSnapshot[];
  /** Per (by, type): hva som skjedde. Til logglinja, ikke til basen. */
  readonly notater: ReadonlyArray<{
    by: string; type: Markedstype; modeller: number; bøtter: number;
    marked: "ok" | "tomt" | "feil";
  }>;
  /** Råmaterialet A1 trenger. Ingen ekstra nettverkskall. */
  readonly markeder: readonly Markedsdel[];
}

export interface RundeOpsjoner {
  /** Måldatoen, ISO. Én dag per runde — kall flere ganger for flere. */
  readonly iso: string;
  /** Hvilke byer. Standard er alle. */
  readonly byer?: readonly string[];
  readonly typer?: readonly Markedstype[];
}

/**
 * Hent én runde.
 *
 * `fetched_at` settes ÉN gang for hele runden, ikke per kall. Radene skal kunne
 * grupperes som «samme observasjonstidspunkt» — spres stemplene utover de
 * sekundene rundene tar, blir en enkel `group by fetched_at` til en sortering
 * på tilfeldig rekkefølge.
 */
export async function hentRunde(opt: HentOpsjoner, r: RundeOpsjoner): Promise<Runde> {
  const stempel = new Date(opt.nåMs).toISOString();
  const buffer = new Buffer();
  const byer = r.byer ? BYER.filter((b) => r.byer!.includes(b.slug)) : BYER;
  const typer = r.typer ?? MARKEDSTYPER;

  const jobber = byer.flatMap((b) => typer.map((t) => ({ by: b, type: t })));

  const deler = await medTak(jobber, TAK, async ({ by, type }) => {
    // `hentJson` setter selv nettleser-UA-en gamma krever, og eier retry,
    // timeout og buffer. Ingenting av det gjentas her.
    const [pSvar, mSvar] = await Promise.all([
      hentJson(urlPrognose(by.lat, by.lon, r.iso, type), opt, tomPrognose, buffer),
      hentJson(urlMarked(by.slug, type, r.iso), opt, tomtMarked, buffer),
    ]);

    const prognoser: PrognoseSnapshot[] = [];
    const priser: PrisSnapshot[] = [];
    let modellverdier: number[] = [];
    let fulltMarked: FullMarked | null = null;

    // ── prognosene ─────────────────────────────────────────────────────────
    let antallModeller = 0;
    if (pSvar.utfall === "ok") {
      const verdier = lesPrognose(pSvar.data, type);
      // De ni, ikke de tolv — se `ensembleVerdier`. `modellverdier` blir til
      // `Markedsdel.verdier`, som `kandidater.ts` gjør om til senter og
      // spredning for skyggeboka. Det settet må være det samme settet
      // beslutningen bruker, ellers handler skyggen på et annet ensemble enn
      // appen anbefaler.
      modellverdier = ensembleVerdier(verdier);
      for (const [kilde, value] of Object.entries(verdier)) {
        if (value != null) antallModeller++;
        // Også null-radene skrives. En modell som ikke svarte er en
        // opplysning: uten raden ser det senere ut som om vi aldri spurte.
        prognoser.push({ source: kilde, city: by.slug, market_type: type,
                         target_date: r.iso, fetched_at: stempel, value, unit: "celsius" });
      }
      const gyldige = ensembleVerdier(verdier);
      prognoser.push({ source: "ensemble_median", city: by.slug, market_type: type,
                       target_date: r.iso, fetched_at: stempel, value: median(gyldige), unit: "celsius" });
      prognoser.push({ source: "ensemble_mean", city: by.slug, market_type: type,
                       target_date: r.iso, fetched_at: stempel, value: snitt(gyldige), unit: "celsius" });
    }

    // ── prisene ────────────────────────────────────────────────────────────
    let marked: "ok" | "tomt" | "feil" = "feil";
    let antallBøtter = 0;
    if (mSvar.utfall === "tomt") marked = "tomt";
    if (mSvar.utfall === "ok") {
      const fullt = lesFulltMarked(mSvar.data);
      fulltMarked = fullt;
      if (!fullt) {
        marked = "tomt";
      } else {
        marked = "ok";
        antallBøtter = fullt.bøtter.length;
        for (const b of fullt.bøtter) {
          priser.push({
            city: by.slug, market_type: type, target_date: r.iso, fetched_at: stempel,
            bucket_label: b.etikett, bucket_low: b.lav, bucket_high: b.høy,
            unit: fullt.enhet,
            yes_ask: b.ask, yes_bid: b.bid, yes_mid: b.mid,
            // «ok» betyr at bøtta fantes. At den manglet en pris står i
            // null-feltene, og det er en annen sak enn at markedet var borte.
            market_status: "ok",
          });
        }
      }
    }

    return { prognoser, priser,
             notat: { by: by.slug, type, modeller: antallModeller, bøtter: antallBøtter, marked },
             del: { by: by.slug, type, målDato: r.iso, fullt: fulltMarked, verdier: modellverdier } };
  });

  return {
    prognoser: deler.flatMap((d) => d.prognoser),
    priser: deler.flatMap((d) => d.priser),
    notater: deler.map((d) => d.notat),
    markeder: deler.map((d) => d.del),
  };
}

/** Åpne dager finnes rutinemessig ikke ennå — tomt er ikke en feil. */
function tomtMarked(d: unknown): boolean {
  return !Array.isArray(d) || d.length === 0;
}
function tomPrognose(d: unknown): boolean {
  const daily = (d as { daily?: Record<string, unknown> } | null)?.daily;
  return !daily || Object.keys(daily).length <= 1;   // bare `time`
}
