import React from "react";
import { Monitor, Menu, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function Layout({ children }: { children: React.ReactNode }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden relative selection:bg-primary/20">
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] pointer-events-none opacity-50 mix-blend-screen" />
      <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] bg-accent/10 rounded-full blur-[150px] pointer-events-none opacity-40 mix-blend-screen" />

      <div className="flex-1 flex flex-col h-full relative z-10 overflow-hidden">
        <div className="md:hidden flex items-center justify-between p-4 border-b border-border/50 bg-background/50 backdrop-blur-md sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <Monitor className="w-6 h-6 text-primary" />
            <span className="font-bold text-lg" style={{ fontFamily: "var(--font-display)" }}>
              CW Recorder
            </span>
          </div>
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="p-2 rounded-lg bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {isMobileMenuOpen ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </button>
        </div>

        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="md:hidden absolute top-16 left-0 right-0 z-20 bg-background/95 backdrop-blur-md border-b border-border p-4"
            >
              <div className="flex items-center gap-3">
                <Monitor className="w-5 h-5 text-primary" />
                <span className="text-sm text-muted-foreground">CommonWell Recorder</span>
              </div>
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
