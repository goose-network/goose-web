// src/pages/checkSites.ts — the check-site list behind the exit-IP page, and
// the single-run request built from it.
//
// Two constraints from the engine shape this file. A check site must answer
// with nothing but an IP address: the engine reads at most 64 bytes and runs
// them through net.ParseIP, so a JSON endpoint or an HTML "what is my IP"
// page fails every check with "is not an IP" and reads like a broken proxy.
// And the two empty lists mean different things. In a *run* request an empty
// site list is "use the configured sites", so the request builder drops it
// rather than sending `[]`. In the *saved config*, null means "follow the
// engine's built-in defaults" while an explicit `[]` means every site was
// deleted — the page seeds the defaults into the editor so they can be, and
// saving the emptied list switches the checks off.
//
// The outbound list has the same trap with a sharper edge, because there an
// empty list does not mean "nothing": `internal/exitip.RunSpec.Outbounds` is
// omitempty and the engine reads it absent as "check every address-bearing
// outbound". That is exactly what the picker's all-chip asks for, and exactly
// the opposite of what unchecking it asks for — so the nothing-selected state
// has no wire form at all, and the run has to be refused instead of sent.
// exitRunOutbounds and exitRunProblem are where that refusal is decided; see
// them below.

import {
  isNothingSelected,
  nothingSelectedProblem,
  type ChipSelection,
} from "../components/ChipPicker";
import type { ExitRunSpec } from "../runApi";
import { cleanList, httpUrl } from "../validate";

/** The engine's built-in defaults (`internal/exitip.defaultSites`), used when
 *  no site is configured — and seeded into the page's editors when the config
 *  has none, which is what makes the built-ins deletable on the web. Kept as
 *  its own list so the "these are the engine's defaults" story stays
 *  checkable: checkSites.test.ts asserts every one of these is offered in the
 *  picker. */
export const ENGINE_DEFAULT_SITES = [
  "https://ifconfig.me",
  "https://api.ipify.org",
  "https://checkip.amazonaws.com",
  "https://ipinfo.io/ip",
] as const;

/** The saved site list, or undefined when the engine has none saved. The
 *  engine marshals an unset list as JSON `null` and an emptied one as `[]`,
 *  and the two are different states — "follow the built-in defaults" versus
 *  "every site was deleted, checks off" — so neither may collapse into the
 *  other on the way into an editor. */
export function savedSiteList(
  cfgSites: string[] | null | undefined,
): string[] | undefined {
  return Array.isArray(cfgSites) ? cfgSites : undefined;
}

/** What a site editor starts from: the saved list when the engine has one —
 *  an explicitly emptied list included, because that is its own state (every
 *  site deleted, checks off) and must not grow the defaults back — and the
 *  engine's built-in defaults otherwise, seeded as ordinary rows so they can
 *  be deleted on the web. Every editor on the Exit IP page seeds through
 *  this one function so the three call sites cannot drift apart. */
export function editorSeedSites(
  cfgSites: string[] | null | undefined,
): string[] {
  return savedSiteList(cfgSites) ?? [...ENGINE_DEFAULT_SITES];
}

/** What the engine falls back to when `exit_checks` leaves a number at 0
 *  (`config.ExitCheckConfig.EffectiveTimeoutSec` / `EffectiveConcurrency`).
 *  That resource has no omitempty on any field, so a fresh engine reports 0
 *  for both — and a form showing "0" beside a hint that says "empty uses the
 *  configured value" is showing a value the engine will never use. */
export const ENGINE_DEFAULT_TIMEOUT_SEC = 15;
export const ENGINE_DEFAULT_CONCURRENCY = 4;

/** Placeholder text for an exit-check number field: what the engine will
 *  actually use, which is the configured value when it is set and the built-in
 *  default when the config still reads 0. */
export function effectiveNumber(
  configured: number | undefined,
  fallback: number,
): string {
  const n = configured ?? 0;
  return String(n > 0 ? n : fallback);
}

/** The first site the engine would reject, or undefined when every entry is
 *  usable. `fetchExitIP` requires an absolute http(s) URL, and this page shows
 *  sites *without* their scheme everywhere — the preset chips, and the site
 *  column of both tables — so "ifconfig.me" is what a reader naturally types
 *  and what then fails every check with `bad site URL`, far from the field. */
export function firstBadSite(sites: string[]): string | undefined {
  return cleanList(sites).find((s) => httpUrl(s, "bad") !== null);
}

/** The words every bad-site refusal on this page uses, kept here because two
 *  buttons refuse for the same reason and neither may drift from the other:
 *  "Check now" (via exitRunProblem) and "Save these sites as the defaults",
 *  which would otherwise persist the unparseable site into every later round.
 *  Both also *disable* on the same `firstBadSite` test, so a reader who reads
 *  one explanation has already been given the other one's. */
export const BAD_SITE_MESSAGE =
  "Fix the check site first — the engine needs an absolute http(s) URL";

export interface SitePreset {
  url: string;
  /** why a reader would pick this one */
  note: string;
}

/** Curated plain-text IP echoers, grouped by how they are usually reached for. */
export const CHECK_SITE_PRESETS: Array<{ group: string; sites: SitePreset[] }> = [
  {
    group: "Engine defaults",
    sites: ENGINE_DEFAULT_SITES.map((url) => ({ url, note: "built in" })),
  },
  {
    group: "More echoers",
    sites: [
      { url: "https://icanhazip.com", note: "either IP family" },
      { url: "https://ipv4.icanhazip.com", note: "forces IPv4" },
      { url: "https://ipv6.icanhazip.com", note: "forces IPv6" },
      { url: "https://ident.me", note: "either IP family" },
      { url: "https://myexternalip.com/raw", note: "IPv4" },
      { url: "https://ipecho.net/plain", note: "IPv4" },
      { url: "https://wtfismyip.com/text", note: "either IP family" },
      { url: "http://ip-api.com/line/?fields=query", note: "plain HTTP; 45 req/min" },
    ],
  },
];

export interface SingleRunFields {
  sites: string[];
  /** outbound ids to check; empty means every address-bearing outbound */
  outbounds: string[];
  timeoutSec: number;
  concurrency: number;
}

/**
 * buildExitRunSpec turns the single-run form into a request body, leaving out
 * everything the reader did not touch. An omitted field means "use the
 * engine's configured value" — which is what makes a one-off run work with no
 * schedule configured at all, and what stops a cleared timeout from silently
 * overriding the configured one with 0.
 */
export function buildExitRunSpec(f: SingleRunFields): ExitRunSpec {
  const sites = cleanList(f.sites);
  const spec: ExitRunSpec = {};
  if (sites.length > 0) spec.sites = sites;
  if (f.outbounds.length > 0) spec.outbounds = [...f.outbounds];
  if (f.timeoutSec > 0) spec.timeout_seconds = f.timeoutSec;
  if (f.concurrency > 0) spec.concurrency = f.concurrency;
  return spec;
}

/** The outbound list one run should send, or null for the state that has no
 *  wire form at all.
 *
 *  All-mode is `[]`, and buildExitRunSpec then omits the field — which is the
 *  engine's own reading of the all-chip: `RunSpec.Outbounds` is omitempty, and
 *  CheckNow expands an absent list to every address-bearing built outbound.
 *  An explicit selection sends exactly its refs, copied so the caller cannot
 *  hand the picker's state to something that mutates it.
 *
 *  Nothing selected returns null, not `[]`. `[]` here is indistinguishable from
 *  all-mode on the wire, so it would check the whole fleet the reader just
 *  unchecked — the inversion exitRunProblem exists to refuse. The null is what
 *  makes that refusal compile: run() has to prove the list is non-null before
 *  it can reach buildExitRunSpec. */
export function exitRunOutbounds(sel: ChipSelection): string[] | null {
  if (sel.all) return [];
  if (isNothingSelected(sel)) return null;
  return [...sel.refs];
}

/** Why "Check now" is off, or null when the run may go. Neither branch writes
 *  its own words: a bad site outranks a missing selection because that is the
 *  precedence the button's title has always had — an unparseable URL fails
 *  *every* check against it, whichever outbounds run, so it is the one to fix
 *  first — and BAD_SITE_MESSAGE is the same sentence the sites-save button's
 *  title carries, because that button is off for the same reason. A missing
 *  selection then reuses the pickers' shared message: the engine reads an empty
 *  list as "every one of them", which is the sentence both pickers need. */
export function exitRunProblem(
  sel: ChipSelection,
  badSite: string | undefined,
): { blocked: true; message: string } | null {
  if (badSite !== undefined) {
    return { blocked: true, message: BAD_SITE_MESSAGE };
  }
  if (isNothingSelected(sel)) {
    return nothingSelectedProblem("outbound", "every outbound");
  }
  return null;
}
