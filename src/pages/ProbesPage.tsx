// src/pages/ProbesPage.tsx — reachability probes: send real HTTP requests
// toward targets through chosen routes, assert on the responses, and keep
// every result as a metric.
//
// This measures something the TCP dial sweep cannot: a handshake says the
// upstream answered, an HTTP probe says the whole path served a request. One
// form drives both ways to run it — by hand, and on the engine's schedule,
// which stores the same spec under engine.probes.http — so "use these
// settings" is a copy rather than a second editor to keep in sync.
//
// Probe rows stay informational on purpose: the engine never drops a route
// from dispatch over one, because a failed probe may be the target's fault.
// So the pass/fail verdicts here are the reader's, computed in the browser
// from the assertions they wrote, and the engine's own reachability verdicts
// stay on the Outbounds and Metrics pages.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Engine } from "@goose-network/goose-sdk";
import { useSdk } from "../sdk";
import { errMessage, useAsync, useSeededDraft } from "../useAsync";
import { PageHeader } from "../components/PageHeader";
import { DataTable, EmptyState, type Column } from "../components/DataTable";
import { Notice, useToast } from "../components/Notice";
import {
  CheckField,
  FieldGroup,
  NumberField,
  SelectField,
  TextField,
} from "../components/fields";
import { StringList } from "../components/StringList";
import { formatDuration, formatTime } from "../format";
import { httpUrl } from "../validate";
import {
  buildExpectations,
  buildProbeSpec,
  byteLength,
  carriesBody,
  checkExpectations,
  ENGINE_PROBE_DEFAULTS,
  formatStatuses,
  hasExpectations,
  HTTP_METHODS,
  orDefault,
  parseRawRequest,
  parseStatuses,
  probeResponse,
  PROBE_TARGET_PRESETS,
  type ExpectationFields,
  type Expectations,
  type Header,
  type ProbeSpecFields,
  type Verdict,
} from "./probeSpec";
import {
  listProbeResults,
  runProbes,
  type HTTPProbe,
  type ProbeEngineProbes,
} from "../runApi";

/** The probe form: the spec both endpoints take, plus the assertions the
 *  browser evaluates over the responses. */
interface ProbeForm extends ProbeSpecFields {
  expect: ExpectationFields;
}

/** One finished round: the records, and the assertions they were judged with.
 *  Both are snapshotted at run time — the results card reads as the answer to
 *  the round just made, so editing an assertion afterwards must not silently
 *  re-judge responses that were fetched under the old one. */
interface RunOutcome {
  probes: HTTPProbe[];
  expectations: Expectations;
}

const INITIAL_FORM: ProbeForm = {
  targets: [],
  method: "GET",
  headers: [],
  body: "",
  routes: [],
  timeoutSec: 0,
  maxBodyBytes: 0,
  expect: { statuses: "", headers: [], body: [] },
};

// History depths offered. The default below must be one of them: a select whose
// value matches no option renders with nothing selected.
const ROW_OPTIONS = [100, 200, 500, 1000, 5000];
const PAGE = 50;

export function ProbesPage() {
  const [form, setForm] = useState<ProbeForm>(INITIAL_FORM);
  const patch = useCallback(
    (p: Partial<ProbeForm>) => setForm((f) => ({ ...f, ...p })),
    [],
  );
  // A manual run writes the same rows the history lists, so finishing one
  // refreshes the other.
  const [ranAt, setRanAt] = useState(0);
  const onRan = useCallback(() => setRanAt((n) => n + 1), []);

  return (
    <>
      <PageHeader
        title="Reachability probe"
        sub="Send a real HTTP request toward targets through chosen routes, assert on the response, and keep every result as a metric — once by hand, or on a schedule."
      />
      <ProbeRunCard form={form} patch={patch} onRan={onRan} />
      <ScheduledProbeCard form={form} />
      <ProbeHistoryCard ranAt={ranAt} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Manual run
// ---------------------------------------------------------------------------

function ProbeRunCard({
  form,
  patch,
  onRan,
}: {
  form: ProbeForm;
  patch: (p: Partial<ProbeForm>) => void;
  onRan: () => void;
}) {
  const { goose } = useSdk();
  const { toast } = useToast();
  const resources = useAsync(
    () =>
      Promise.all([goose.listOutbounds(), goose.listPools(), goose.listChains()]),
    [goose],
  );

  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Every route reference the engine can resolve right now, plus "direct".
  const routeChoices = useMemo(() => {
    const refs = (ids: Array<string | undefined>, kind: string) =>
      ids
        .filter((id): id is string => id !== undefined && id !== "")
        .map((id) => `${kind}:${id}`);
    return [
      ...refs((resources.data?.[0] ?? []).map((o) => o.id), "outbound"),
      ...refs((resources.data?.[1] ?? []).map((p) => p.id), "pool"),
      ...refs((resources.data?.[2] ?? []).map((c) => c.id), "chain"),
      "direct",
    ];
  }, [resources.data]);

  const run = async () => {
    const spec = buildProbeSpec(form);
    // The engine rejects the whole round for one bad target, so say which one
    // here instead of after a round trip.
    const bad = spec.targets.find((t) => httpUrl(t, "bad") !== null);
    if (spec.targets.length === 0) {
      setRunError("Add at least one target — an absolute http(s) URL.");
      return;
    }
    if (bad !== undefined) {
      setRunError(`“${bad}” is not an absolute http(s) URL.`);
      return;
    }

    setRunning(true);
    setRunError(null);
    try {
      const res = await runProbes(goose, spec);
      setOutcome({ probes: res, expectations: buildExpectations(form.expect) });
      onRan();
      const answered = res.filter((p) => p.success === true).length;
      toast(
        `${res.length} probe${res.length === 1 ? "" : "s"} run — ${answered} got a response`,
        answered === res.length ? "good" : "bad",
      );
    } catch (err) {
      setRunError(errMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const addPreset = (url: string, expect: string) => {
    patch({
      targets: form.targets.includes(url) ? form.targets : [...form.targets, url],
      // The preset's usual status joins the expected ones, so adding a
      // connectivity-check URL gives the run something to assert.
      expect: {
        ...form.expect,
        statuses: formatStatuses(parseStatuses(`${form.expect.statuses} ${expect}`)),
      },
    });
  };

  const routeWord = form.routes.length === 0 ? "every outbound" : `${form.routes.length} route${form.routes.length === 1 ? "" : "s"}`;

  // A pasted request can carry any method token (“PURGE”), and a select whose
  // value matches no option renders blank — the form would hide the method the
  // round is about to send. So whatever it holds is always among the options.
  const methodOptions = useMemo(() => {
    const listed: readonly string[] = HTTP_METHODS;
    return listed.includes(form.method) ? [...listed] : [...listed, form.method];
  }, [form.method]);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Run a probe</h2>
          <div className="spacer" />
          <span className="pill">
            {form.targets.length} target{form.targets.length === 1 ? "" : "s"} × {routeWord}
          </span>
          <button
            type="button"
            className="primary"
            onClick={() => void run()}
            disabled={running}
          >
            {running ? "Probing…" : "Probe now"}
          </button>
        </div>
        <p className="hint">
          The engine — not this browser — sends the request below toward each target through each
          route, and records one result per pair. Results are informational: a failing probe never
          removes a route from dispatch, because the target may be what is down.
        </p>

        <StringList
          id="probe-targets"
          label="Targets"
          mono
          values={form.targets}
          placeholder="https://ifconfig.me/ip"
          addLabel="Add target"
          hint="Absolute http(s) URLs. Duplicates are dropped before the round runs."
          onChange={(targets) => patch({ targets })}
        />
        <TargetPresets onAdd={addPreset} />

        <div className="row">
          <SelectField
            id="probe-method"
            label="Method"
            value={form.method}
            options={methodOptions}
            onChange={(method) => patch({ method })}
          />
          <NumberField
            id="probe-timeout"
            label="Per-request timeout (s)"
            min={1}
            placeholder="15"
            value={form.timeoutSec}
            onChange={(timeoutSec) => patch({ timeoutSec })}
          />
          <NumberField
            id="probe-maxbody"
            label="Response body cap (bytes)"
            min={1}
            placeholder="4096"
            hint="A capped body is marked truncated."
            value={form.maxBodyBytes}
            onChange={(maxBodyBytes) => patch({ maxBodyBytes })}
          />
        </div>

        <HeaderList
          id="probe-headers"
          label="Request headers"
          values={form.headers}
          namePlaceholder="X-Token"
          valuePlaceholder="sekret"
          addLabel="Add header"
          hint="Host, Content-Length and Connection are set by the engine itself."
          onChange={(headers) => patch({ headers })}
        />

        {carriesBody(form.method) && (
          <div className="field">
            <label htmlFor="probe-body">Request body</label>
            <textarea
              id="probe-body"
              rows={3}
              className="mono"
              value={form.body}
              spellCheck={false}
              onChange={(e) => patch({ body: e.target.value })}
            />
          </div>
        )}

        <RawRequestPatch targets={form.targets} patch={patch} />
        <RoutePicker
          choices={routeChoices}
          selected={form.routes}
          onChange={(routes) => patch({ routes })}
          loading={resources.loading}
          error={resources.error}
        />

        <h3 className="card-sub">Assertions</h3>
        <Assertions
          value={form.expect}
          onChange={(expect) => patch({ expect })}
        />

        {runError !== null && (
          <Notice onDismiss={() => setRunError(null)}>{runError}</Notice>
        )}
      </div>

      {outcome !== null && (
        <ProbeResults results={outcome.probes} expectations={outcome.expectations} />
      )}
    </>
  );
}

function TargetPresets({
  onAdd,
}: {
  onAdd: (url: string, expect: string) => void;
}) {
  return (
    <div className="field">
      <span className="label" id="probe-presets-label">
        Common targets
      </span>
      <div className="chip-grid" role="group" aria-labelledby="probe-presets-label">
        {PROBE_TARGET_PRESETS.map((p) => (
          <button
            type="button"
            className="chip"
            key={p.url}
            title={`${p.note} — expects ${p.expect}`}
            onClick={() => onAdd(p.url, p.expect)}
          >
            {p.url.replace(/^https?:\/\//, "")}
          </button>
        ))}
      </div>
      <div className="field-hint" id="probe-presets-hint">
        Adds the URL to the targets and its usual status to the expected statuses.
      </div>
    </div>
  );
}

/** Route references to probe through. Nothing selected is a real choice —
 *  "every built outbound" — not an empty form, so it gets its own chip. */
function RoutePicker({
  choices,
  selected,
  onChange,
  loading,
  error,
}: {
  choices: string[];
  selected: string[];
  onChange: (routes: string[]) => void;
  loading: boolean;
  error: string | null;
}) {
  const toggle = (ref: string) =>
    onChange(
      selected.includes(ref)
        ? selected.filter((r) => r !== ref)
        : [...selected, ref],
    );

  return (
    <FieldGroup
      id="probe-routes"
      label="Routes"
      hint="A pool or chain is probed through its own selection path — the same one dispatch uses."
    >
      <div className="chip-grid">
        <label className={`chip${selected.length === 0 ? " on" : ""}`}>
          <input
            type="checkbox"
            checked={selected.length === 0}
            onChange={() => onChange([])}
          />
          every outbound
        </label>
        {choices.map((ref) => (
          <label key={ref} className={`chip${selected.includes(ref) ? " on" : ""}`}>
            <input
              type="checkbox"
              checked={selected.includes(ref)}
              onChange={() => toggle(ref)}
            />
            <span className="mono">{ref}</span>
          </label>
        ))}
      </div>
      {error !== null ? (
        // The three lists arrive as one Promise.all, so a single endpoint the
        // engine lacks empties every group — and "direct is the only route"
        // would then state as a fact about the config what is really a failure
        // to ask about it.
        <Notice>Could not list routes: {error}</Notice>
      ) : (
        !loading &&
        choices.length <= 1 && (
          <div className="field-hint">
            No outbounds, pools or chains are configured yet, so “direct” is the only route.
          </div>
        )
      )}
    </FieldGroup>
  );
}

/** The paste-a-raw-request path: one box that fills the method, headers, body
 *  and target above, for a request copied out of a browser, a log or curl's
 *  --trace-ascii. */
function RawRequestPatch({
  targets,
  patch,
}: {
  targets: string[];
  patch: (p: Partial<ProbeForm>) => void;
}) {
  const [raw, setRaw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = () => {
    const r = parseRawRequest(raw);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error });
      return;
    }
    const { method, target, headers, body, notes } = r.request;
    patch({
      method,
      headers,
      body,
      // Additive on purpose: a paste describes one request, and blanking a
      // fan-out the reader already built would be a rude surprise.
      ...(target === "" || targets.includes(target)
        ? {}
        : { targets: [...targets, target] }),
    });
    setMsg({
      ok: true,
      text:
        notes.length > 0
          ? notes.join(" ")
          : `Filled in ${method}${target === "" ? "" : ` ${target}`}.`,
    });
  };

  return (
    <details className="field paste-box">
      <summary>Paste a raw HTTP request instead</summary>
      <label htmlFor="probe-raw">Raw request</label>
      <textarea
        id="probe-raw"
        rows={6}
        className="mono"
        value={raw}
        spellCheck={false}
        placeholder={"GET /ip HTTP/1.1\nHost: ifconfig.me\nUser-Agent: curl/8.0"}
        onChange={(e) => {
          setRaw(e.target.value);
          setMsg(null);
        }}
      />
      <div className="toolbar">
        <button
          type="button"
          onClick={apply}
          disabled={raw.trim() === ""}
        >
          Parse into the form
        </button>
        {raw !== "" && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setRaw("");
              setMsg(null);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {msg !== null && (
        <Notice kind={msg.ok ? "info" : "error"} onDismiss={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <div className="field-hint">
        Fills the method, headers and body, and adds the request's URL to the targets.
      </div>
    </details>
  );
}

/** What "reachable and correct" means for this probe, as the reader writes it. */
function Assertions({
  value,
  onChange,
}: {
  value: ExpectationFields;
  onChange: (e: ExpectationFields) => void;
}) {
  return (
    <>
      <TextField
        id="probe-expect-status"
        label="Expected statuses"
        mono
        placeholder="200, 204"
        hint="Comma-separated; ranges work (200-204). Empty accepts any response at all."
        value={value.statuses}
        onChange={(statuses) => onChange({ ...value, statuses })}
      />
      <HeaderList
        id="probe-expect-headers"
        label="Expected headers"
        values={value.headers}
        namePlaceholder="content-type"
        valuePlaceholder="json"
        addLabel="Add header assertion"
        hint="A plain word matches as a case-insensitive substring; /re/i is an explicit regex."
        onChange={(headers) => onChange({ ...value, headers })}
      />
      <StringList
        id="probe-expect-body"
        label="Expected body patterns"
        mono
        values={value.body}
        placeholder={'"ip"\\s*:\\s*"203\\.0\\.113\\.'}
        addLabel="Add body pattern"
        hint="Every pattern must match the response body, which is capped by the limit above."
        onChange={(body) => onChange({ ...value, body })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

interface ResultRow {
  probe: HTTPProbe;
  verdicts: Verdict[];
}

function ProbeResults({
  results,
  expectations,
}: {
  results: HTTPProbe[];
  expectations: Expectations;
}) {
  const rows: ResultRow[] = results.map((probe) => ({
    probe,
    verdicts: checkExpectations(expectations, probeResponse(probe)),
  }));
  const asserted = hasExpectations(expectations);
  const answered = rows.filter((r) => r.probe.success === true).length;
  const passed = rows.filter((r) => r.verdicts.every((v) => v.pass)).length;

  const columns: Array<Column<ResultRow>> = [
    { key: "route", header: "Route", className: "mono", render: ({ probe }) => probe.route || "—" },
    { key: "target", header: "Target", className: "mono", render: ({ probe }) => probe.target || "—" },
    {
      key: "status",
      header: "Status",
      className: "nowrap",
      render: ({ probe }) =>
        probe.success === true ? (
          <span className="pill ok">{probe.status ?? 0}</span>
        ) : (
          <span className="pill fail" title={probe.error ?? ""}>
            {probe.status === undefined || probe.status === 0 ? "no response" : probe.status}
          </span>
        ),
    },
    {
      key: "latency",
      header: "Latency",
      className: "num",
      render: ({ probe }) =>
        probe.success === true ? formatDuration(probe.latency ?? 0) : "—",
    },
    {
      key: "asserts",
      header: "Assertions",
      render: ({ verdicts }) => <Verdicts verdicts={verdicts} />,
    },
    { key: "response", header: "Response", render: ({ probe }) => <ResponseDetail probe={probe} /> },
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2>Results</h2>
        <div className="spacer" />
        <span className="pill">
          {rows.length} probe{rows.length === 1 ? "" : "s"}
        </span>
        <span className={`pill ${answered === rows.length ? "ok" : "warn"}`}>
          {answered} answered
        </span>
        {asserted && (
          <span className={`pill ${passed === rows.length ? "ok" : "fail"}`}>
            {passed}/{rows.length} passed
          </span>
        )}
      </div>
      {!asserted && (
        <p className="hint">
          No assertions configured, so every response counts as a pass. Add expected statuses,
          headers or body patterns above to make the round answer a question.
        </p>
      )}
      <DataTable
        caption="Probe results"
        columns={columns}
        rows={rows}
        rowKey={({ probe }) =>
          `${probe.id ?? ""}-${probe.route ?? ""}-${probe.target ?? ""}`
        }
        empty={
          <EmptyState
            title="The round produced no results"
            hint="That happens when the engine accepted the spec but had nothing to run it against."
          />
        }
      />
    </div>
  );
}

function Verdicts({ verdicts }: { verdicts: Verdict[] }) {
  // No verdicts means no assertions were configured: the row is a fact about
  // the response, not a judgement on it.
  if (verdicts.length === 0) return <span className="hint">any response</span>;
  const passed = verdicts.filter((v) => v.pass).length;
  return (
    <span className="verdicts">
      <span className={`pill ${passed === verdicts.length ? "ok" : "fail"}`}>
        {passed}/{verdicts.length}
      </span>
      {verdicts.map((v, i) => (
        <span
          key={i}
          className={`pill ${v.pass ? "ok" : "fail"}`}
          title={`${v.label}: ${v.detail}`}
        >
          {v.label}
        </span>
      ))}
    </span>
  );
}

/** The response itself, folded away until asked for: bodies are up to a
 *  megabyte and a table of them would bury the verdicts. */
function ResponseDetail({ probe }: { probe: HTTPProbe }) {
  const body = probe.body ?? "";
  const error = probe.error ?? "";
  const headers = probe.headers ?? {};
  const names = Object.keys(headers);

  if (body === "" && error === "" && names.length === 0) {
    return <span className="hint">empty</span>;
  }

  return (
    <details className="probe-detail">
      <summary>
        {error !== ""
          ? "error"
          : `${body.length} char${body.length === 1 ? "" : "s"}${
              probe.truncated === true ? " (truncated)" : ""
            }`}
      </summary>
      {error !== "" && <div className="status-bad probe-error">{error}</div>}
      {names.length > 0 && (
        <pre className="probe-body mono">
          {names.map((n) => `${n}: ${headers[n] ?? ""}`).join("\n")}
        </pre>
      )}
      {body !== "" && <pre className="probe-body mono">{body}</pre>}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function ScheduledProbeCard({ form }: { form: ProbeForm }) {
  const { goose } = useSdk();
  const { toast } = useToast();
  const engine = useAsync(() => goose.getEngine(), [goose]);
  const { draft, setDraft, refresh } = useSeededDraft<Engine, ProbeEngineProbes>(
    engine.data,
    (e) => ({ ...(e.probes ?? {}) }),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (engine.error !== null) {
    return <Notice>Failed to load engine config: {engine.error}</Notice>;
  }
  if (draft === null) return null;

  const set = (p: Partial<ProbeEngineProbes>) => setDraft({ ...draft, ...p });
  const http = draft.http;
  const targets = http?.targets ?? [];
  // The engine rejects a scheduled probe whose targets are not absolute URLs,
  // and it does so for the whole config — so check before the round trip.
  const badTarget = targets.find((t) => httpUrl(t, "bad") !== null);
  // Zeros in a stored spec mean "the engine's default", not a value it will
  // apply: every field is stored (no `omitempty`) and defaulted at run time.
  // Printed as-is they would read "0s per request" and a "0 bytes" body cap.
  const timeout = orDefault(http?.timeout_seconds, ENGINE_PROBE_DEFAULTS.timeoutSec);
  const cap = orDefault(http?.max_body_bytes, ENGINE_PROBE_DEFAULTS.maxBodyBytes);
  // An empty target list makes the engine skip the HTTP probe altogether, so
  // copying an empty form would quietly stop a schedule that works — which is
  // what "Clear the HTTP probe" exists to do deliberately.
  const formHasTargets = form.targets.some((t) => t.trim() !== "");

  const save = async () => {
    if (badTarget !== undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      // A fresh read for the base: the engine resource is one object, so
      // putting a stale copy back would undo whatever else changed since this
      // card loaded. The probes section is the one this card edits, so it wins.
      const current = await goose.getEngine();
      await goose.setEngine({ ...current, probes: draft });
      toast("Probe schedule saved");
      refresh();
      engine.reload();
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2>Scheduled probes</h2>
      <p className="hint">
        Every interval the engine runs a round by itself: the TCP dial sweep that feeds
        reachability verdicts, plus the HTTP probe below whenever it has targets. Its results land
        in the history on this page and in the request metrics.
      </p>
      <div className="row">
        <CheckField
          id="probes-enabled"
          label="Enabled"
          checked={draft.enabled === true}
          onChange={(enabled) => set({ enabled })}
        />
        <NumberField
          id="probes-interval"
          label="Interval (seconds)"
          min={10}
          placeholder="300"
          value={draft.interval_seconds ?? 0}
          onChange={(interval_seconds) => set({ interval_seconds })}
        />
        <NumberField
          id="probes-timeout"
          label="Dial timeout (s)"
          min={1}
          placeholder="5"
          hint="Per TCP dial in the sweep."
          value={draft.timeout_seconds ?? 0}
          onChange={(timeout_seconds) => set({ timeout_seconds })}
        />
      </div>

      <h3 className="card-sub">HTTP probe</h3>
      {targets.length === 0 ? (
        <p className="hint">
          Not configured — the round runs the dial sweep alone. Fill in the form above and copy it
          here to probe on a schedule.
        </p>
      ) : (
        <dl className="def-grid">
          <div>
            <dt>Targets</dt>
            <dd className="mono">{targets.join(", ")}</dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{http?.method || "GET"}</dd>
          </div>
          <div>
            <dt>Routes</dt>
            <dd className="mono">
              {(http?.routes ?? []).length === 0
                ? "every outbound"
                : (http?.routes ?? []).join(", ")}
            </dd>
          </div>
          <div>
            <dt>Request</dt>
            <dd>
              {Object.keys(http?.headers ?? {}).length} header
              {Object.keys(http?.headers ?? {}).length === 1 ? "" : "s"}
              {(http?.body ?? "") === ""
                ? ", no body"
                : `, ${byteLength(http?.body ?? "")}-byte body`}
            </dd>
          </div>
          <div>
            <dt>Timeout</dt>
            <dd>
              {timeout.value}s per request{timeout.defaulted ? " (engine default)" : ""}
            </dd>
          </div>
          <div>
            <dt>Body cap</dt>
            <dd>
              {cap.value} bytes{cap.defaulted ? " (engine default)" : ""}
            </dd>
          </div>
        </dl>
      )}

      {badTarget !== undefined && (
        <Notice>
          “{badTarget}” is not an absolute http(s) URL — the engine rejects the whole config for
          it. Fix it in the form above and copy the settings again.
        </Notice>
      )}
      {saveError !== null && (
        <Notice onDismiss={() => setSaveError(null)}>{saveError}</Notice>
      )}

      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={saving || badTarget !== undefined}
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          onClick={() => set({ http: buildProbeSpec(form) })}
          disabled={!formHasTargets}
          title={
            formHasTargets
              ? "Store the spec from the run form above as the scheduled probe"
              : "The run form has no target, and the engine skips an HTTP probe with none — copying it would quietly stop a schedule that works. Use “Clear the HTTP probe” to do that on purpose."
          }
        >
          Use the probe form's settings
        </button>
        {targets.length > 0 && (
          <button type="button" className="ghost" onClick={() => set({ http: undefined })}>
            Clear the HTTP probe
          </button>
        )}
        <button
          type="button"
          onClick={() => setDraft({ ...(engine.data?.probes ?? {}) })}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function ProbeHistoryCard({ ranAt }: { ranAt: number }) {
  const { goose } = useSdk();
  const [rows, setRows] = useState(200);
  const [route, setRoute] = useState("");
  // Fetched unfiltered and narrowed here: the route dropdown is built from what
  // came back, so asking the engine for one route would leave the dropdown
  // offering nothing but the route already chosen — the reader could not get
  // back to any other one without first resetting.
  const history = useAsync(() => listProbeResults(goose, { n: rows }), [
    goose,
    rows,
    ranAt,
  ]);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [route, rows, ranAt]);

  const items = history.data ?? [];
  const routeChoices = useMemo(
    () =>
      [...new Set(items.map((p) => p.route ?? "").filter((r) => r !== ""))].sort(),
    [items],
  );
  const matched = useMemo(
    () => (route === "" ? items : items.filter((p) => (p.route ?? "") === route)),
    [items, route],
  );
  const visible = matched.slice(0, limit);

  const columns: Array<Column<HTTPProbe>> = [
    { key: "when", header: "Time", className: "nowrap", render: (p) => formatTime(p.startedAt ?? "") },
    { key: "route", header: "Route", className: "mono", render: (p) => p.route || "—" },
    { key: "target", header: "Target", className: "mono", render: (p) => p.target || "—" },
    { key: "method", header: "Method", render: (p) => p.method || "—" },
    {
      key: "status",
      header: "Status",
      className: "nowrap",
      render: (p) =>
        p.success === true ? (
          <span className="pill ok">{p.status ?? 0}</span>
        ) : (
          <span className="pill fail" title={p.error ?? ""}>
            {p.status === undefined || p.status === 0 ? "no response" : p.status}
          </span>
        ),
    },
    {
      key: "latency",
      header: "Latency",
      className: "num",
      render: (p) => (p.success === true ? formatDuration(p.latency ?? 0) : "—"),
    },
    {
      key: "size",
      header: "Body",
      className: "num",
      render: (p) =>
        p.body === undefined || p.body === ""
          ? "—"
          : `${byteLength(p.body)}${p.truncated === true ? "+ (cut)" : ""}`,
    },
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2>History</h2>
        <div className="spacer" />
        <button type="button" onClick={history.reload} disabled={history.loading}>
          {history.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="filter-bar">
        <SelectField
          id="probe-history-route"
          label="Route"
          value={route}
          emptyOption="All routes"
          options={routeChoices}
          onChange={setRoute}
        />
        <SelectField
          id="probe-history-rows"
          label="History depth"
          value={String(rows)}
          options={ROW_OPTIONS.map((r) => ({ value: String(r), label: `last ${r}` }))}
          onChange={(v) => setRows(Number(v))}
        />
      </div>
      <DataTable
        caption="Recorded HTTP probes"
        columns={columns}
        rows={visible}
        rowKey={(p) => `${p.id ?? ""}-${p.startedAt ?? ""}-${p.route ?? ""}`}
        loading={history.loading}
        error={history.error}
        onRetry={history.reload}
        empty={
          items.length > 0 ? (
            <EmptyState
              title={`No probes recorded for “${route}”`}
              hint="The history depth above may not reach back far enough."
              action={
                <button type="button" className="ghost" onClick={() => setRoute("")}>
                  Show all routes
                </button>
              }
            />
          ) : (
            <EmptyState
              title="No probes recorded yet"
              hint="Run one above — by hand, or on a schedule — and every result lands here."
            />
          )
        }
        foot={
          items.length > 0 ? (
            <div className="table-foot">
              <span>
                Showing {visible.length} of {matched.length}
                {matched.length !== items.length ? ` (filtered from ${items.length})` : ""}
              </span>
              <div className="spacer" />
              {matched.length > visible.length && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setLimit(limit + PAGE)}
                >
                  Load {Math.min(PAGE, matched.length - visible.length)} more
                </button>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Name/value rows — request headers and header assertions are the same
 *  shape, and both are edited a row at a time rather than as raw JSON. */
function HeaderList({
  id,
  label,
  values,
  onChange,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  hint,
}: {
  id: string;
  label: string;
  values: Header[];
  onChange: (values: Header[]) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  hint?: string | undefined;
}) {
  const edit = (i: number, p: Partial<Header>) =>
    onChange(values.map((h, j) => (j === i ? { ...h, ...p } : h)));

  return (
    <div className="field">
      <label htmlFor={id} id={`${id}-label`}>
        {label}
      </label>
      <div
        className="arr-editor"
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
      >
        {values.map((h, i) => (
          <div className="item-row split" key={i}>
            <input
              id={i === 0 ? id : undefined}
              type="text"
              className="mono"
              value={h.name}
              placeholder={namePlaceholder}
              aria-label={`${label}, name ${i + 1}`}
              onChange={(e) => edit(i, { name: e.target.value })}
            />
            <input
              type="text"
              className="mono"
              value={h.value}
              placeholder={valuePlaceholder}
              aria-label={`${label}, value ${i + 1}`}
              onChange={(e) => edit(i, { value: e.target.value })}
            />
            <button
              type="button"
              className="ghost icon"
              aria-label={`Remove ${label} row ${i + 1}`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        {values.length === 0 && <div className="arr-empty">None.</div>}
        <button
          type="button"
          onClick={() => onChange([...values, { name: "", value: "" }])}
        >
          {addLabel}
        </button>
      </div>
      {hint !== undefined && (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}
