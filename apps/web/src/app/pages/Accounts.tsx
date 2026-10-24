import { useList } from "@refinedev/core";
import type { AccountView } from "@squad/contract";
import { Link } from "react-router";
import { Room } from "../Meter.tsx";
import { agoText, roomByRunner } from "../lib/format.ts";

/** The accounts the signed-in person may see: their own, or all for an admin. */
export function Accounts() {
  const { result, query } = useList<AccountView & { id: string }>({ resource: "accounts", pagination: { mode: "off" } });
  if (query.isLoading) return <p>Loading…</p>;
  if (query.isError) return <p className="error">Could not load accounts.</p>;
  const now = new Date();
  const rooms = roomByRunner(result.data);
  return (
    <>
      <h1>Accounts</h1>
      <ul className="rooms">
        {rooms.map((r) => (
          <li key={r.runner}>
            <strong>{r.runner}</strong>: {r.accounts} account{r.accounts === 1 ? "" : "s"}.{" "}
            {r.read === 0 ? (
              <span className="muted">No usage read yet.</span>
            ) : (
              <span>
                Room left on average ({r.read} read): 5-hour {r.left5h ?? "?"}%, week {r.leftWeek ?? "?"}%.
              </span>
            )}
          </li>
        ))}
      </ul>
      {result.data.length === 0 ? <p className="muted">No accounts.</p> : null}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Kind</th>
              <th>State</th>
              <th>Health</th>
              <th>5-hour left</th>
              <th>Week left</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link to={`/accounts/${a.account}`}>{a.account}</Link>
                </td>
                <td>{a.kind}</td>
                <td>{a.busy ? "busy" : "idle"}</td>
                <td>{a.health}</td>
                <td>
                  <Room value={a.left5h} />
                </td>
                <td>
                  <Room value={a.leftWeek} />
                </td>
                <td>{agoText(a.readAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
