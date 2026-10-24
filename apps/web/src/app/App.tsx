// The web app: Refine core with Ant Design (@refinedev/antd) under React Router.
import { useEffect } from "react";
import { Authenticated, Refine, useGetIdentity, useLogout } from "@refinedev/core";
import { ThemedLayout, ThemedSider, ThemedTitle, useNotificationProvider } from "@refinedev/antd";
import { BarChartOutlined, HistoryOutlined, TeamOutlined } from "@ant-design/icons";
import routerProvider from "@refinedev/react-router";
import type { Me } from "@squad/contract";
import { App as AntApp, Button, ConfigProvider, Flex, Tag, Typography, theme as antdTheme } from "antd";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router";
import "@refinedev/antd/dist/reset.css";
import "./app.css";
import { authProvider } from "./authProvider.ts";
import { dataProvider } from "./dataProvider.ts";
import { signInUrl } from "./lib/signin.ts";
import { Account } from "./pages/Account.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Pass } from "./pages/Pass.tsx";
import { Passes } from "./pages/Passes.tsx";
import { Usage } from "./pages/Usage.tsx";
import { themeFor, styleNonce, useSystemDark } from "./theme.tsx";

function SignIn() {
  useEffect(() => {
    window.location.assign(signInUrl(window.location.pathname, window.location.search));
  }, []);
  return null;
}

// The sider draws its own title, so it needs ours too, or it shows Refine's name and logo.
function SquadTitle({ collapsed }: { collapsed: boolean }) {
  return <ThemedTitle collapsed={collapsed} text="squad" icon={<TeamOutlined />} />;
}

function Header() {
  const { data: me } = useGetIdentity<Me>();
  const { mutate: logout, isPending } = useLogout();
  const { token } = antdTheme.useToken();
  return (
    <Flex justify="flex-end" align="center" gap="small" wrap style={{ padding: "0 16px", minHeight: 64, background: token.colorBgElevated, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <Typography.Text style={{ overflowWrap: "anywhere" }}>{me?.email ?? ""}</Typography.Text>
      {me?.admin === true ? <Tag color="gold">admin</Tag> : null}
      <Button loading={isPending} onClick={() => logout()}>
        Sign out
      </Button>
    </Flex>
  );
}

export default function App() {
  const dark = useSystemDark();
  return (
    <BrowserRouter>
      <ConfigProvider theme={themeFor(dark)} csp={{ nonce: styleNonce() }}>
        <AntApp>
          <Refine
            dataProvider={dataProvider}
            authProvider={authProvider}
            routerProvider={routerProvider}
            notificationProvider={useNotificationProvider}
            resources={[
              // An account id is `<runner>/<name>`, so its page path has two segments.
              { name: "accounts", list: "/accounts", show: "/accounts/:id", meta: { label: "Accounts", icon: <TeamOutlined /> } },
              { name: "passes", list: "/passes", show: "/passes/:id", meta: { label: "Passes", icon: <HistoryOutlined /> } },
              { name: "usage", list: "/usage", meta: { label: "Usage", icon: <BarChartOutlined /> } },
            ]}
            options={{ disableTelemetry: true }}
          >
            <Routes>
              {/* Not signed in: SignIn does a full page load to /auth/login, never a router move. */}
              <Route
                element={
                  <Authenticated key="app" fallback={<SignIn />}>
                    <ThemedLayout
                      Header={Header}
                      Title={SquadTitle}
                      Sider={() => <ThemedSider Title={SquadTitle} render={({ items }) => items} />}
                    >
                      <Outlet />
                    </ThemedLayout>
                  </Authenticated>
                }
              >
                <Route index element={<Navigate to="/accounts" replace />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/accounts/:runner/:name" element={<Account />} />
                <Route path="/passes" element={<Passes />} />
                <Route path="/passes/:passId" element={<Pass />} />
                <Route path="/usage" element={<Usage />} />
                <Route path="*" element={<Navigate to="/accounts" replace />} />
              </Route>
            </Routes>
          </Refine>
        </AntApp>
      </ConfigProvider>
    </BrowserRouter>
  );
}
