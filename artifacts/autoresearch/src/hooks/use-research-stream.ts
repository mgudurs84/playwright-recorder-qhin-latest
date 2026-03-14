import { useState, useEffect } from 'react';
import { ResearchStep } from '@workspace/api-client-react';

export function useResearchStream(sessionId: string | undefined, enabled: boolean = true) {
  const [streamedSteps, setStreamedSteps] = useState<ResearchStep[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    
    let mounted = true;
    const controller = new AbortController();

    const startStream = async () => {
      try {
        setStreamedSteps([]);
        setIsStreaming(true);
        setIsComplete(false);
        setError(null);

        const res = await fetch(`/api/research/${sessionId}/stream`, {
          signal: controller.signal
        });
        
        if (!res.ok) throw new Error(`Stream connection failed: ${res.statusText}`);
        if (!res.body) throw new Error("No readable stream available");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (mounted) {
          const { done, value } = await reader.read();
          if (done) {
            setIsStreaming(false);
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ""; // Keep the last incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (!dataStr) continue;
              
              if (dataStr === '[DONE]') {
                setIsComplete(true);
                setIsStreaming(false);
                continue;
              }
              
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.done) {
                  setIsComplete(true);
                  setIsStreaming(false);
                } else if (parsed.type) {
                  setStreamedSteps(prev => {
                    // Prevent exact duplicates if stream re-connects
                    const isDuplicate = prev.some(
                      s => s.type === parsed.type && 
                           s.timestamp === parsed.timestamp && 
                           s.content === parsed.content
                    );
                    if (isDuplicate) return prev;
                    return [...prev, parsed];
                  });
                }
              } catch (e) {
                console.error("Failed to parse SSE event chunk:", dataStr, e);
              }
            }
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError' && mounted) {
          setError(err.message || 'Stream unexpectedly closed');
          setIsStreaming(false);
        }
      }
    };

    startStream();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [sessionId, enabled]);

  return { streamedSteps, isStreaming, isComplete, error };
}
