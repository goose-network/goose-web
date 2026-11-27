// src/components/ProbeResultsTable.test.ts — the shared result-column
// builder: the column set every HTTP-probe table renders (run results,
// probe history, full-probe attempt rows), the optional Depth column only
// the attempt rows carry, and the folded Response detail's emptiness rule.
// No DOM: the builder is a plain function and the renderers are called
// directly, the way ChipPicker's tests exercise its pure exports.

import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import {
  phaseTimingRows,
  probeResultColumns,
  ResponseDetail,
} from "./ProbeResultsTable";
import type { HTTPProbe } from "../runApi";

/** The renderers return ReactNode; the ones asserted here are elements
 *  with known props, so narrow through one cast in one place. */
interface Props {
  className?: string;
  children?: ReactNode;
  title?: string;
}
const el = (n: ReactNode) => n as ReactElement<Props>;

const keys = (opts?: { depth?: boolean }) =>
  probeResultColumns(opts).map((c) => c.key);

describe("probeResultColumns", () => {
  it("the shared column set, in table order", () => {
    expect(keys()).toEqual([
      "when",
      "route",
      "target",
      "path",
      "method",
      "status",
      "failure",
      "latency",
      "size",
      "response",
    ]);
  });

  it("the depth option inserts Depth right after Time — and only then", () => {
    expect(keys({ depth: true })).toEqual([
      "when",
      "depth",
      "route",
      "target",
      "path",
      "method",
      "status",
      "failure",
      "latency",
      "size",
      "response",
    ]);
    expect(keys({ depth: false })).toEqual(keys());
  });

  it("every column has a header and a callable renderer", () => {
    for (const c of probeResultColumns({ depth: true })) {
      expect(c.header).toBeTruthy();
      expect(typeof c.render).toBe("function");
      // A bare row must render without throwing — older engines omit most
      // fields, and the table is exactly where those rows surface.
      expect(() => c.render({})).not.toThrow();
    }
  });
});

describe("the Depth column", () => {
  const depthCol = () => probeResultColumns({ depth: true })[1]!;
  it("prints the chain length when the row carries it", () => {
    expect(depthCol().render({ depth: 2 })).toBe(2);
  });
  it("absent or zero reads as —, not an invented 0-depth measurement", () => {
    expect(depthCol().render({})).toBe("—");
    expect(depthCol().render({ depth: 0 })).toBe("—");
  });
});

describe("the Status and Failure columns", () => {
  const col = (key: string) => probeResultColumns().find((c) => c.key === key)!;
  it("a success shows the status in an ok pill", () => {
    const ok = el(col("status").render({ success: true, status: 204 }));
    expect(ok.props.className).toBe("pill ok");
    expect(ok.props.children).toBe(204);
  });
  it("a failure with no response says so rather than printing 0", () => {
    const nores = el(col("status").render({ success: false, status: 0, error: "dial refused" }));
    expect(nores.props.className).toBe("pill fail");
    expect(nores.props.children).toBe("no response");
    expect(nores.props.title).toBe("dial refused");
  });
  it("a success has no failure label; a classified failure carries its words", () => {
    expect(col("failure").render({ success: true })).toBe("—");
    const fail = el(
      col("failure").render({
        success: false,
        error: "i/o timeout",
        phase: "connect",
        reason: "connect_timeout",
        route: "outbound:a",
      }),
    );
    expect(fail.props.className).toBe("pill fail");
    expect(fail.props.children).toBe("connect timed out");
  });
});

describe("the Body column", () => {
  const sizeCol = () => probeResultColumns().find((c) => c.key === "size")!;
  it("counts bytes, not characters, and flags a cut body", () => {
    expect(sizeCol().render({ body: "héllo", truncated: true })).toBe("6+ (cut)");
    expect(sizeCol().render({})).toBe("—");
  });
});

describe("ResponseDetail", () => {
  it("a row with nothing to show folds to 'empty', not an empty details box", () => {
    const empty = el(ResponseDetail({ probe: {} }));
    expect(empty.type).toBe("span");
    expect(empty.props.children).toBe("empty");
  });
  it("a body alone opens the fold with its character count", () => {
    const fold = el(ResponseDetail({ probe: { body: "abc" } }));
    expect(fold.type).toBe("details");
  });
});

describe("phaseTimingRows", () => {
  it("keeps the observed phases in path order, dropping zeros and absences", () => {
    const p: HTTPProbe = { routeDial: 5, dns: 0, connect: 3, tls: 2, ttfb: 9 };
    expect(phaseTimingRows(p)).toEqual([
      ["route dial", 5],
      ["connect", 3],
      ["TLS", 2],
      ["first byte", 9],
    ]);
    expect(phaseTimingRows({})).toEqual([]);
  });
});
