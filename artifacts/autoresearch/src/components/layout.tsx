import React from 'react';
import { Link, useLocation } from 'wouter';
import { useListResearchSessions } from '@workspace/api-client-react';
import { formatDistanceToNow } from 'date-fns';
import { 
  Network, 
  Search, 
  History, 
  Menu, 
  X,
  Sparkles,
  ChevronRight,
  Database
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  
  const { data: sessionData, isLoading } = useListResearchSessions({
    query: {
      refetchInterval: 10000 // Refetch every 10s to keep sidebar fresh
    }
  });

  const sessions = sessionData?.sessions || [];

  const toggleMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);
  const closeMenu = () => setIsMobileMenuOpen(false);

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-card/50 backdrop-blur-xl border-r border-border">
      <div className="p-6 flex items-center gap-3 border-b border-border/50">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/20 shadow-lg shadow-primary/10">
          <Network className="w-5 h-5 text-primary" />
        </div>
        <span className="font-display font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
          AutoResearch
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <Link href="/" onClick={closeMenu} className="group block">
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/10 text-primary border border-primary/20 shadow-sm transition-all hover:bg-primary/20 hover:shadow-primary/20 hover:shadow-md">
            <Sparkles className="w-5 h-5" />
            <span className="font-semibold">New Research</span>
          </div>
        </Link>

        <div>
          <div className="flex items-center gap-2 px-2 mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
            <History className="w-4 h-4" />
            <span>Recent Sessions</span>
          </div>
          
          {isLoading ? (
            <div className="space-y-2 px-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-lg bg-secondary/50 animate-pulse" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-8 text-center flex flex-col items-center gap-2 text-muted-foreground">
              <Database className="w-8 h-8 opacity-20" />
              <p className="text-sm">No research history yet</p>
            </div>
          ) : (
            <div className="space-y-1">
              {sessions.map((session) => {
                const isActive = location === `/session/${session.id}`;
                return (
                  <Link href={`/session/${session.id}`} key={session.id} onClick={closeMenu} className="block">
                    <div className={cn(
                      "group relative p-3 rounded-xl transition-all duration-200 border border-transparent",
                      isActive 
                        ? "bg-secondary/80 border-border shadow-sm" 
                        : "hover:bg-secondary/40 hover:border-border/50"
                    )}>
                      <div className="flex flex-col gap-1.5">
                        <span className={cn(
                          "text-sm font-medium line-clamp-2 leading-tight transition-colors",
                          isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground/90"
                        )}>
                          {session.topic}
                        </span>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground/60 flex items-center gap-1.5">
                            <span className={cn(
                              "w-1.5 h-1.5 rounded-full",
                              session.status === 'complete' ? "bg-emerald-500" :
                              session.status === 'running' ? "bg-primary animate-pulse" :
                              session.status === 'error' ? "bg-destructive" : "bg-muted-foreground"
                            )} />
                            {formatDistanceToNow(new Date(session.createdAt), { addSuffix: true })}
                          </span>
                          <ChevronRight className={cn(
                            "w-4 h-4 transition-transform duration-300",
                            isActive ? "text-primary translate-x-1" : "text-muted-foreground/30 group-hover:translate-x-0.5 group-hover:text-muted-foreground/60"
                          )} />
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
      {/* Decorative background effects */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] pointer-events-none opacity-50 mix-blend-screen" />
      <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] bg-accent/10 rounded-full blur-[150px] pointer-events-none opacity-40 mix-blend-screen" />

      {/* Desktop Sidebar */}
      <div className="hidden md:block w-80 shrink-0 h-full relative z-10">
        <SidebarContent />
      </div>

      {/* Mobile Menu Overlay */}
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

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full relative z-10 overflow-hidden">
        {/* Mobile Header */}
        <div className="md:hidden flex items-center justify-between p-4 border-b border-border/50 bg-background/50 backdrop-blur-md sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <Network className="w-6 h-6 text-primary" />
            <span className="font-display font-bold text-lg">AutoResearch</span>
          </div>
          <button 
            onClick={toggleMenu}
            className="p-2 rounded-lg bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Scrollable Content */}
        <main className="flex-1 overflow-y-auto w-full h-full custom-scrollbar">
          {children}
        </main>
      </div>
    </div>
  );
}
