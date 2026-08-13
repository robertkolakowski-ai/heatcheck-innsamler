/**
 * PRISHISTORIKKEN — minuttoppløste priser, hentet etter at dagen er over.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  DEN ENE DATASTRØMMEN SOM ER GJENVINNBAR
 *
 *  `price_snapshots` gir vår egen serie: én lesning per bøtte hver halvtime,
 *  med et hentetidspunkt vi kjenner. Den er ærligst for look-ahead — vi vet
 *  nøyaktig når vi kunne ha sett hver pris.
 *
 *  Men den er grov. CLOB serverer minuttoppløst historikk i ETTERKANT, og
 *  det er nettopp derfor denne jobben ikke er en poller: den går én gang i
 *  døgnet, etter at markedet har lukket, og henter hele dagen i ett.
 *
 *  Alt annet i S1 haster fordi det ikke kan hentes inn igjen. Dette gjør det
 *  motsatte — og det er grunnen til at det står sist.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── HVA DEN ER TIL FOR ────────────────────────────────────────────────────
 *
 * Exit-motoren. `core/src/bok.ts:spread` sier rett ut at det er dyrt å komme
 * UT av disse bøkene, og en exit-regel som etterprøves mot midtpris svarer på
 * et annet spørsmål enn den stiller. Med minuttpriser kan spørsmålet «kunne
 * vi faktisk ha solgt til den prisen, på det tidspunktet» stilles.
 *
 * ── ⚠ SVARFORMEN ER IKKE VERIFISERT ──────────────────────────────────────
 *
 * Utviklingsmiljøet har ingen utgående nettilgang. Feltnavnene er skrevet
 * etter Polymarkets dokumentasjon, og `lesHistorikk` prøver flere former.
 * Første kjøring med nett avgjør hvilken som er i bruk.
 *
 *   node --experimental-strip-types runtime/prishistorikk.ts --tørr
 *   node --experimental-strip-types runtime/prishistorikk.ts --dager 2
 */

import { byslug, finnBy, type Markedstype } from "../core/src/byer.ts";
import { lesFulltMarked } from "../core/src/market.ts";
import { hentJson, medTak, type HentOpsjoner, type Svar } from "./hent.ts";
import { lesOppsett, skrivPrishistorikk, type PrishistorikkSnapshot } from "./base-snapshots.ts";

const CLOB = "https://clob.polymarket.com/prices-history";
const GAMMA = "https://gamma-api.polymarket.com/events";
const TAK = 4;

/** Markedene historikken hentes for. Samme korte liste som timesbanen. */
export const MÅL: ReadonlyArray<{ by: string; markedstype: Markedstype }> = [
  { by: "london", markedstype: "highest" },
];

/**
 * Ett minutt er `fidelity=1`. Vinduet er hele måldøgnet pluss litt slark i
 * begge ender — markedet lukker 22:00 UTC, men de siste minuttene før det er
 * nettopp de en exit-regel ville handlet i.
 */
export function urlHistorikk(tokenId: string, fraSek: number, tilSek: number): string {
  return `${CLOB}?market=${encodeURIComponent(tokenId)}` +
         `&startTs=${Math.floor(fraSek)}&endTs=${Math.ceil(tilSek)}&fidelity=1`;
}

/** Markedet, inkludert lukkede — historikken hentes ETTER at dagen er over. */
export function urlOppgjortMarked(by: string, type: Markedstype, iso: string): string {
  return `${GAMMA}?limit=3&slug=${byslug(by, type, iso)}`;
}

/**
 * Punktene ut av CLOBs svar.
 *
 * Formen er `{ history: [{ t, p }] }`. Både `t`/`p` og `timestamp`/`price`
 * prøves, og `t` tolkes som sekunder når tallet er lite nok — samme
 * sekund-mot-millisekund-felle som `observasjon-hent.ts:refFra`.
 */
export function lesHistorikk(data: unknown): Array<{ tsUtc: string; pris: number }> {
  const liste = Array.isArray(data)
    ? data
    : Array.isArray((data as { history?: unknown })?.history)
      ? (data as { history: unknown[] }).history
      : [];

  const ut: Array<{ tsUtc: string; pris: number }> = [];
  for (const rad of liste as Array<Record<string, unknown>>) {
    if (!rad || typeof rad !== "object") continue;
    const rå = rad.t ?? rad.timestamp;
    const p = rad.p ?? rad.price;
    const ms = typeof rå === "number" && Number.isFinite(rå)
      ? (rå < 1e11 ? rå * 1000 : rå)
      : typeof rå === "string" ? Date.parse(rå) : NaN;
    const pris = typeof p === "number" ? p : Number.parseFloat(String(p));
    if (!Number.isFinite(ms) || !Number.isFinite(pris)) continue;
    ut.push({ tsUtc: new Date(ms).toISOString(), pris });
  }
  return ut;
}

export interface Resultat {
  readonly rader: PrishistorikkSnapshot[];
  readonly notater: string[];
}

/** Hent historikken for én (by, type, dato). Kaster aldri. */
export async function hentFor(
  by: string, type: Markedstype, iso: string, opt: HentOpsjoner,
): Promise<Resultat> {
  const b = finnBy(by);
  if (!b) return { rader: [], notater: [`ukjent by ${by}`] };

  const mSvar: Svar<unknown> = await hentJson(
    urlOppgjortMarked(by, type, iso), opt, (d) => !Array.isArray(d) || d.length === 0);
  if (mSvar.utfall !== "ok") {
    return { rader: [], notater: [`${by}/${type} ${iso}: marked ${mSvar.utfall}`] };
  }

  const marked = lesFulltMarked(mSvar.data);
  if (!marked) return { rader: [], notater: [`${by}/${type} ${iso}: ingen bøtter`] };

  // Døgnet pluss en time i hver ende. Markedet lukker 22:00 UTC, og de siste
  // minuttene før det er nettopp de en exit-regel ville handlet i.
  const [år, md, dag] = iso.split("-").map(Number);
  const fra = Date.UTC(år, md - 1, dag, -1) / 1000;
  const til = Date.UTC(år, md - 1, dag, 24) / 1000;

  const bøtter = marked.bøtter.filter((x) => x.yesToken);
  const deler = await medTak(bøtter, TAK, async (bøtte) => {
    const r = await hentJson(urlHistorikk(bøtte.yesToken!, fra, til), opt,
      (d) => lesHistorikk(d).length === 0);
    return { bøtte, r };
  });

  const rader: PrishistorikkSnapshot[] = [];
  const notater: string[] = [];
  for (const { bøtte, r } of deler) {
    if (r.utfall !== "ok") { notater.push(`${bøtte.etikett}: ${r.utfall}`); continue; }
    for (const p of lesHistorikk(r.data)) {
      rader.push({
        city: by, market_type: type, target_date: iso,
        token_id: bøtte.yesToken!, bucket_label: bøtte.etikett,
        ts_utc: p.tsUtc, price: p.pris, source: "clob",
      });
    }
  }
  return { rader, notater };
}

/** Dagen `n` døgn før `nåMs`, som ISO. */
export function isoFør(nåMs: number, n: number): string {
  return new Date(nåMs - n * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const tørr = process.argv.includes("--tørr");
  const i = process.argv.indexOf("--dager");
  const dager = i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 1) : 1;

  const nåMs = Date.now();
  const opt: HentOpsjoner = {
    fetcher: (url, init) => fetch(url, init as RequestInit),
    nåMs, bufferMs: 0,
    logg: (m) => console.log(`[prishist] ${m}`),
  };

  const alle: PrishistorikkSnapshot[] = [];
  for (let d = 1; d <= dager; d++) {
    const iso = isoFør(nåMs, d);
    for (const m of MÅL) {
      const r = await hentFor(m.by, m.markedstype, iso, opt);
      alle.push(...r.rader);
      console.log(`[prishist] ${m.by}/${m.markedstype} ${iso}: ${r.rader.length} punkt(er)` +
                  (r.notater.length ? ` · ${r.notater.join(", ")}` : ""));
    }
  }

  console.log(`[prishist] ${alle.length} rad(er) totalt`);
  if (tørr) { console.log("[prishist] tørrkjøring — ingenting skrevet."); return; }
  if (!alle.length) return;

  const oppsett = lesOppsett(process.env);
  if (oppsett.status !== "ok") {
    console.error(`[prishist] Postgres er ikke satt opp (${oppsett.status}) — ingenting lagres.`);
    process.exitCode = 1;
    return;
  }

  const svar = await skrivPrishistorikk(alle, oppsett.oppsett, opt);
  if (svar.utfall === "ok") console.log(`[prishist] base: ${alle.length} rad(er) skrevet.`);
  else {
    console.error(`[prishist] base: FEILET — ${"grunn" in svar ? svar.grunn : svar.utfall}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("prishistorikk.ts")) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
