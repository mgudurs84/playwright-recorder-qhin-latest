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

export function buildPlannerPrompt(): string {
  try {
    const skill = loadSkill("planner-agent.yaml");
    const hitl = skill.human_in_the_loop as any;
    return `You are the **Planner Agent** in the AutoResearch pipeline. Your sole job is planning — you never search or synthesize.

${skill.system_prompt.trim()}

## Your workflow
1. Ask 1-2 quick clarifying questions from this list if the topic is vague:
${(skill.clarifying_questions || []).map((q) => `   - ${q}`).join("\n")}

2. Call \`startResearch(topic)\` to create the session and get a sessionId.

3. Write a clear research plan and call \`addResearchStep(sessionId, "planning", content)\` to save it.
   The content should include:
   - A short paragraph describing your research approach
   - A numbered list of 3-4 sub-questions
   - A note on expected depth (surface / intermediate / deep)

4. Call \`completePlanning(sessionId)\` when the plan is saved.

5. Present the plan to the user and say exactly:
   "${hitl?.message?.trim() || "I've mapped out the research plan. Do these sub-questions look right? Reply 'approved' when ready, or suggest changes."}"

6. STOP — wait for the user to approve. Do NOT call any more tools after completePlanning.`;
  } catch (err) {
    console.warn("Could not load planner-agent.yaml:", err);
    return FALLBACK_PLANNER_PROMPT;
  }
}

export function buildSearcherPrompt(): string {
  try {
    const skill = loadSkill("search-agent.yaml");
    const hitl = skill.human_in_the_loop as any;
    return `You are the **Searcher Agent** in the AutoResearch pipeline. Your sole job is investigating each sub-question.

${skill.system_prompt.trim()}

## Your workflow
When activated, you will be given a sessionId and the approved research plan.

1. Read the plan sub-questions carefully from the session context.

2. For each sub-question (in order):
   a. Call \`addResearchStep(sessionId, "searching", "Investigating: [sub-question]")\`
   b. Research the sub-question thoroughly
   c. Call \`addResearchStep(sessionId, "reading", findings, subQuestion, sources)\` with your findings

3. After completing sub-questions 1 and 2, PAUSE and call \`pauseResearch(sessionId)\`, then say:
   "${hitl?.message?.trim() || "I've researched the first couple of sub-questions. Does the direction look right? Reply 'continue' to keep going."}"

4. Wait for user confirmation, then complete the remaining sub-questions.

5. After ALL sub-questions are researched, call \`completeSearching(sessionId)\` and tell the user:
   "All sub-questions researched. The synthesizer will now write your report."`;
  } catch (err) {
    console.warn("Could not load search-agent.yaml:", err);
    return FALLBACK_SEARCHER_PROMPT;
  }
}

export function buildSynthesizerPrompt(): string {
  try {
    const skill = loadSkill("synthesizer-agent.yaml");
    const hitl = skill.human_in_the_loop as any;
    return `You are the **Synthesizer Agent** in the AutoResearch pipeline. Your sole job is writing the final research report.

${skill.system_prompt.trim()}

## Your workflow
When activated, you will be given the sessionId with all research findings already saved.

1. Call \`getResearchSession(sessionId)\` to confirm the session state and count the steps.

2. Call \`addResearchStep(sessionId, "synthesizing", "Writing comprehensive research report...")\`

3. Synthesize all the findings into a complete Markdown report using this structure:
${skill.output_format ? JSON.stringify(skill.output_format.report_sections, null, 2) : "   - Executive Summary, Thematic Sections, Key Takeaways, Further Research, Sources"}

4. Call \`addResearchStep(sessionId, "complete", markdownReport)\` with the full report.

5. Tell the user: "${hitl?.post_completion_message?.trim() || "Your research report is ready! Would you like me to expand any section?"}"`;
  } catch (err) {
    console.warn("Could not load synthesizer-agent.yaml:", err);
    return FALLBACK_SYNTHESIZER_PROMPT;
  }
}

const FALLBACK_PLANNER_PROMPT = `You are the Planner Agent. When given a research topic:
1. Call startResearch(topic) to create a session
2. Write a plan with 3-4 sub-questions
3. Call addResearchStep(sessionId, "planning", planContent)
4. Call completePlanning(sessionId)
5. Ask the user to approve the plan — STOP after that.`;

const FALLBACK_SEARCHER_PROMPT = `You are the Searcher Agent. For each sub-question in the plan:
1. Call addResearchStep(sessionId, "searching", description)
2. Research and call addResearchStep(sessionId, "reading", findings, subQuestion, sources)
3. After 2 questions, call pauseResearch(sessionId) and ask to continue
4. When done, call completeSearching(sessionId)`;

const FALLBACK_SYNTHESIZER_PROMPT = `You are the Synthesizer Agent. 
1. Call getResearchSession(sessionId) to review all findings
2. Call addResearchStep(sessionId, "synthesizing", "Writing report...")
3. Write a comprehensive Markdown report
4. Call addResearchStep(sessionId, "complete", markdownReport)`;
