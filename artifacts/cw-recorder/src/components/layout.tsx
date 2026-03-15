import React from "react";
import { Link, useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  Monitor,
  Play,
  History,
  Menu,
  X,
  Shield,
  ChevronRight,
  Database,
  AlertTriangle,
  CheckCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface CwRun {
  id: string;
  status: string;
  recordCount: number | null;
  errorCount: number | null;
  startedAt: string;
  completedAt: string | null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [runs, setRuns] = React.useState<CwRun[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    const fetchRuns = async () => {
      try {
        const base = import.meta.env.BASE_URL.replace(/\/$/, "");
        const res = await fetch(`${base}/api/cw/runs`);
        if (res.ok) {
          const data = await res.json();
          setRuns(data.runs || []);
        }
      } catch {
      } finally {
        setIsLoading(false);
      }
    };
    fetchRuns();
    const interval = setInterval(fetchRuns, 10000);
    return () => clearInterval(interval);
  }, []);

  const toggleMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);
  const closeMenu = () => setIsMobileMenuOpen(false);

  const statusIcon = (status: string) => {
    if (status === "complete")
      return <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />;
    if (status === "error" || status === "failed")
      return <AlertTriangle className="w-3.5 h-3.5 text-destructive" />;
    return (
      <span className="w-2 h-2 rounded-full bg-primary animate-pulse inline-block" />
    );
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-card/50 backdrop-blur-xl border-r border-border">
      <div className="p-6 flex items-center gap-3 border-b border-border/50">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/20 shadow-lg shadow-primary/10">
          <Monitor className="w-5 h-5 text-primary" />
        </div>
        <span className="font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60"
          style={{ fontFamily: "var(--font-display)" }}>
          CW Recorder
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <Link href="/" onClick={closeMenu} className="group block">
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-sm transition-all hover:bg-primary/20 hover:shadow-primary/20 hover:shadow-md">
            <Play className="w-5 h-5" />
            <span className="font-semibold">New Run</span>
          </div>
        </Link>

        <div>
          <div className="flex items-center gap-2 px-2 mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
            <History className="w-4 h-4" />
            <span>Run History</span>
          </div>

          {isLoading ? (
            <div className="space-y-2 px-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-16 rounded-lg bg-secondary/50 animate-pulse"
                />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="px-2 py-8 text-center flex flex-col items-center gap-2 text-muted-foreground">
              <Database className="w-8 h-8 opacity-20" />
              <p className="text-sm">No runs yet</p>
            </div>
          ) : (
            <div className="space-y-1">
              {runs.map((run) => {
                const isActive = location === `/run/${run.id}`;
                return (
                  <Link
                    href={`/run/${run.id}`}
                    key={run.id}
                    onClick={closeMenu}
                    className="block"
                  >
                    <div
                      className={`group relative p-3 rounded-xl transition-all duration-200 border border-transparent ${
                        isActive
                          ? "bg-secondary/80 border-border shadow-sm"
                          : "hover:bg-secondary/40 hover:border-border/50"
                      }`}
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          {statusIcon(run.status)}
                          <span
                            className={`text-sm font-medium line-clamp-1 leading-tight transition-colors ${
                              isActive
                                ? "text-foreground"
                                : "text-muted-foreground group-hover:text-foreground/90"
                            }`}
                          >
                            {run.recordCount ?? 0} records
                            {(run.errorCount ?? 0) > 0 &&
                              ` (${run.errorCount} errors)`}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground/60">
                            {formatDistanceToNow(new Date(run.startedAt), {
                              addSuffix: true,
                            })}
                          </span>
                          <ChevronRight
                            className={`w-4 h-4 transition-transform duration-300 ${
                              isActive
                                ? "text-primary translate-x-1"
                                : "text-muted-foreground/30 group-hover:translate-x-0.5"
                            }`}
                          />
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative selection:bg-primary/20">
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] pointer-events-none opacity-50 mix-blend-screen" />
      <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] bg-accent/10 rounded-full blur-[150px] pointer-events-none opacity-40 mix-blend-screen" />

      <div className="hidden md:block w-80 shrink-0 h-full relative z-10">
        <SidebarContent />
      </div>

      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeMenu}
              className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 md:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 left-0 w-80 bg-background z-50 md:hidden shadow-2xl border-r border-border"
            >
              <SidebarContent />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col h-full relative z-10 overflow-hidden">
        <div className="md:hidden flex items-center justify-between p-4 border-b border-border/50 bg-background/50 backdrop-blur-md sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <Monitor className="w-6 h-6 text-primary" />
            <span className="font-bold text-lg" style={{ fontFamily: "var(--font-display)" }}>
              CW Recorder
            </span>
          </div>
          <button
            onClick={toggleMenu}
            className="p-2 rounded-lg bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {isMobileMenuOpen ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </button>
        </div>

        <main className="flex-1 overflow-y-auto w-full h-full">
          {children}
        </main>
      </div>
    </div>
  );
}
