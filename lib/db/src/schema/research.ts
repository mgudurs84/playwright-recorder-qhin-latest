import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const researchSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
});

export const researchStepSchema = z.object({
  type: z.enum(["planning", "searching", "reading", "synthesizing", "complete", "error"]),
  subQuestion: z.string().optional(),
  content: z.string(),
  sources: z.array(researchSourceSchema).optional(),
  timestamp: z.string(),
});

export type ResearchStep = z.infer<typeof researchStepSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchSessions = pgTable("research_sessions", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  status: text("status").notNull().default("pending"),
  report: text("report"),
  steps: jsonb("steps").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertResearchSessionSchema = createInsertSchema(researchSessions, {
  steps: z.array(researchStepSchema),
}).omit({ createdAt: true });

export type InsertResearchSession = z.infer<typeof insertResearchSessionSchema>;
export type ResearchSessionRow = typeof researchSessions.$inferSelect;
