// The web app: Refine core (headless; no UI kit) under React Router. Pages are plain React.
import { useEffect } from "react";
import { Authenticated, Refine } from "@refinedev/core";
import routerProvider from "@refinedev/react-router";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./app.css";
import { authProvider } from "./authProvider.ts";
import { dataProvider } from "./dataProvider.ts";
import { signInUrl } from "./lib/signin.ts";
import { Layout } from "./Layout.tsx";
import { Account } from "./pages/Account.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Usage } from "./pages/Usage.tsx";

function SignIn() {
  useEffect(() => {
    window.location.assign(signInUrl(window.location.pathname, window.location.search));
  }, []);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <Refine
        dataProvider={dataProvider}
        authProvider={authProvider}
        routerProvider={routerProvider}
        resources={[
          // An account id is `<runner>/<name>`, so its page path has two segments.
          { name: "accounts", list: "/accounts", show: "/accounts/:id" },
          { name: "usage", list: "/usage" },
        ]}
        options={{ disableTelemetry: true }}
      >
        <Routes>
          {/* Not signed in: SignIn does a full page load to /auth/login, never a router move. */}
          <Route
            element={
              <Authenticated key="app" fallback={<SignIn />}>
                <Layout />
              </Authenticated>
            }
          >
            <Route index element={<Navigate to="/accounts" replace />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/accounts/:runner/:name" element={<Account />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="*" element={<Navigate to="/accounts" replace />} />
          </Route>
        </Routes>
      </Refine>
    </BrowserRouter>
  );
}
