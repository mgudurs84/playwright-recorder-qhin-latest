import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const cwRunStepSchema = z.object({
  type: z.enum(["authenticating", "navigating", "extracting", "analyzing", "complete", "error"]),
  content: z.string(),
  screenshotUrl: z.string().optional(),
  timestamp: z.string(),
});

export type CwRunStep = z.infer<typeof cwRunStepSchema>;

export const cwTransactionRecordSchema = z.object({
  timestamp: z.string(),
  transactionId: z.string(),
  transactionType: z.string(),
  memberName: z.string(),
  initiatingOrgId: z.string(),
  duration: z.string(),
  status: z.string(),
});

export type CwTransactionRecord = z.infer<typeof cwTransactionRecordSchema>;

export const cwSessions = pgTable("cw_sessions", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  sessionData: jsonb("session_data").notNull(),
  savedAt: timestamp("saved_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const cwRuns = pgTable("cw_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  parameters: jsonb("parameters").notNull().default({}),
  recordCount: integer("record_count").default(0),
  errorCount: integer("error_count").default(0),
  records: jsonb("records").notNull().default([]),
  steps: jsonb("steps").notNull().default([]),
  screenshotUrls: jsonb("screenshot_urls").notNull().default([]),
  report: text("report"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertCwSessionSchema = createInsertSchema(cwSessions).omit({ savedAt: true });
export const insertCwRunSchema = createInsertSchema(cwRuns, {
  steps: z.array(cwRunStepSchema),
  records: z.array(cwTransactionRecordSchema),
  screenshotUrls: z.array(z.string()),
}).omit({ startedAt: true });

export type InsertCwSession = z.infer<typeof insertCwSessionSchema>;
export type InsertCwRun = z.infer<typeof insertCwRunSchema>;
export type CwSessionRow = typeof cwSessions.$inferSelect;
export type CwRunRow = typeof cwRuns.$inferSelect;
