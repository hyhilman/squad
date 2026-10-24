import { useList } from "@refinedev/core";
import type { UsageBy, UsageRow } from "@squad/contract";
import { useState } from "react";
import { costText, hasCost, totalTokens } from "../lib/format.ts";

const BYS: readonly UsageBy[] = ["account", "task", "flow", "day", "model"];
const SINCES = ["24h", "7d", "30d"] as const;
const nf = new Intl.NumberFormat("en-US");

export function Usage() {
  const [by, setBy] = useState<UsageBy>("account");
  const [since, setSince] = useState<string>("7d");
  const { result, query } = useList<UsageRow & { id: string }>({
    resource: "usage",
    pagination: { mode: "off" },
    filters: [
      { field: "by", operator: "eq", value: by },
      { field: "since", operator: "eq", value: since },
    ],
  });
  const rows = result.data;
  const money = hasCost(rows);
  return (
    <>
      <h1>Usage</h1>
      <div className="row">
        <label>
          Group by{" "}
          <select value={by} onChange={(e) => setBy(e.target.value as UsageBy)}>
            {BYS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label>
          Since{" "}
          <select value={since} onChange={(e) => setSince(e.target.value)}>
            {SINCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {query.isLoading ? <p>Loading…</p> : null}
      {query.isError ? <p className="error">Could not load usage.</p> : null}
      {query.isSuccess && rows.length === 0 ? <p className="muted">No usage in this time.</p> : null}
      {rows.length > 0 ? (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>{by}</th>
                <th className="num">Passes</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache read</th>
                <th className="num">Cache write</th>
                <th className="num">Reasoning</th>
                <th className="num">Total</th>
                {money ? <th className="num">Cost</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.key}</td>
                  <td className="num">{nf.format(r.passes)}</td>
                  <td className="num">{nf.format(r.input)}</td>
                  <td className="num">{nf.format(r.output)}</td>
                  <td className="num">{nf.format(r.cacheRead)}</td>
                  <td className="num">{nf.format(r.cacheWrite)}</td>
                  <td className="num">{nf.format(r.reasoning)}</td>
                  <td className="num">{nf.format(totalTokens(r))}</td>
                  {money ? <td className="num">{costText(r.costUsd)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
