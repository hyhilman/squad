// The web app: Chakra UI on React Router, server data through TanStack Query and the contract's `call`.
import "@fontsource-variable/inter/wght.css";
import { CacheProvider } from "@emotion/react";
import { Center, ChakraProvider, Spinner } from "@chakra-ui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiFailure } from "@squad/contract";
import { signInPlan } from "./lib/signin.ts";
import { SignInCard } from "./ui/SignInCard.tsx";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Account } from "./pages/Account.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Catalog } from "./pages/Catalog.tsx";
import { CatalogModel } from "./pages/CatalogModel.tsx";
import { CatalogProvider } from "./pages/CatalogProvider.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Passes } from "./pages/Passes.tsx";
import { Usage } from "./pages/Usage.tsx";
import { queryClient, useMe } from "./queries.ts";
import { emotionCache } from "./ui/emotion.ts";
import { ErrorBlock } from "./ui/parts.tsx";
import { Shell } from "./ui/Shell.tsx";
import { system } from "./ui/system.ts";
import { Toaster } from "./ui/toaster.tsx";
import "./ui/colorMode.ts";

function Gate() {
  const me = useMe();
  if (me.isError && me.error instanceof ApiFailure && me.error.status === 401) {
    const plan = signInPlan(window, window.location.pathname, window.location.search);
    // A top-level page is already on its way to /auth/login (queries.ts).
    if (plan.kind === "popup") return <SignInCard url={plan.url} />;
  }
  if (me.isPending || me.isError && me.error instanceof ApiFailure && me.error.status === 401) {
    return (
      <Center py="24">
        <Spinner color="fg.subtle" />
      </Center>
    );
  }
  if (me.isError) {
    return (
      <Center py="24" px="4">
        <ErrorBlock error={me.error} onRetry={() => void me.refetch()} />
      </Center>
    );
  }
  return (
    <Shell me={me.data}>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:runner/:name" element={<Account />} />
        <Route path="/passes" element={<Passes />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/catalog/models/*" element={<CatalogModel />} />
        <Route path="/catalog/:provider" element={<CatalogProvider />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <CacheProvider value={emotionCache}>
      <ChakraProvider value={system}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
          <Toaster />
        </QueryClientProvider>
      </ChakraProvider>
    </CacheProvider>
  );
}
