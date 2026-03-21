import React from "react";
import { Activity, Menu, X, FlaskConical, Clock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, Link } from "wouter";

const NAV_ITEMS = [
  { href: "/", label: "Recorder", icon: Activity },
  { href: "/par-demo", label: "PAR Demo", icon: FlaskConical },
  { href: "/hourly-monitor", label: "Monitor", icon: Clock },
];

function navClass(active: boolean) {
  return `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
    active
      ? "bg-primary/10 text-primary border border-primary/20"
      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
  }`;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [location] = useLocation();

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative selection:bg-primary/20">
      {/* CVS red ambient glow */}
      <div className="absolute top-0 left-1/3 w-[600px] h-[400px] bg-primary/8 rounded-full blur-[140px] pointer-events-none opacity-60" />
      <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-accent/6 rounded-full blur-[160px] pointer-events-none opacity-40" />

      <div className="flex-1 flex flex-col h-full relative z-10 overflow-hidden">
        {/* CVS brand top bar — 3px red stripe */}
        <div className="cvs-top-bar h-[3px] w-full shrink-0" />

        {/* Desktop header with nav tabs */}
        <div className="hidden md:flex items-center justify-between px-4 py-2 border-b border-border/50 bg-background/80 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
              CDR Observability
            </span>
          </div>
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? location === "/" : location.startsWith(href);
              return (
                <Link key={href} href={href} className={navClass(active)}>
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Mobile header */}
        <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border/50 bg-background/80 backdrop-blur-md sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-base tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
              CDR Observability
            </span>
          </div>
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="p-2 rounded-lg bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="md:hidden absolute top-[52px] left-0 right-0 z-20 bg-background/95 backdrop-blur-md border-b border-border p-4"
            >
              <nav className="flex flex-col gap-1">
                {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                  const active = href === "/" ? location === "/" : location.startsWith(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={navClass(active)}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </Link>
                  );
                })}
              </nav>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="flex-1 overflow-y-auto w-full h-full">
          {children}
        </main>
      </div>
    </div>
  );
}
