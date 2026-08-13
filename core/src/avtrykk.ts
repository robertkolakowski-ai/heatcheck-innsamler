/**
 * AVTRYKK — stabil kanonisering og en hash uten avhengigheter.
 *
 * ── Hvorfor disse to funksjonene bor i sin egen fil ───────────────────────
 *
 * De sto i `regelversjon.ts` og var riktige der, helt til en fil til trengte
 * dem: `market.ts` skal kunne avtrykke oppgjørsteksten fra et marked.
 *
 * `market.ts` ligger i INNSAMLERENS importgraf (`runtime/snapshots.ts` leser
 * markeder gjennom den), og `regelversjon.ts` importerer `regler.ts` for en
 * type. Hadde `market.ts` importert derfra, ville hele regelmotoren fulgt med
 * til den siden av skillet som skal kunne leses av andre —
 * `runtime/test/deling.test.ts` følger nettopp den grafen, transitivt.
 *
 * Alternativet var en kopi. Det er den ene tingen denne kodebasen har brukt
 * mest tid på å luke ut, og en hash i to eksemplarer ville vært verre enn de
 * andre kopiene: to avtrykk som er *nesten* like ser ut som en endring som
 * ikke har skjedd.
 *
 * Derfor: én fil, null importer, og `regelversjon.ts` re-eksporterer herfra
 * så ingenting som brukte den før merker flyttingen.
 *
 * ── Hvorfor ikke SHA-256 ──────────────────────────────────────────────────
 *
 * `core/` er rene funksjoner uten avhengigheter — det er hele grunnen til at
 * nettleseren og Node kan dele dem. `node:crypto` finnes ikke i nettleseren,
 * og `crypto.subtle` er asynkron og finnes ikke overalt. FNV-1a over 64 bit er
 * noen linjer, deterministisk, og godt nok til oppgaven: dette er et
 * ENDRINGSVARSEL, ikke en signatur. Ingenting hviler på at det er vanskelig å
 * konstruere to innhold med samme avtrykk — bare på at en endring gjort i god
 * tro nesten helt sikkert endrer det.
 */

/**
 * Stabil JSON: nøklene sorteres, hele veien ned.
 *
 * Uten dette ville det samme innholdet skrevet ut på nytt av et verktøy — samme
 * data, annen nøkkelrekkefølge — fått nytt avtrykk og sett ut som en endring.
 * Da hadde varselet ropt så ofte at det ble ignorert, som er den eneste måten
 * et endringsvarsel kan svikte på.
 *
 * `undefined` skrives som `null`. `JSON.stringify` dropper undefined-felt i
 * objekter og gjør dem til null i lister, og den forskjellen skal ikke kunne
 * bety noe her.
 */
export function kanonisk(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(kanonisk).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const nøkler = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return "{" + nøkler.map((k) => JSON.stringify(k) + ":" + kanonisk(o[k])).join(",") + "}";
  }
  if (typeof v === "number" && !Number.isFinite(v)) return "null";
  return JSON.stringify(v);
}

/**
 * FNV-1a, 64 bit, som 16 heksadesimale tegn.
 *
 * BigInt og ikke Number: over 2^53 slutter et JS-tall å telle enkeltverdier, og
 * en hash som mister lave bits er ikke lenger en hash. Maskeringen mot
 * `0xFFFF_FFFF_FFFF_FFFF` er 64-bits overflyt gjort med vilje.
 */
export function fingeravtrykk(s: string): string {
  const MASKE = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    // Tegnkoden og ikke byten: inndata er kanonisk JSON, så en æ er ett tegn
    // her og to bytes i UTF-8. Begge er deterministiske; tegnkoden er billigere.
    h = (h ^ BigInt(s.charCodeAt(i))) & MASKE;
    h = (h * 0x100000001b3n) & MASKE;
  }
  return h.toString(16).padStart(16, "0");
}
