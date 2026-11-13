import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider } from "react-router-dom";
import { Shell } from "./components/shell";
import { Skeleton } from "./components/ui";
import Home from "./pages/Home";
import "./styles.css";

const Programs = lazy(() => import("./pages/Programs"));
const Program = lazy(() => import("./pages/Program"));
const Domain = lazy(() => import("./pages/Domain"));
const NewSubs = lazy(() => import("./pages/NewSubs"));
const Live = lazy(() => import("./pages/Live"));
const Stats = lazy(() => import("./pages/Stats"));
const Downloads = lazy(() => import("./pages/Downloads"));
const Status = lazy(() => import("./pages/Status"));
const Docs = lazy(() => import("./pages/Docs"));

const wrap = (el: React.ReactNode) => <Suspense fallback={<Skeleton className="h-96" />}>{el}</Suspense>;

function NotFound() {
  return (
    <div className="py-24 text-center">
      <p className="label-mono text-muted-foreground">404</p>
      <h1 className="mt-2 text-3xl font-extrabold">Page not found</h1>
      <Link to="/" className="mt-6 inline-block rounded-full border border-border px-4 py-2 text-sm hover:bg-accent">
        Back home
      </Link>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/programs", element: wrap(<Programs />) },
      { path: "/program/:slug", element: wrap(<Program />) },
      { path: "/domain/:domain", element: wrap(<Domain />) },
      { path: "/new", element: wrap(<NewSubs />) },
      { path: "/live", element: wrap(<Live />) },
      { path: "/stats", element: wrap(<Stats />) },
      { path: "/downloads", element: wrap(<Downloads />) },
      { path: "/status", element: wrap(<Status />) },
      { path: "/docs", element: wrap(<Docs />) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
