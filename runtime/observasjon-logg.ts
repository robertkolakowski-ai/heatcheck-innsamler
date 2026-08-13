/**
 * OBSERVASJONSLOGGEREN — CLI-en jobben kjører.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  DENNE JOBBEN SAMLER DET SOM IKKE KAN HENTES INN IGJEN
 *
 *  Ingen tjeneste serverer gamle sanntidsobservasjoner med den dekningen vi
 *  trenger. IEMs arkiv gir riktignok METAR bakover i tid — men det svarer på
 *  «hva ble målt», ikke på «hva VISSTE vi klokka 13:42». Den forskjellen er
 *  hele grunnlaget for å måle om observasjonsmomentum har en kant.
 *
 *  Hver time uten denne loggen er derfor en time som ikke kan gjenskapes.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── ⚠ SKRIVER BARE TIL POSTGRES, ALDRI TIL `data/` ────────────────────────
 *
 * Alle de andre loggerne i dette repoet skriver fil først og base etterpå, og
 * den rekkefølgen er riktig for dem: de kjører hver halvtime, og en fil i git
 * er den kilden som ikke krever nøkler.
 *
 * Denne kjører hvert femte minutt i dagslys. En commit per kjøring ville
 * betydd rundt 150 utrullinger i døgnet mot Vercels gratistak på 100 — samme
 * felle som K8 i `docs/BACKLOG.md`, der London-loggen brukte opp
 * deploy-kvoten. Uten nøkler skriver denne jobben derfor INGENTING, og sier
 * det høyt, framfor å finne på et lagringssted som koster mer enn det smaker.
 *
 * ── HVOR DEN HØRER HJEMME ─────────────────────────────────────────────────
 *
 * I det ÅPNE innsamler-repoet. `docs/DELING.md` regner ut hvorfor: repoet
 * bruker allerede ~222 kjøringer i døgnet mot et gratistak som holder til
 * under fem dager, og 6. august stanset alt. Offentlige repo har ubegrensede
 * Actions-minutter. En femminutters poll er økonomisk umulig på den private
 * siden og gratis på den åpne.
 *
 * Filen importerer derfor ingenting fra beslutningslaget, og
 * `runtime/test/deling.test.ts` følger den grafen.
 *
 *   node --experimental-strip-types runtime/observasjon-logg.ts --tørr
 *   node --experimental-strip-types runtime/observasjon-logg.ts
 *   node --experimental-strip-types runtime/observasjon-logg.ts --alle-kilder
 */

import { finnBy } from "../core/src/byer.ts";
import { alderSek } from "../core/src/metar.ts";
// `lesOppsett` hentes fra `base-snapshots.ts` og IKKE fra `base.ts`. Den
// filen står på forbudslista i `runtime/test/deling.test.ts` fordi den bærer
// radskjemaene for prediksjoner, fasit og skyggeordrer — og et skjema forteller
// hva som måles, som er en vesentlig del av hva som er verdt å vite.
// `base-snapshots.ts` ble skåret ut nettopp for å slippe å ta dem med.
import { lesOppsett, skrivObservasjoner, type ObsSnapshot } from "./base-snapshots.ts";
import { hentObservasjoner, sammendrag, type Avlesning } from "./observasjon-hent.ts";
import type { HentOpsjoner } from "./hent.ts";

/**
 * Stasjonene loggen følger.
 *
 * London alene. Ikke fordi de andre er uinteressante, men fordi maksimum for
 * London er det ene markedet som handles — og fordi en poll som følger 21
 * stasjoner hvert femte minutt er 21 ganger så mange kall mot to gratis
 * tjenester for data ingen ennå har vist at de skal bruke.
 *
 * `BYER` har resten når de skal med. Det er en liste, ikke en omskriving.
 */
export const FULGTE_BYER: readonly string[] = ["london"];

/** Gjør avlesninger om til rader. Ren — tidsstemplet sendes inn. */
export function tilRader(
  avlesninger: readonly Avlesning[],
  hentetISO: string,
): ObsSnapshot[] {
  const ut: ObsSnapshot[] = [];
  for (const a of avlesninger) {
    for (const o of a.observasjoner) {
      ut.push({
        icao: o.icao,
        source: a.kilde,
        obs_time_utc: o.gyldigUtc,
        report_type: o.rapporttype,
        temp_c: o.tempC,
        dewpoint_c: o.duggpunktC,
        wind_kt: o.vindKt,
        wind_gust_kt: o.vindKastKt,
        wind_dir: o.vindRetning,
        pressure_hpa: o.trykkHpa,
        auto: o.auto,
        corrected: o.korrigert,
        raw_metar: o.rå,
        fetched_at: hentetISO,
      });
    }
  }
  return ut;
}

/**
 * Fjern dubletter innenfor én runde.
 *
 * Uniknøkkelen i basen tar dem uansett, men PostgREST avviser et innlegg der
 * SAMME nøkkel står to ganger i samme kropp — «ON CONFLICT DO UPDATE command
 * cannot affect row a second time». Det skjer så snart to kilder er med og
 * begge har den samme rapporten, altså i normal drift med `--alle-kilder`.
 */
export function utenDubletter(rader: readonly ObsSnapshot[]): ObsSnapshot[] {
  const sett = new Map<string, ObsSnapshot>();
  for (const r of rader) {
    sett.set(`${r.icao}|${r.source}|${r.obs_time_utc}|${r.report_type}`, r);
  }
  return [...sett.values()];
}

async function main(): Promise<void> {
  const tørr = process.argv.includes("--tørr");
  const alle = process.argv.includes("--alle-kilder");
  const nåMs = Date.now();
  const hentetISO = new Date(nåMs).toISOString();

  const opt: HentOpsjoner = {
    fetcher: (url, init) => fetch(url, init as RequestInit),
    nåMs,
    bufferMs: 0,
    logg: (m) => console.log(`[obs] ${m}`),
  };

  const alleRader: ObsSnapshot[] = [];
  let noeKom = false;

  for (const slug of FULGTE_BYER) {
    const by = finnBy(slug);
    if (!by) { console.error(`[obs] ukjent by «${slug}» — står den i byer.ts?`); continue; }

    const avlesninger = await hentObservasjoner(by.icao, opt, { alle });
    console.log(`[obs] ${by.icao}: ${sammendrag(avlesninger)}`);

    const rader = tilRader(avlesninger, hentetISO);
    if (rader.length) noeKom = true;
    alleRader.push(...rader);

    // Friskheten er spesifikasjonens `age_seconds`, og den hører i loggen
    // fordi det er den ene tilstanden som ikke vises noe annet sted: en
    // henting som lyktes uten å gi noe NYTT ser ellers ut som en frisk kilde.
    const alder = alderSek(avlesninger.flatMap((a) => a.observasjoner), nåMs);
    console.log(`[obs] ${by.icao}: ferskeste observasjon ${alder === null ? "—" : `${alder} s`} gammel`);
  }

  const rader = utenDubletter(alleRader);
  console.log(`[obs] ${rader.length} rad(er) klar` +
              (rader.length !== alleRader.length ? ` (${alleRader.length - rader.length} dublett(er) slått sammen)` : ""));

  // Ingen rapporter er ikke en feil i seg selv — en stasjon kan mangle
  // rapporter i et vindu. At INGEN kilde svarte er derimot verdt en advarsel,
  // fordi det er den tilstanden som ellers ser identisk ut med «alt er stille».
  if (!noeKom) {
    console.warn("[obs] ingen kilde ga rapporter denne runden");
    if (process.env.GITHUB_ACTIONS) console.log("::warning::obs: ingen rapporter fra noen kilde");
  }

  if (tørr) { console.log("[obs] tørrkjøring — ingenting skrevet."); return; }
  if (!rader.length) return;

  const oppsett = lesOppsett(process.env);
  if (oppsett.status === "mangler") {
    // Ingen fil-reserve, med vilje. Se toppen av filen.
    console.error(`[obs] Postgres er ikke satt opp (${oppsett.navn.join(", ")}) — ` +
                  "ingenting lagres. Denne jobben har ingen fil-reserve, fordi en " +
                  "commit hvert femte minutt ville brukt opp utrullingskvoten.");
    process.exitCode = 1;
    return;
  }
  if (oppsett.status === "ugyldig") {
    console.error(`[obs] Postgres-oppsettet er feil: ${oppsett.grunn}`);
    process.exitCode = 1;
    return;
  }

  const svar = await skrivObservasjoner(rader, oppsett.oppsett, opt);
  if (svar.utfall === "ok") console.log(`[obs] base: ${rader.length} rad(er) skrevet.`);
  else {
    console.error(`[obs] base: FEILET — ${"grunn" in svar ? svar.grunn : svar.utfall}`);
    process.exitCode = 1;
  }
}

// Kjøres den som skript, kjør. Importeres den fra en test, gjør ingenting.
if (process.argv[1] && process.argv[1].endsWith("observasjon-logg.ts")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
