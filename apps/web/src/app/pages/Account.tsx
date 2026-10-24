import { useQueryClient } from "@tanstack/react-query";
import { useOne } from "@refinedev/core";
import type { AccountView, Runner } from "@squad/contract";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { Room } from "../Meter.tsx";
import { failureText, isNotReady } from "../lib/errors.ts";
import { floorBody } from "../lib/floors.ts";
import { agoText } from "../lib/format.ts";

type Notice = { kind: "ok" | "error"; text: string } | undefined;

export function Account() {
  const { runner, name } = useParams();
  const id = `${runner}/${name}`;
  const { result, query } = useOne<AccountView & { id: string }>({ resource: "accounts", id });
  const qc = useQueryClient();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [f5, setF5] = useState<string | undefined>();
  const [fw, setFw] = useState<string | undefined>();

  if (query.isLoading) return <p>Loading…</p>;
  if (query.isError || result === undefined) return <p className="error">Could not load this account.</p>;
  const a = result;
  const params = { runner: a.runner as Runner, name: a.name };
  const shown5 = f5 ?? (a.floorSource === "owner" ? String(a.floor5h) : "");
  const shownW = fw ?? (a.floorSource === "owner" ? String(a.floorWeek) : "");

  // One guard for every action: show the plain error, refresh the account on success.
  const run = async (ok: string, act: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await act();
      await qc.invalidateQueries();
      setF5(undefined);
      setFw(undefined);
      setNotice({ kind: "ok", text: ok });
    } catch (e) {
      setNotice({ kind: "error", text: failureText(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveFloors = (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    const b = floorBody(shown5, shownW);
    if (!b.ok) return setNotice({ kind: "error", text: b.errors.join(" ") });
    void run("Floors saved.", () => api("setFloor", { params, body: b.body }));
  };

  const toggle = () => {
    const to = a.health === "disabled";
    if (!window.confirm(to ? `Enable ${a.account}?` : `Disable ${a.account}? No pass will use it until you enable it again.`)) return;
    void run(to ? "Account enabled." : "Account disabled.", () => api("setEnabled", { params, body: { enabled: to } }));
  };

  const login = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const s = await api("startLogin", { params });
      setNotice({ kind: "ok", text: `Open ${s.verifyUrl} and enter the code ${s.userCode}.` });
    } catch (e) {
      setNotice(
        isNotReady(e)
          ? { kind: "error", text: `Web login is not available yet; run \`squad login ${a.account}\` on the host.` }
          : { kind: "error", text: failureText(e) },
      );
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  return (
    <>
      <p>
        <Link to="/accounts">Back to accounts</Link>
      </p>
      <h1>{a.account}</h1>
      {notice === undefined ? null : <p className={`notice ${notice.kind}`}>{notice.text}</p>}
      <dl className="facts">
        <dt>Kind</dt>
        <dd>{a.kind}</dd>
        <dt>Owner</dt>
        <dd>{a.ownerEmail}</dd>
        <dt>Pools</dt>
        <dd>{a.pools.length === 0 ? "none" : a.pools.join(", ")}</dd>
        <dt>State</dt>
        <dd>{a.busy ? "busy (a pass holds it)" : "idle"}</dd>
        <dt>Health</dt>
        <dd>
          {a.health}
          {a.lastCode === undefined ? "" : ` (${a.lastCode})`}
          {a.coolUntil === undefined ? "" : `, cooling until ${a.coolUntil}`}
        </dd>
        <dt>5-hour left</dt>
        <dd>
          <Room value={a.left5h} />
        </dd>
        <dt>Week left</dt>
        <dd>
          <Room value={a.leftWeek} />
        </dd>
        <dt>Last read</dt>
        <dd>{agoText(a.readAt, now)}</dd>
        <dt>Floors</dt>
        <dd>
          5-hour {a.floor5h}%, week {a.floorWeek}% ({a.floorSource})
        </dd>
        <dt>Consent</dt>
        <dd>{a.consentAt === undefined ? "not given" : `given ${a.consentAt}`}</dd>
      </dl>

      <h2>Floors</h2>
      <p className="muted">The percent of each window to keep free. Leave a box empty to use the default.</p>
      <form className="floors" onSubmit={saveFloors}>
        <label>
          5-hour floor (%)
          <input inputMode="numeric" value={shown5} onChange={(e) => setF5(e.target.value)} placeholder="default" />
        </label>
        <label>
          Week floor (%)
          <input inputMode="numeric" value={shownW} onChange={(e) => setFw(e.target.value)} placeholder="default" />
        </label>
        <div>
          <button type="submit" disabled={busy}>
            Save floors
          </button>
        </div>
      </form>

      <h2>Actions</h2>
      <div className="row">
        <button type="button" disabled={busy} onClick={toggle}>
          {a.health === "disabled" ? "Enable" : "Disable"}
        </button>
        {a.consentAt === undefined ? (
          <button type="button" disabled={busy} onClick={() => void run("Consent recorded.", () => api("consent", { params, body: { agree: true } }))}>
            Give consent
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void login()}>
          Log in again
        </button>
      </div>
    </>
  );
}
