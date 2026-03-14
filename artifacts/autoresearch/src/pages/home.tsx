import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useStartResearch } from '@workspace/api-client-react';
import { Sparkles, ArrowRight, BrainCircuit, Globe, FileText, Search } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

export default function Home() {
  const [topic, setTopic] = useState('');
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const { mutate: startResearch, isPending } = useStartResearch({
    mutation: {
      onSuccess: (data) => {
        setLocation(`/session/${data.sessionId}`);
      },
      onError: (error: any) => {
        toast({
          title: "Failed to start research",
          description: error.message || "Please try again later.",
          variant: "destructive"
        });
      }
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || isPending) return;
    
    startResearch({ data: { topic: topic.trim() } });
  };

  const sampleTopics = [
    "What are the latest breakthroughs in solid-state batteries?",
    "How does Transformer architecture compare to Mamba?",
    "Economic impact of AGI on creative industries",
    "Current state of nuclear fusion research 2026"
  ];

  return (
    <div className="relative min-h-full flex flex-col items-center justify-center p-6 md:p-12 lg:p-24 overflow-hidden">
      
      {/* Embedded Background Image if available, otherwise fallback to CSS glows */}
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none flex items-center justify-center">
        <img 
          src={`${import.meta.env.BASE_URL}images/hero-glow.png`} 
          alt="Abstract Glow" 
          className="w-full h-full object-cover mix-blend-screen scale-110"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      </div>

      <div className="relative z-10 w-full max-w-4xl mx-auto flex flex-col items-center">
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="text-center mb-12 flex flex-col items-center"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-8 shadow-2xl">
            <Sparkles className="w-4 h-4 text-primary animate-pulse-slow" />
            <span className="text-sm font-medium tracking-wide text-foreground/80">Autonomous Deep Research Agent</span>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-display font-extrabold tracking-tight mb-6">
            Research <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent glow-text">Anything</span>
          </h1>
          
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl font-light">
            Enter a topic or complex question. The agent will autonomously break it down, search the web, analyze sources, and synthesize a comprehensive report.
          </p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="w-full max-w-3xl"
        >
          <form onSubmit={handleSubmit} className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-primary/30 to-accent/30 rounded-3xl blur-xl opacity-20 group-hover:opacity-40 transition duration-500" />
            
            <div className="relative flex items-center bg-card/80 backdrop-blur-xl border-2 border-border group-hover:border-primary/50 focus-within:border-primary rounded-2xl p-2 shadow-2xl transition-all duration-300">
              <div className="pl-4 pr-2">
                <Search className="w-6 h-6 text-muted-foreground group-focus-within:text-primary transition-colors" />
              </div>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What do you want to learn about?"
                className="flex-1 bg-transparent border-none text-lg md:text-xl text-foreground placeholder:text-muted-foreground/50 focus:ring-0 focus:outline-none py-4 px-2"
                disabled={isPending}
              />
              <button
                type="submit"
                disabled={!topic.trim() || isPending}
                className={cn(
                  "flex items-center gap-2 px-6 py-4 rounded-xl font-bold transition-all duration-300 shadow-lg",
                  topic.trim() && !isPending
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-primary/25 hover:-translate-y-0.5"
                    : "bg-secondary text-muted-foreground cursor-not-allowed"
                )}
              >
                {isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <span className="hidden sm:inline">Start Research</span>
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Quick suggestions */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <span className="text-sm text-muted-foreground mr-2">Try asking:</span>
            {sampleTopics.map((sample, idx) => (
              <button
                key={idx}
                onClick={() => setTopic(sample)}
                className="text-xs px-3 py-1.5 rounded-full border border-border/50 bg-secondary/30 text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/10 transition-colors"
              >
                {sample}
              </button>
            ))}
          </div>
        </motion.div>

        {/* Feature Highlights */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-24 w-full"
        >
          {[
            { icon: BrainCircuit, title: "Intelligent Planning", desc: "Breaks complex topics into structured sub-queries" },
            { icon: Globe, title: "Autonomous Search", desc: "Scours the web in real-time for current information" },
            { icon: FileText, title: "Deep Synthesis", desc: "Generates comprehensive, well-cited markdown reports" }
          ].map((feature, i) => (
            <div key={i} className="flex flex-col items-center text-center p-6 rounded-2xl bg-secondary/20 border border-border/50 backdrop-blur-sm">
              <div className="w-12 h-12 rounded-xl bg-background border border-border flex items-center justify-center mb-4 shadow-inner">
                <feature.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-display font-semibold mb-2">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.desc}</p>
            </div>
          ))}
        </motion.div>

      </div>
    </div>
  );
}
