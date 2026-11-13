import { AnimatePresence, motion } from "framer-motion";
import { Menu, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { EASE } from "./ui";

const NAV = [
  { to: "/programs", label: "Programs" },
  { to: "/new", label: "New subs" },
  { to: "/live", label: "Live hosts" },
  { to: "/stats", label: "Stats" },
  { to: "/downloads", label: "Downloads" },
  { to: "/status", label: "Status" },
  { to: "/docs", label: "API" },
];

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("chaos-theme", dark ? "dark" : "light");
    } catch {
      /* storage blocked */
    }
  }, [dark]);
  return (
    <button
      onClick={() => setDark((d) => !d)}
      aria-label="Toggle theme"
      className="grid size-9 place-items-center rounded-full border border-border transition-colors hover:bg-accent"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function Shell() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-5">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-xl font-extrabold tracking-tight">Chaos.</span>
            <span className="label-mono rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">free</span>
          </Link>
          <nav className="hidden items-center gap-1 text-sm text-muted-foreground lg:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `relative rounded-full px-3 py-1.5 transition-colors hover:text-foreground ${isActive ? "text-foreground" : ""}`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span layoutId="nav-pill" className="absolute inset-0 -z-10 rounded-full bg-accent" transition={{ type: "spring", stiffness: 420, damping: 32 }} />
                    )}
                    {n.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <button
              className="grid size-9 place-items-center rounded-full border border-border lg:hidden"
              onClick={() => setOpen((o) => !o)}
              aria-label="Menu"
            >
              {open ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          </div>
        </div>
        <AnimatePresence>
          {open && (
            <motion.nav
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-t border-border lg:hidden"
            >
              <div className="mx-auto grid max-w-6xl grid-cols-2 gap-1 px-4 py-3">
                {NAV.map((n) => (
                  <NavLink key={n.to} to={n.to} className="rounded-lg px-3 py-2 text-sm hover:bg-accent">
                    {n.label}
                  </NavLink>
                ))}
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-5"
        >
          <Outlet />
        </motion.main>
      </AnimatePresence>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p>
            <span className="font-extrabold text-foreground">Chaos.</span> Runs on Cloudflare's free plan. Data from{" "}
            <a className="story-link text-foreground" href="https://chaos.projectdiscovery.io" target="_blank" rel="noreferrer">
              ProjectDiscovery Chaos
            </a>
            .
          </p>
          <div className="label-mono flex flex-wrap gap-4">
            <Link to="/new" className="story-link hover:text-foreground">New subs</Link>
            <Link to="/live" className="story-link hover:text-foreground">Live</Link>
            <Link to="/downloads" className="story-link hover:text-foreground">Downloads</Link>
            <Link to="/docs" className="story-link hover:text-foreground">API</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
