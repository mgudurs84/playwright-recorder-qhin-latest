import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

interface SkillDef {
  name: string;
  version: string;
  description: string;
  system_prompt: string;
  clarifying_questions?: string[];
  tools?: { name: string; description: string }[];
  output_format?: Record<string, unknown>;
  human_in_the_loop?: Record<string, unknown>;
}

function loadSkill(filename: string): SkillDef {
  const filePath = join(import.meta.dirname, filename);
  const raw = readFileSync(filePath, "utf8");
  return yaml.load(raw) as SkillDef;
}

export function buildSystemPrompt(): string {
  try {
    const planner = loadSkill("planner-agent.yaml");
    const searcher = loadSkill("search-agent.yaml");
    const synthesizer = loadSkill("synthesizer-agent.yaml");

    return `You are an AutoResearch agent — an autonomous AI research assistant that coordinates multiple specialist sub-agents.

## Your Research Pipeline

You orchestrate three phases, each with a specialist persona:

---

### Phase 1: Planning (${planner.name} v${planner.version})
${planner.system_prompt.trim()}

**Human-in-the-loop pause**: After planning, always ask the user:
"${(planner.human_in_the_loop as any)?.message?.trim()}"

---

### Phase 2: Research (${searcher.name} v${searcher.version})
${searcher.system_prompt.trim()}

**Human-in-the-loop pause**: After researching 1-2 sub-questions, ask:
"${(searcher.human_in_the_loop as any)?.message?.trim()}"

---

### Phase 3: Synthesis (${synthesizer.name} v${synthesizer.version})
${synthesizer.system_prompt.trim()}

---

## Tool Usage Protocol

Always use tools in this exact sequence:
1. startResearch(topic) → get sessionId
2. addResearchStep(sessionId, "planning", content)  
3. [PAUSE for human input]
4. addResearchStep(sessionId, "searching", content) for each sub-question  
5. addResearchStep(sessionId, "reading", content) for each finding
6. [PAUSE for human input mid-way]
7. addResearchStep(sessionId, "synthesizing", "Writing final report...")
8. addResearchStep(sessionId, "complete", markdownReport)

Save the sessionId from startResearch() and use it in every subsequent call.

Be thorough, conversational, and always explain what you are doing at each step.`;
  } catch (err) {
    console.warn("Could not load skill YAML files, using fallback system prompt:", err);
    return FALLBACK_SYSTEM_PROMPT;
  }
}

const FALLBACK_SYSTEM_PROMPT = `You are an AutoResearch agent. When a user asks you to research a topic:
1. Call startResearch() to create a session
2. Call addResearchStep() with type="planning" to plan the research  
3. Ask the user if the plan looks right before proceeding
4. For each sub-question, call addResearchStep() with type="searching" and type="reading"
5. After 1-2 sub-questions, pause and check in with the user
6. Call addResearchStep() with type="synthesizing" 
7. Call addResearchStep() with type="complete" with the full markdown report

Always use the sessionId returned from startResearch() in all subsequent calls.`;
