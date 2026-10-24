// The web app: Refine core (headless; no UI kit) under React Router. Pages are plain React.
import { Authenticated, Refine } from "@refinedev/core";
import routerProvider from "@refinedev/react-router";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./app.css";
import { authProvider } from "./authProvider.ts";
import { dataProvider } from "./dataProvider.ts";
import { Layout } from "./Layout.tsx";
import { Account } from "./pages/Account.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Usage } from "./pages/Usage.tsx";

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
          {/* Not signed in: the authProvider's check sends the browser to /auth/login. */}
          <Route
            element={
              <Authenticated key="app" redirectOnFail="/auth/login">
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
