import { useGetIdentity, useLogout } from "@refinedev/core";
import type { Me } from "@squad/contract";
import { Link, Outlet } from "react-router";

export function Layout() {
  const { data: me } = useGetIdentity<Me>();
  const { mutate: logout, isPending } = useLogout();
  return (
    <>
      <header className="top">
        <nav>
          <Link to="/accounts">Accounts</Link>
          <Link to="/usage">Usage</Link>
        </nav>
        <div className="who">
          <span>{me?.email ?? ""}</span>
          <button type="button" disabled={isPending} onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
